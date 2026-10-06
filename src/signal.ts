/**
 * Превращение сырой ставки в классифицированный сигнал и его вёрстка в HTML
 * для Telegram. Здесь же — определение «основного» вида спорта ставки и
 * флага virtual, по которым сборщик решает, слать ли её и в какой канал.
 */

import type { Bet } from './betsfeed.ts';
import type { Snapshots } from './snapshot.ts';
import { SPORTS } from './labels.ts';
import { stakeUsd } from './fx.ts';
import { resolveLabelAsync } from './descriptions.ts';
import { esc } from './telegram.ts';

export interface Leg {
  sportId: string;
  home: string;
  away: string;
  category: string;
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
        category: ev.category,
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
        category: '',
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

/**
 * Сумма в долларах в стиле Stake: целое без дробей, иначе две значащие.
 * Единый формат для всех каналов (одиночные, экспресс, прогрузы).
 */
export const money = (n: number): string => {
  const r = Math.round(n * 100) / 100;
  return Number.isInteger(r) ? String(r) : r.toFixed(2);
};

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

/** Текст → хэштег: пробелы/пунктуация → «_», напр. «Uefa Europa League» → #Uefa_Europa_League. */
export function hashtag(s: string): string {
  const t = s.replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '');
  return t ? `#${t}` : '';
}

/** Время (мс) → «21:39» по Москве. */
export const hhmm = (ms: number): string => mskHm.format(new Date(ms));

/** Пара команд хэштегами: «#Home - #Away» или заглушка, если матч не в снапшоте. */
function teamsLine(l: Leg): string {
  if (!l.home) return '❓ матч не в снапшоте';
  return `${hashtag(l.home)} - ${hashtag(l.away)}`;
}

/**
 * Одиночная ставка — в стиле Stake, как прогрузы:
 *   {emoji} #Категория #Турнир
 *   #Home - #Away
 *   <b>исход</b>
 *   💰 $сумма x кф · 🔴 LIVE | 👤 игрок
 */
function formatSingle(sig: Signal, player: string): string {
  const l = sig.legs[0];
  if (!l)
    return `💰 $${money(sig.usd)} x ${fmtOdds(sig.odds)} | 👤 ${esc(player)}`;
  const sport = SPORTS[l.sportId];
  const emoji = sport ? sport.emoji : '🎯';
  const status = statusLine(l.live, l.scheduled); // 🔴 LIVE | 🕐 время | ''
  const lines = [
    [emoji, hashtag(l.category), hashtag(l.tournament)].filter(Boolean).join(' '),
    teamsLine(l),
    `<b>${esc(l.label)}</b>`,
    `💰 $${money(sig.usd)} x ${fmtOdds(sig.odds)}${status ? ` · ${status}` : ''} | 👤 ${esc(player)}`,
  ];
  return lines.filter(Boolean).join('\n');
}

/** Экспресс — тот же стиль: шапка со ставкой, затем плечи хэштегами. */
function formatCombo(sig: Signal, player: string): string {
  const sport = SPORTS[sig.primarySport];
  const emoji = sport ? sport.emoji : '🎯';
  const head = `${emoji} <b>ЭКСПРЕСС</b> · ${sig.legs.length} соб. · кф <b>${fmtOdds(sig.odds)}</b>`;
  const legLines = sig.legs.map(
    (l, i) =>
      `${i + 1}. ${teamsLine(l)}${l.live ? ' 🔴' : ''}\n<b>${esc(l.label)}</b> <i>(${esc(l.k)})</i>`,
  );
  return [head, `💰 $${money(sig.usd)} · 👤 ${esc(player)}`, '', ...legLines].join('\n');
}

/**
 * Вёрстка сигнала. playerOverride — готовая строка игрока для показа (напр. в канале
 * помеченных: «Бутерброд (****112)»); по умолчанию — маскированное имя из ленты.
 */
export function formatSignal(sig: Signal, playerOverride?: string): string {
  const player = playerOverride ?? sig.player;
  return sig.type === 'combo' ? formatCombo(sig, player) : formatSingle(sig, player);
}
