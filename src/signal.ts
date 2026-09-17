/**
 * Превращение сырой ставки в классифицированный сигнал и его вёрстка в HTML
 * для Telegram. Здесь же — определение «основного» вида спорта ставки и
 * флага virtual, по которым сборщик решает, слать ли её и в какой канал.
 */

import type { Bet } from './betsfeed.ts';
import type { Snapshots } from './snapshot.ts';
import { stakeUsd, SPORTS } from './labels.ts';
import { resolveLabelAsync } from './descriptions.ts';
import { esc } from './telegram.ts';

export interface Leg {
  sportId: string;
  home: string;
  away: string;
  tournament: string;
  label: string;
  k: string;
  live: boolean;
  scheduled: number;
}

export interface Signal {
  id: string;
  type: 'single' | 'combo';
  usd: number;
  odds: number;
  player: string;
  legs: Leg[];
  /** id вида спорта у большинства распознанных плеч; '' если ни одно не распозналось */
  primarySport: string;
  /** хотя бы одно плечо — virtual/кибер */
  virtual: boolean;
  /** ключ основного события (для группировки прогрузов у одиночных) */
  eventKey: string;
}

/** Раскладывает ставку по снапшотам. Нераспознанные плечи остаются с id вместо имён. */
export async function classify(bet: Bet, snaps: Snapshots): Promise<Signal> {
  const legs: Leg[] = [];
  const sportTally = new Map<string, number>();
  let virtual = false;
  let eventKey = bet.selections[0]?.event_id ?? bet.id;

  for (const sel of bet.selections) {
    const ev = snaps.resolve(sel.event_id);
    // имена команд нужны для подстановки в шаблоны исходов ({$competitor1} и т.п.)
    const home = ev?.home ?? 'П1';
    const away = ev?.away ?? 'П2';
    const label = await resolveLabelAsync(
      sel.market_id,
      sel.outcome_id,
      sel.specifiers,
      home,
      away,
      sel.event_id,
    );
    if (ev) {
      if (ev.virtual) virtual = true;
      sportTally.set(ev.sportId, (sportTally.get(ev.sportId) ?? 0) + 1);
      legs.push({
        sportId: ev.sportId,
        home: ev.home,
        away: ev.away,
        tournament: ev.tournament,
        label,
        k: sel.k,
        live: ev.live,
        scheduled: ev.scheduled,
      });
    } else {
      legs.push({
        sportId: '',
        home: '',
        away: '',
        tournament: '',
        label,
        k: sel.k,
        live: false,
        scheduled: 0,
      });
    }
  }

  let primarySport = '';
  let best = 0;
  for (const [sid, n] of sportTally) {
    if (n > best) {
      best = n;
      primarySport = sid;
    }
  }

  return {
    id: bet.id,
    type: bet.type,
    usd: stakeUsd(bet.stake),
    odds: Number(bet.odds),
    player: bet.player,
    legs,
    primarySport,
    virtual,
    eventKey,
  };
}

const fmtUsd = (u: number) =>
  '$' + Math.round(u).toLocaleString('en-US').replace(/,/g, ' ');

const fmtOdds = (o: number) => (Number.isFinite(o) ? o.toFixed(2) : '?');

const mskYmd = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Moscow',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const mskHm = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  hour: '2-digit',
  minute: '2-digit',
});
const mskDay = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  day: '2-digit',
  month: 'short',
});

/** Время старта по Москве: «сегодня 21:30 МСК», «завтра …», иначе «17 сен …». */
function fmtStart(scheduled: number): string {
  const d = new Date(scheduled * 1000);
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 86_400_000);
  const day =
    mskYmd.format(d) === mskYmd.format(now)
      ? 'сегодня'
      : mskYmd.format(d) === mskYmd.format(tomorrow)
        ? 'завтра'
        : mskDay.format(d);
  return `${day} ${mskHm.format(d)} МСК`;
}

/** Строка статуса матча: 🔴 LIVE или время начала. Пусто, если ничего не известно. */
export function statusLine(live: boolean, scheduled: number): string {
  if (live) return '🔴 LIVE';
  if (scheduled > 0) return `🕐 ${fmtStart(scheduled)}`;
  return '';
}

/** Турнир → хэштег: буквы/цифры склеиваем, остальное отбрасываем. */
function tag(s: string): string {
  const t = s.replace(/[^\p{L}\p{N}]+/gu, '');
  return t ? `#${t}` : '';
}

function matchLine(l: Leg): string {
  if (!l.home) return '❓ матч не в снапшоте';
  return `${esc(l.home)} — ${esc(l.away)}`;
}

/** Одиночная ставка. */
function formatSingle(sig: Signal): string {
  const l = sig.legs[0];
  if (!l) return `💰 <b>${fmtUsd(sig.usd)}</b> · кф <b>${fmtOdds(sig.odds)}</b> · 👤 ${esc(sig.player)}`;
  const sport = SPORTS[l.sportId];
  const head = sport ? `${sport.emoji} <b>${sport.name}</b>` : '🎯 <b>Ставка</b>';
  const lines = [
    head,
    matchLine(l),
    l.tournament ? `🏆 ${esc(l.tournament)}` : '',
    statusLine(l.live, l.scheduled),
    `▶️ <b>${esc(l.label)}</b> · кф <b>${fmtOdds(sig.odds)}</b>`,
    `💰 <b>${fmtUsd(sig.usd)}</b> · 👤 ${esc(sig.player)}`,
    l.tournament ? tag(l.tournament) : '',
  ];
  return lines.filter(Boolean).join('\n');
}

/** Экспресс: показываем все плечи с их исходами и коэффициентами. */
function formatCombo(sig: Signal): string {
  const sport = SPORTS[sig.primarySport];
  const emoji = sport ? sport.emoji : '🎯';
  const head = `${emoji} <b>ЭКСПРЕСС</b> · ${sig.legs.length} соб. · кф <b>${fmtOdds(sig.odds)}</b>`;
  const legLines = sig.legs.map(
    (l) => `• ${l.live ? '🔴 ' : ''}${matchLine(l)}: <b>${esc(l.label)}</b> <i>(${esc(l.k)})</i>`,
  );
  return [head, `💰 <b>${fmtUsd(sig.usd)}</b> · 👤 ${esc(sig.player)}`, '', ...legLines].join('\n');
}

export function formatSignal(sig: Signal): string {
  return sig.type === 'combo' ? formatCombo(sig) : formatSingle(sig);
}
