/**
 * Головной цикл headless-парсера ленты ставок Roobet (BetBy).
 *
 * Опрашивает bets_feed, резолвит события по снапшотам котировок, восстанавливает
 * читаемые исходы и раскладывает ставки по трём каналам:
 *   основной          — ставки от MAIN_MIN_USD и коэффициента MAIN_MIN_ODD;
 *   настольный теннис  — свои пороги TT_MIN_*; такие ставки идут И в свой канал,
 *                        И в основной (если проходят его пороги независимо);
 *   прогрузы           — N+ одиночных ставок на один матч за окно.
 * Кибер/виртуальные события отсекаются по флагу desc.virtual.
 *
 * Браузер не нужен: ни Chromium, ни Tampermonkey. Живёт под pm2.
 */

import { fetchBets } from './betsfeed.ts';
import { Snapshots } from './snapshot.ts';
import { classify, formatSignal, type Signal } from './signal.ts';
import { Consensus } from './consensus.ts';
import { loadConfig, type Config } from './config.ts';
import { isTargetSport } from './labels.ts';
import { loadShipped, refreshFromApi } from './descriptions.ts';
import * as tg from './telegram.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Разворачивает cause-цепочку undici: голое «fetch failed» бесполезно. */
function explain(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur instanceof Error; i++) {
    const code = (cur as NodeJS.ErrnoException).code;
    parts.push(code ? `${cur.message} [${code}]` : cur.message);
    cur = (cur as { cause?: unknown }).cause;
  }
  return parts.join(' ← ');
}

/** Ограниченный по размеру журнал уже обработанных id (защита от повторов). */
class Seen {
  private readonly set = new Set<string>();
  private readonly queue: string[] = [];
  constructor(private readonly cap = 5000) {}
  has(id: string): boolean {
    return this.set.has(id);
  }
  add(id: string): void {
    if (this.set.has(id)) return;
    this.set.add(id);
    this.queue.push(id);
    if (this.queue.length > this.cap) {
      const old = this.queue.shift();
      if (old !== undefined) this.set.delete(old);
    }
  }
}

/** Совпадает ли хоть одно плечо ставки с чёрными списками команд/турниров. */
function matchesBlacklist(sig: Signal, teams: string[], tournaments: string[]): boolean {
  if (teams.length === 0 && tournaments.length === 0) return false;
  for (const l of sig.legs) {
    const pair = `${l.home} ${l.away}`.toLowerCase();
    if (teams.some((b) => pair.includes(b))) return true;
    const tour = l.tournament.toLowerCase();
    if (tournaments.some((b) => tour.includes(b))) return true;
  }
  return false;
}

