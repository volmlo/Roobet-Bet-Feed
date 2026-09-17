/**
 * Прогрузы: несколько ставок на один матч за короткое окно. Когда на одно
 * событие приходит N и более одиночных ставок за WINDOW_MS — это сигнал.
 *
 * Считаем только одиночные: у экспресса плечо на матч — слабый признак, его
 * ставили ради связки, а не ради этого исхода. Дебаунс на событие не даёт
 * слать один и тот же прогруз при каждой новой ставке в продолжающемся потоке.
 *
 * Формат сигнала — по образцу Stake: хэштеги категории/лиги/команд, общий
 * объём, счётчик с таймингом, последняя ставка и все ставки, сгруппированные
 * по исходу с суммой по каждому.
 */

import type { Signal } from './signal.ts';
import { hashtag, hhmm } from './signal.ts';
import { SPORTS } from './labels.ts';
import { esc } from './telegram.ts';

interface Hit {
  at: number;
  usd: number;
  player: string;
  label: string;
  odds: number;
}

interface Bucket {
  home: string;
  away: string;
  category: string;
  tournament: string;
  sportId: string;
  live: boolean;
  hits: Hit[];
  lastEmit: number;
}

export interface ConsensusCfg {
  n: number;
  windowMs: number;
  retainMs: number;
  debounceMs: number;
  minUsd: number;
}

/** Сумма в долларах: целое без дробей, иначе две значащие («33832.75»). */
const money = (n: number): string => {
  const r = Math.round(n * 100) / 100;
  return Number.isInteger(r) ? String(r) : r.toFixed(2);
};

export class Consensus {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly cfg: ConsensusCfg) {}

  /** Регистрирует одиночную ставку. Возвращает текст сигнала, если сработал прогруз. */
  record(sig: Signal, now = Date.now()): string | null {
    if (sig.type !== 'single' || sig.usd < this.cfg.minUsd) return null;
    const l = sig.legs[0];
    if (!l?.home) return null;

    let b = this.buckets.get(sig.eventKey);
    if (!b) {
      b = {
        home: l.home,
        away: l.away,
        category: l.category,
        tournament: l.tournament,
        sportId: l.sportId,
        live: l.live,
        hits: [],
        lastEmit: 0,
      };
      this.buckets.set(sig.eventKey, b);
    }
    b.live = l.live; // статус матча мог обновиться (пре → лайв)
    b.hits.push({ at: now, usd: sig.usd, player: sig.player, label: l.label, odds: sig.odds });

    const fresh = b.hits.filter((h) => now - h.at <= this.cfg.windowMs);
    if (fresh.length < this.cfg.n) return null;
    if (now - b.lastEmit < this.cfg.debounceMs) return null;
    b.lastEmit = now;
    // показываем весь удержанный кластер, а не только окно — как накопленную картину
    const shown = b.hits.filter((h) => now - h.at <= this.cfg.retainMs);
    return this.format(b, shown, now);
  }

  private format(b: Bucket, hits: Hit[], now: number): string {
    const sport = SPORTS[b.sportId];
    const emoji = sport ? sport.emoji : '🎯';
    const total = hits.reduce((s, h) => s + h.usd, 0);
    const spanMin = Math.max(1, Math.round((now - Math.min(...hits.map((h) => h.at))) / 60_000));
    const last = hits.reduce((a, c) => (c.at > a.at ? c : a));

    // группировка по исходу: сумма и список ставок под каждым
    const groups = new Map<string, { sum: number; hits: Hit[] }>();
    for (const h of hits) {
      const g = groups.get(h.label) ?? { sum: 0, hits: [] };
      g.sum += h.usd;
      g.hits.push(h);
      groups.set(h.label, g);
    }
    const ordered = [...groups.entries()].sort((a, c) => c[1].sum - a[1].sum);

    const betRow = (h: Hit) => `- $${money(h.usd)} x ${h.odds.toFixed(2)} | ⏱️ ${hhmm(h.at)}`;
    const allBets = ordered.map(([label, g], i) => {
      const rows = g.hits
        .slice()
        .sort((a, c) => c.at - a.at)
        .map(betRow)
        .join('\n');
      return `${i + 1}. <b>${esc(label)}</b> | ${money(g.sum)}$\n${rows}`;
    });

    const line1 = [emoji, hashtag(b.category), hashtag(b.tournament)].filter(Boolean).join(' ');
    const line2 = `${hashtag(b.home)} - ${hashtag(b.away)}`;

    return [
      line1,
      line2,
      `💰  Volume: <b>${money(total)}$</b>`,
      `⚔️  Total: ${hits.length} bets / in ${spanMin} min${b.live ? ' · 🔴 LIVE' : ''}`,
      '',
      '⚔️ Last bet:',
      `<b>${esc(last.label)}</b>`,
      betRow(last).replace(/^- /, ''),
      '',
      '⚔️ All bets:',
      allBets.join('\n\n'),
    ].join('\n');
  }

  /** Чистка старых записей — вызывать периодически из основного цикла. */
  prune(now = Date.now()): void {
    for (const [key, b] of this.buckets) {
      b.hits = b.hits.filter((h) => now - h.at <= this.cfg.retainMs);
      if (b.hits.length === 0 && now - b.lastEmit > this.cfg.retainMs) this.buckets.delete(key);
    }
  }
}
