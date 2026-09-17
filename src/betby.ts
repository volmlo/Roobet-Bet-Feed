/**
 * Адаптер фида BetBy (спортсбук Roobet — white-label BetBy на sptpub.com).
 *
 * Авторизации нет: ни куки, ни токена, CORS открыт. Playwright не нужен.
 *
 * Протокол:
 *   GET .../{lang}/0          → индекс: version + top_events_versions[] + rest_events_versions[]
 *   GET .../{lang}/{version}  → содержимое шарда по этому адресу
 * Последний шард приходит с snapshot_complete = true.
 *
 * Инкрементальных дельт НЕТ, вопреки первому впечатлению. Проверено: запрос
 * версии, которая уже устарела, возвращает не изменения, а пустой ответ с
 * version: 0. Версии — это адреса снапшотов, а не курсоры. Поэтому каждый
 * цикл перечитывает все шарды целиком и состояние заменяется, а не патчится:
 * иначе снятые с линии события оставались бы в памяти навсегда.
 * null вместо объекта внутри шарда всё равно означает удаление.
 * Смена epoch = полный ресинк.
 *
 * Prematch пересобирается на origin ровно раз в 60 секунд, поэтому опрашивать
 * чаще бессмысленно — новых котировок там просто нет. Query-параметры добавлять
 * нельзя, CloudFront отвечает ошибкой.
 */

// fetch из undici, а не глобальный: см. пояснение в pinnacle.ts — загрузка
// пакета undici ломает распаковку gzip у встроенного fetch.
import { fetch } from 'undici';
import { envInt } from './env.ts';
import { dispatcherFor } from './http.ts';

const HOST = 'https://api-g-c7818b61-607.sptpub.com';
const TIMEOUT_MS = envInt('HTTP_TIMEOUT_MS', 20_000);
/** 1 = последовательно; поднимать только если канал широкий и упирается в задержку */
const SHARD_CONCURRENCY = envInt('BETBY_SHARD_CONCURRENCY', 1);

/**
 * По умолчанию BetBy ходит напрямую — он не блокируется по имени домена,
 * в отличие от Pinnacle. Но на некоторых каналах короткие ответы проходят,
 * а крупные шарды по сотне килобайт душатся на объёме: рукопожатие и индекс
 * в 2 КБ отвечают за десятые доли секунды, а шард не докачивается и за 45.
 * Тогда помогает тот же туннель, что и для Pinnacle.
 */
const { dispatcher, proxy: PROXY } = dispatcherFor('BETBY');
const BRAND = '2186449803775455232';

export type Feed = 'prematch' | 'live';

export interface Outcome {
  /** десятичный коэффициент; приходит строкой, поэтому парсим явно */
  k: string;
  /** b:1 вместе с k:"0.0" означает заблокированный исход */
  b?: number;
}

export interface EventDesc {
  scheduled: number; // unix seconds
  type: string;
  virtual?: boolean;
  sport: string;
  category: string;
  tournament: string;
  competitors: Array<{ id: string; name: string }>; // [home, away]
}

export interface BetbyEvent {
  desc?: EventDesc;
  state?: { provider: string; status: number; match_status: number };
  /** market_id → specifier → outcome_id → Outcome */
  markets?: Record<string, Record<string, Record<string, Outcome> | null> | null>;
}

export interface Snapshot {
  epoch: number;
  version: number;
  events: Record<string, BetbyEvent>;
  sports: Record<string, { name: string; slug: string }>;
  categories: Record<string, { sport_id: string; name: string }>;
  tournaments: Record<string, { category_id: string; name: string }>;
}

interface RawChunk {
  epoch: number;
  version: number;
  snapshot_complete?: boolean;
  fixtures_complete?: boolean;
  top_events_versions?: number[];
  rest_events_versions?: number[];
  events?: Record<string, BetbyEvent | null>;
  sports?: Record<string, any>;
  categories?: Record<string, any>;
  tournaments?: Record<string, any>;
}

async function fetchChunk(feed: Feed, lang: string, version: number | 0): Promise<RawChunk> {
  const url = `${HOST}/api/v4/${feed}/brand/${BRAND}/${lang}/${version}`;
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      dispatcher,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(
      `BetBy ${feed}/${version} недоступен${PROXY ? ` (через прокси ${PROXY})` : ' (напрямую)'}`,
      { cause: e },
    );
  }
  if (!res.ok) throw new Error(`BetBy ${feed}/${version}: HTTP ${res.status}`);
  return (await res.json()) as RawChunk;
}

