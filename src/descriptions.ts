/**
 * Названия рынков и исходов из официального словаря BetBy.
 *
 * Виджет сайта берёт их из descriptions-эндпоинта (apiVersion v3), а не из
 * фида котировок. Тот же словарь качаем и мы:
 *   GET /api/v3/descriptions/brand/{brand}/markets/{lang}
 * Формат: { market_id: { name, variants: { "": [{ outcomes: [{id, name}] }] },
 *           specifiers, market_type } }. В шаблонах имён — подстановки:
 *   {$competitor1}/{$competitor2} — команды,
 *   {total}, {gamenr}, ...        — значения спецификаторов,
 *   {!setnr}, {!quarternr}        — порядковые («2-й сет», «1-я четверть»),
 *   {+hcp}/{-hcp}                 — фора со знаком (для competitor2 — с обратным).
 *
 * Актуальный словарь тянется на старте с эндпоинта; если сеть недоступна —
 * берётся файл data/markets.ru.json, приложенный к проекту. Так парсер и
 * свежий, и работает офлайн.
 */

import { readFileSync } from 'node:fs';
import { fetch } from 'undici';
import { dispatcherFor } from './http.ts';
import { envInt } from './env.ts';

const HOST = 'https://api-g-c7818b61-607.sptpub.com';
const BRAND = '2186449803775455232';
const LANG = 'ru';
const TIMEOUT_MS = envInt('HTTP_TIMEOUT_MS', 20_000);
const { dispatcher, proxy: PROXY } = dispatcherFor('BETBY');

interface RawOutcome {
  id: string;
  name: string;
}
interface RawMarket {
  name?: string;
  variants?: Record<string, Array<{ outcomes?: RawOutcome[] }>>;
}
type Descriptions = Record<string, RawMarket>;

interface MarketIndex {
  name: string;
  outcomes: Map<string, string>;
}

let INDEX = new Map<string, MarketIndex>();

function buildIndex(d: Descriptions): number {
  const idx = new Map<string, MarketIndex>();
  for (const [mid, m] of Object.entries(d)) {
    const outcomes = new Map<string, string>();
    for (const variants of Object.values(m.variants ?? {})) {
      for (const v of variants) {
        for (const o of v.outcomes ?? []) {
          if (!outcomes.has(o.id)) outcomes.set(o.id, o.name);
        }
      }
    }
    idx.set(mid, { name: m.name ?? '', outcomes });
  }
  INDEX = idx;
  return idx.size;
}

/** Приложенный к проекту словарь — гарантированный офлайн-фолбэк. */
export function loadShipped(): number {
  const url = new URL('../data/markets.ru.json', import.meta.url);
  const d = JSON.parse(readFileSync(url, 'utf8')) as Descriptions;
  return buildIndex(d);
}

/** Свежий словарь с эндпоинта. false, если не удалось (останется прежний). */
export async function refreshFromApi(): Promise<boolean> {
  const url = `${HOST}/api/v3/descriptions/brand/${BRAND}/markets/${LANG}`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      dispatcher,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = (await res.json()) as Descriptions;
    const n = buildIndex(d);
    if (n === 0) throw new Error('пустой словарь');
    return true;
  } catch (e) {
    console.warn(
      `словарь рынков с API не получен${PROXY ? ` (через ${PROXY})` : ''}: ${(e as Error).message}`,
    );
    return false;
  }
}

const parseSpec = (spec: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const part of spec.split('|')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return out;
};

const ordinal = (n: string, fem: boolean) => `${n}-${fem ? 'я' : 'й'}`;
const g = (x: number) => (Number.isInteger(x) ? String(x) : String(x));
const signed = (v: string) => {
  const x = Number(v);
  return (x > 0 ? '+' : '') + g(x);
};
const negSigned = (v: string) => {
  const x = -Number(v);
  return (x > 0 ? '+' : '') + g(x);
};