async function route(sig: Signal, cfg: Config, consensus: Consensus): Promise<void> {
  // только целевые виды спорта; экспресс — по основному виду большинства плеч
  if (!isTargetSport(sig.primarySport)) return;
  if (cfg.excludeCyber && sig.virtual) return;
  // глобальный чёрный список — исключает матч из всех каналов
  if (matchesBlacklist(sig, cfg.teamBlacklist, cfg.tournamentBlacklist)) return;

  const isTT = sig.primarySport === '20';
  const mainOk = sig.usd >= cfg.mainMinUsd && sig.odds >= cfg.mainMinOdd;
  const ttOk = isTT && sig.usd >= cfg.ttMinUsd && sig.odds >= cfg.ttMinOdd;

  if (mainOk || ttOk) {
    const text = formatSignal(sig);
    if (mainOk && cfg.mainChatId) await tg.send(cfg.mainChatId, text);
    if (ttOk && cfg.ttChatId) await tg.send(cfg.ttChatId, text);
  }

  // прогруз считается независимо от порогов основного канала, но со своим
  // доп. фильтром — так топ-лиги убираются только отсюда, не задевая основной канал
  if (!matchesBlacklist(sig, cfg.consensusTeamBlacklist, cfg.consensusTournamentBlacklist)) {
    const progruz = consensus.record(sig);
    if (progruz && cfg.consensusChatId) await tg.send(cfg.consensusChatId, progruz);
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (!tg.configured()) {
    console.error('TELEGRAM_BOT_TOKEN не задан в .env — выходим');
    process.exit(1);
  }
  if (!cfg.mainChatId && !cfg.ttChatId && !cfg.consensusChatId) {
    console.error('не задан ни один *_CHAT_ID — выходим');
    process.exit(1);
  }

  const snaps = new Snapshots();
  const consensus = new Consensus(cfg.consensus);
  const seen = new Seen();

  // словарь названий рынков: приложенный как база, свежий с API — если доступен
  console.log(`словарь рынков: ${loadShipped()} (приложенный)`);
  if (await refreshFromApi()) console.log('словарь рынков обновлён с API');

  console.log('загружаю снапшоты котировок BetBy…');
  await snaps.bootstrap();
  console.log('снапшоты готовы');

  // Прайминг: помечаем текущую ленту как виденную, чтобы не выстрелить историей.
  try {
    const initial = await fetchBets();
    for (const b of initial) seen.add(b.id);
    console.log(`прайминг: ${initial.length} ставок помечены как старые`);
  } catch (e) {
    console.warn(`прайминг не удался (${explain(e)}) — продолжаю`);
  }

  console.log(
    `слежу за лентой. пороги: осн ${cfg.mainMinUsd}$/${cfg.mainMinOdd}, НТ ${cfg.ttMinUsd}$/${cfg.ttMinOdd}; ` +
      `прогруз ${cfg.consensus.n} за ${cfg.consensus.windowMs / 1000}с; ` +
      `сторож ${cfg.stallAlertMs / 60000} мин${cfg.alertChatId ? ' → алерты в чат' : ' (только лог)'}`,
  );

  // Тревога уходит в чат, если задан ALERT_CHAT_ID, иначе — в лог. Через прокси,
  // как и всё остальное: если упал сам прокси, чат может не достучаться — тогда
  // остаётся хотя бы запись в логе pm2.
  async function alert(text: string): Promise<void> {
    if (cfg.alertChatId) await tg.send(cfg.alertChatId, text);
    else console.warn(`[alert] ${text.replace(/<[^>]+>/g, '')}`);
  }

  // Сторож тишины: лента ставок BetBy идёт постоянно по всем видам спорта, так
  // что отсутствие новых ставок несколько минут — это завис фид/прокси, а не
  // затишье. Считаем «живой» по появлению новых id, независимо от фильтров.
  let lastAliveAt = Date.now();
  let stalled = false;

  let fails = 0;
  for (;;) {
    try {
      await snaps.refresh();
      const bets = await fetchBets();
      let newCount = 0;
      // от старых к новым, чтобы порядок сообщений совпадал с порядком ставок
      for (let i = bets.length - 1; i >= 0; i--) {
        const b = bets[i];
        if (!b || seen.has(b.id)) continue;
        seen.add(b.id);
        newCount++;
        await route(await classify(b, snaps), cfg, consensus);
      }
      consensus.prune();
      fails = 0;

      if (newCount > 0) {
        lastAliveAt = Date.now();
        if (stalled) {
          stalled = false;
          await alert('✅ Roobet-парсер: лента снова идёт.');
        }
      }
    } catch (e) {
      fails++;
      console.warn(`цикл ${fails}: ${explain(e)}`);
      // бэкофф при затяжном сбое, но без остановки наблюдения
      if (fails > 3) await sleep(Math.min(30_000, cfg.refreshMs * fails));
    }

    // проверка сторожа — вне try/catch: срабатывает и когда падают сами запросы
    if (!stalled && Date.now() - lastAliveAt > cfg.stallAlertMs) {
      stalled = true;
      const mins = Math.round((Date.now() - lastAliveAt) / 60_000);
      await alert(`⚠️ Roobet-парсер: нет новых ставок ${mins} мин — возможно, завис фид или прокси.`);
    }

    await sleep(cfg.refreshMs);
  }
}

main().catch((e) => {
  console.error(`фатально: ${explain(e)}`);
  process.exit(1);
});
