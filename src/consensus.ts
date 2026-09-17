/**
 * Прогрузы: несколько ставок на один матч за короткое окно. Когда на одно
 * событие приходит N и более одиночных ставок за WINDOW_MS — это сигнал.
 *
 * Считаем только одиночные: у экспресса плечо на матч — слабый признак, его
 * ставили ради связки, а не ради этого исхода. Дебаунс на событие не даёт
 * слать один и тот же прогруз при каждой новой ставке в продолжающемся потоке.
 */

import type { Signal } from './signal.ts';
import { statusLine } from './signal.ts';
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
  tournament: string;
  sportId: string;
  live: boolean;
  scheduled: number;
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
        tournament: l.tournament,
        sportId: l.sportId,
        live: l.live,
        scheduled: l.scheduled,
        hits: [],
        lastEmit: 0,
      };
      this.buckets.set(sig.eventKey, b);
    }
    // статус матча мог обновиться (пре → лайв) — держим свежим
    b.live = l.live;
    b.scheduled = l.scheduled;
    b.hits.push({ at: now, usd: sig.usd, player: sig.player, label: l.label, odds: sig.odds });

    const fresh = b.hits.filter((h) => now - h.at <= this.cfg.windowMs);
    if (fresh.length < this.cfg.n) return null;
    if (now - b.lastEmit < this.cfg.debounceMs) return null;
    b.lastEmit = now;
    return this.format(b, fresh, now);
  }

  private format(b: Bucket, fresh: Hit[], now: number): string {
    const sport = SPORTS[b.sportId];
    const emoji = sport ? sport.emoji : '🎯';
    const spanSec = Math.round((now - Math.min(...fresh.map((h) => h.at))) / 1000);
    const total = fresh.reduce((s, h) => s + h.usd, 0);
    const head = `🔥 <b>ПРОГРУЗ</b> · ${emoji} ${esc(b.home)} — ${esc(b.away)}`;
    const rows = fresh
      .slice()
      .sort((a, c) => c.usd - a.usd)
      .map(
        (h) =>
          `• <b>${esc(h.label)}</b> — $${Math.round(h.usd).toLocaleString('en-US').replace(/,/g, ' ')} кф ${h.odds.toFixed(2)} · ${esc(h.player)}`,
      );
    return [
      head,
      b.tournament ? `🏆 ${esc(b.tournament)}` : '',
      statusLine(b.live, b.scheduled),
      `${fresh.length} ставки за ${spanSec} c · сумма $${Math.round(total).toLocaleString('en-US').replace(/,/g, ' ')}`,
      '',
      ...rows,
    ]
      .filter(Boolean)
      .join('\n');
  }

  /** Чистка старых записей — вызывать периодически из основного цикла. */
  prune(now = Date.now()): void {
    for (const [key, b] of this.buckets) {
      b.hits = b.hits.filter((h) => now - h.at <= this.cfg.retainMs);
      if (b.hits.length === 0 && now - b.lastEmit > this.cfg.retainMs) this.buckets.delete(key);
    }
  }
}