/** Подстановка шаблонов имени рынка/исхода. */
function subst(tmpl: string, home: string, away: string, s: Record<string, string>): string {
  let t = tmpl.replace(/\{\$competitor1\}/g, home).replace(/\{\$competitor2\}/g, away);
  t = t.replace(/\{!(\w+)\}/g, (_, key: string) => ordinal(s[key] ?? '?', key.includes('quarter')));
  t = t.replace(/\{\+hcp\}/g, signed(s.hcp ?? '0')).replace(/\{-hcp\}/g, negSigned(s.hcp ?? '0'));
  t = t.replace(/\{(\w+)\}/g, (_, key: string) => s[key] ?? '?');
  return t;
}

/** Собрать «<рынок>: <исход>» из индекса. null, если рынка/исхода в нём нет. */
function fromIndex(
  idx: Map<string, MarketIndex>,
  marketId: string,
  outcomeId: string,
  s: Record<string, string>,
  home: string,
  away: string,
): string | null {
  const m = idx.get(marketId);
  const outName = m?.outcomes.get(outcomeId);
  if (!m || outName === undefined) return null;
  const market = subst(m.name, home, away, s);
  const outcome = subst(outName, home, away, s);
  return market ? `${market}: ${outcome}` : outcome;
}

/** Синхронная подпись из общего словаря (для decode и как быстрый путь). */
export function resolveLabel(
  marketId: string,
  outcomeId: string,
  spec: string,
  home: string,
  away: string,
): string {
  const s = parseSpec(spec);
  return fromIndex(INDEX, marketId, outcomeId, s, home, away) ?? `рынок ${marketId}·исход ${outcomeId}`;
}

// --- Описания на уровне события (для ставок на статистику игроков) ---
//
// Рынки вроде «Голы игрока» (PlayerProps) не имеют статических исходов в общем
// словаре: имя игрока и линия лежат в описании конкретного события. Их берём
// точечно и кешируем — таких ставок меньшинство, тянуть 280 КБ на каждую не нужно.

interface EventCacheEntry {
  at: number;
  idx: Map<string, MarketIndex>;
}
const EVENT_TTL_MS = 10 * 60 * 1000;
const EVENT_CACHE_CAP = 300;
const eventCache = new Map<string, EventCacheEntry>();

async function fetchEventIndex(eventId: string): Promise<Map<string, MarketIndex> | null> {
  const hit = eventCache.get(eventId);
  if (hit && Date.now() - hit.at < EVENT_TTL_MS) return hit.idx;
  const url = `${HOST}/api/v3/descriptions/brand/${BRAND}/event/${eventId}/${LANG}`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      dispatcher,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = (await res.json()) as { markets?: Descriptions };
    const idx = new Map<string, MarketIndex>();
    for (const [mid, m] of Object.entries(d.markets ?? {})) {
      const outcomes = new Map<string, string>();
      for (const variants of Object.values(m.variants ?? {})) {
        for (const v of variants) {
          for (const o of v.outcomes ?? []) if (!outcomes.has(o.id)) outcomes.set(o.id, o.name);
        }
      }
      idx.set(mid, { name: m.name ?? '', outcomes });
    }
    if (eventCache.size >= EVENT_CACHE_CAP) {
      const oldest = eventCache.keys().next().value;
      if (oldest !== undefined) eventCache.delete(oldest);
    }
    eventCache.set(eventId, { at: Date.now(), idx });
    return idx;
  } catch (e) {
    console.warn(`описание события ${eventId}: ${(e as Error).message}`);
    return null;
  }
}

/**
 * Подпись с фолбэком на описание события. Сначала общий словарь; если исход в
 * нём не найден (ставка на статистику игрока) — тянем описание события. Если и
 * там нет или сеть недоступна — хотя бы название рынка, иначе честная заглушка.
 */
export async function resolveLabelAsync(
  marketId: string,
  outcomeId: string,
  spec: string,
  home: string,
  away: string,
  eventId: string,
): Promise<string> {
  const s = parseSpec(spec);
  const global = fromIndex(INDEX, marketId, outcomeId, s, home, away);
  if (global) return global;

  if (eventId) {
    const idx = await fetchEventIndex(eventId);
    if (idx) {
      const ev = fromIndex(idx, marketId, outcomeId, s, home, away);
      if (ev) return ev;
    }
  }

  const gm = INDEX.get(marketId)?.name;
  return gm ? subst(gm, home, away, s) : `рынок ${marketId}·исход ${outcomeId}`;
}