function empty(epoch: number, version: number): Snapshot {
  return { epoch, version, events: {}, sports: {}, categories: {}, tournaments: {} };
}

/**
 * Применяет патч поверх состояния. Одна и та же логика годится и для bootstrap-а,
 * и для дельт: null удаляет, объект дописывается поверх.
 */
function apply(state: Snapshot, chunk: RawChunk): void {
  for (const [id, ev] of Object.entries(chunk.events ?? {})) {
    if (ev === null) {
      delete state.events[id];
      continue;
    }
    const prev = state.events[id] ?? {};
    const markets = { ...(prev.markets ?? {}) };
    for (const [mid, specs] of Object.entries(ev.markets ?? {})) {
      if (specs === null) {
        delete markets[mid];
        continue;
      }
      const merged = { ...(markets[mid] ?? {}) };
      for (const [spec, outs] of Object.entries(specs)) {
        if (outs === null) delete merged[spec];
        else merged[spec] = { ...(merged[spec] ?? {}), ...outs };
      }
      markets[mid] = merged;
    }
    state.events[id] = {
      desc: ev.desc ?? prev.desc,
      state: ev.state ?? prev.state,
      markets,
    };
  }
  Object.assign(state.sports, chunk.sports ?? {});
  Object.assign(state.categories, chunk.categories ?? {});
  Object.assign(state.tournaments, chunk.tournaments ?? {});
  state.version = chunk.version;
}

export class BetbyClient {
  private state: Snapshot | null = null;
  /** сколько событий было в последнем заведомо здоровом снапшоте */
  private lastGoodCount = 0;

  constructor(
    private readonly feed: Feed = 'prematch',
    /** en, а не ru: русская локаль отдаёт кириллические имена, по которым
     *  не сопоставить события с латиницей Pinnacle */
    private readonly lang: string = 'en',
  ) {}

