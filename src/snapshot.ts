/**
 * Держит два снапшота котировок BetBy — live и prematch — и резолвит по
 * event_id из ленты ставок описание события: спорт, команды, турнир, virtual.
 *
 * Зачем оба: ставка может быть и на идущий, и на предстоящий матч, а фиды
 * раздельные. Live обновляется часто, prematch пересобирается раз в 60 с —
 * poll() у BetbyClient сам возвращает null, когда версия не сдвинулась, так
 * что лишних пересборок нет. Последнее удачное состояние держим у себя, чтобы
 * пропущенный цикл не «терял» события между опросами.
 */

import { BetbyClient, type Snapshot, type EventDesc } from './betby.ts';

export interface ResolvedEvent {
  sportId: string;
  sportName: string;
  category: string;
  tournament: string;
  home: string;
  away: string;
  /** virtual или киберспорт — по флагу desc.virtual (надёжнее, чем ловить ᵉ) */
  virtual: boolean;
  /** найдено в live-снапшоте → матч идёт */
  live: boolean;
  /** время начала, unix-секунды (0 если неизвестно) */
  scheduled: number;
}

// Надстрочная «e» (U+1D49), которой сайт метит виртуальные/кибер-события в
// именах. Флага desc.virtual достаточно, но имя проверяем как дешёвую подстраховку.
const CYBER_MARK = /ᵉ/;

/**
 * Сколько помним событие после того, как оно пропало из линии. Ставка нередко
 * доходит до ленты, когда матч уже снят (доигран): в live его больше нет, и
 * раньше плечо уходило как «матч не в снапшоте». Проверено на живой ленте:
 * из 9 ненайденных 5 были в live минутами раньше.
 */
const MEMO_TTL_MS = 12 * 60 * 60_000;

export class Snapshots {
  private readonly live = new BetbyClient('live');
  private readonly pre = new BetbyClient('prematch');
  private liveSnap: Snapshot | null = null;
  private preSnap: Snapshot | null = null;
  /** все события, что были в линии за MEMO_TTL_MS: id → описание + когда видели */
  private readonly memo = new Map<string, { ev: ResolvedEvent; at: number }>();
  private memoPrunedAt = 0;

  async bootstrap(): Promise<void> {
    this.liveSnap = await this.live.bootstrap();
    this.preSnap = await this.pre.bootstrap();
    this.remember(this.liveSnap, true);
    this.remember(this.preSnap, false);
  }

  /** Запоминает все события снапшота (дёшево: пара тысяч записей раз в минуту). */
  private remember(snap: Snapshot, live: boolean): void {
    const now = Date.now();
    for (const id of Object.keys(snap.events)) {
      const ev = this.describe(snap, id, live);
      if (ev) this.memo.set(id, { ev, at: now });
    }
    if (now - this.memoPrunedAt > 30 * 60_000) {
      this.memoPrunedAt = now;
      for (const [id, m] of this.memo) if (now - m.at > MEMO_TTL_MS) this.memo.delete(id);
    }
  }

  /** Перечитывает оба фида, если версии сдвинулись. Ошибку глотает — старое
   *  состояние остаётся в силе до следующей удачной попытки. */
  async refresh(): Promise<void> {
    for (const [client, set] of [
      [this.live, (s: Snapshot) => { this.liveSnap = s; this.remember(s, true); }],
      [this.pre, (s: Snapshot) => { this.preSnap = s; this.remember(s, false); }],
    ] as const) {
      try {
        const s = await client.poll();
        if (s) set(s);
      } catch (e) {
        console.warn(`снапшот: ${(e as Error).message}`);
      }
    }
  }

  private describe(snap: Snapshot | null, id: string, live: boolean): ResolvedEvent | null {
    const ev = snap?.events[id];
    const d = ev?.desc as EventDesc | undefined;
    if (!d) return null;
    const c = d.competitors ?? [];
    const home = c[0]?.name ?? '?';
    const away = c[1]?.name ?? '?';
    const sportId = String(d.sport);
    return {
      sportId,
      sportName: snap!.sports[sportId]?.name ?? sportId,
      category: snap!.categories[String(d.category)]?.name ?? '',
      tournament: snap!.tournaments[String(d.tournament)]?.name ?? '',
      home,
      away,
      virtual: d.virtual === true || CYBER_MARK.test(home) || CYBER_MARK.test(away),
      live,
      scheduled: Number(d.scheduled) || 0,
    };
  }

  /** Событие по id: сначала live (значит, идёт), затем prematch, затем память
   *  (матч уже снят с линии — берём, каким он был, когда его видели последний раз). */
  resolve(eventId: string): ResolvedEvent | null {
    return (
      this.describe(this.liveSnap, eventId, true) ??
      this.describe(this.preSnap, eventId, false) ??
      this.memo.get(eventId)?.ev ??
      null
    );
  }

  get ready(): boolean {
    return this.liveSnap !== null && this.preSnap !== null;
  }
}