  /**
   * Полный снапшот с повтором. Индекс и шарды читаются не атомарно, поэтому
   * если версия успела смениться между этими запросами, шард отвечает
   * version: 0 и снапшот собрать нельзя.
   *
   * Главная причина не в гонке при пересборке, как кажется сначала, а в кеше
   * CloudFront: индекс отдаётся с max-age=60, и если попался закешированный
   * экземпляр, адреса шардов в нём уже мертвы. Повторы внутри этой минуты
   * бесполезны — индекс вернёт ровно те же протухшие адреса. Признак именно
   * такого случая: номер шарда в ошибке не меняется от попытки к попытке.
   *
   * Поэтому паузы подобраны так, чтобы суммарно перекрыть время жизни кеша
   * индекса: 1 + 5 + 15 + 30 + 45 = 96 секунд.
   */
  async bootstrap(attempts = 6): Promise<Snapshot> {
    const backoffSec = [1, 5, 15, 30, 45];
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await this.bootstrapOnce();
      } catch (e) {
        last = e;
        const wait = backoffSec[i];
        if (wait === undefined) break;
        console.warn(`BetBy: попытка ${i + 1} не удалась, жду ${wait} с (${(e as Error).message})`);
        await new Promise((r) => setTimeout(r, wait * 1000));
      }
    }
    throw last;
  }

  private async bootstrapOnce(): Promise<Snapshot> {
    const index = await fetchChunk(this.feed, this.lang, 0);
    const shards = [
      ...(index.top_events_versions ?? []),
      ...(index.rest_events_versions ?? []),
    ];
    if (shards.length === 0) throw new Error('BetBy: индекс не отдал версии шардов');

    // Шарды по умолчанию читаются ПОСЛЕДОВАТЕЛЬНО. Соблазн тянуть их разом
    // велик — они независимы, — но каждый весит сотни килобайт против двух у
    // индекса. На узком канале параллельные загрузки делят ту же полосу, общее
    // время не падает, зато каждая рискует упереться в таймаут и уронить весь
    // bootstrap. Параллелизм помогает только когда узкое место — задержка,
    // а не полоса; на Raspberry по Wi-Fi это не так.
    const chunks: RawChunk[] = [];
    if (SHARD_CONCURRENCY <= 1) {
      for (const v of shards) chunks.push(await fetchChunk(this.feed, this.lang, v));
    } else {
      for (let i = 0; i < shards.length; i += SHARD_CONCURRENCY) {
        const batch = shards.slice(i, i + SHARD_CONCURRENCY);
        chunks.push(...(await Promise.all(batch.map((v) => fetchChunk(this.feed, this.lang, v)))));
      }
    }

    const state = empty(index.epoch, index.version);
    let complete = false;
    for (const chunk of chunks) {
      apply(state, chunk);
      if (chunk.snapshot_complete) complete = true;
    }
    state.version = index.version;

    const count = Object.keys(state.events).length;

    // Признак полноты у BetBy — snapshot_complete, а не version шарда.
    // Раннее правило «version: 0 значит адрес протух» оказалось неверным:
    // встречается шард с нулевой версией и содержимым. Поэтому нулевая версия
    // больше ничего не решает, а решает объём и флаг полноты.
    // snapshot_complete — единственный признак того, что шарды собраны все.
    // Раньше здесь было предупреждение, и неполный снапшот шёл в работу: число
    // событий скакало между 450 и 1326, пары то исчезали, то возвращались, а
    // сборщик записывал им выдуманное время жизни. Теперь это отказ цикла,
    // и bootstrap просто повторяет попытку.
    if (!complete) {
      throw new Error(`BetBy: снапшот неполный — ${count} событий, нет snapshot_complete`);
    }

    // Защита от обвала фида на стороне BetBy. Наблюдалось: прематч-фид
    // отдавал один шард и одно событие вместо пяти и тысячи семисот, версия
    // не двигалась двадцать минут, при этом live работал нормально.
    //
    // Принять такой снапшот опаснее, чем пропустить цикл: сборщик пометил бы
    // все активные пары как закрытые, записал им фиктивное время жизни, а
    // после починки фида открыл заново. Это испортило бы ровно ту метрику,
    // ради которой идёт наблюдение.
    if (this.lastGoodCount > 0 && count < this.lastGoodCount * 0.6) {
      throw new Error(
        `BetBy отдал ${count} событий вместо ${this.lastGoodCount} — похоже на сбой фида, ` +
          `цикл пропущен`,
      );
    }

    this.state = state;
    if (count > this.lastGoodCount) this.lastGoodCount = count;
    return state;
  }

  /**
   * Перечитывает состояние целиком, если версия сдвинулась. Возвращает null,
   * когда сдвига нет: prematch пересобирается раз в 60 секунд, поэтому при
   * более частом опросе это самый обычный ответ.
   */
  async poll(): Promise<Snapshot | null> {
    if (!this.state) return this.bootstrap();

    const index = await fetchChunk(this.feed, this.lang, 0);
    if (index.epoch !== this.state.epoch) {
      this.state = null;
      return this.bootstrap();
    }
    if (index.version === this.state.version) return null;

    // Состояние заменяется, а не патчится: дельт нет, и без замены снятые
    // с линии события копились бы вечно.
    this.state = null;
    return this.bootstrap();
  }
}

/** Десятичный коэффициент или null, если исход заблокирован. */
export function odds(o: Outcome | undefined): number | null {
  if (!o || o.b) return null;
  const v = Number(o.k);
  return Number.isFinite(v) && v > 1 ? v : null;
}

/**
 * Карта рынков UOF, снятая с живого футбольного фида Roobet.
 * В прематче доступны только эти — азиатской форы у Roobet нет вообще.
 */
export const UOF = {
  MATCH_1X2: '1',
  DOUBLE_CHANCE: '10', // исходы: 9 = 1X, 10 = 12, 11 = X2
  TOTAL: '18', // исходы: 12 = over, 13 = under
  BTTS: '29', // исходы: 74 = yes, 76 = no
  H1_1X2: '60',
  H1_TOTAL: '68',
  /** победитель матча в видах спорта без ничьей: теннис, ММА, бокс */
  WINNER_2WAY: '186',
} as const;

export const OUT = {
  HOME: '1',
  DRAW: '2',
  AWAY: '3',
  OVER: '12',
  UNDER: '13',
  DC_HOME_DRAW: '9',
  DC_HOME_AWAY: '10',
  DC_DRAW_AWAY: '11',
  BTTS_YES: '74',
  BTTS_NO: '76',
  // Нумерация исходов в UOF своя у каждого рынка: в 1X2 это 1/2/3,
  // а в двухисходном победителе — 4/5. Проверено сверкой с Pinnacle
  // на 26 теннисных матчах: 26/26 совпало.
  WIN_HOME: '4',
  WIN_AWAY: '5',
} as const;
