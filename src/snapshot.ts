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

export class Snapshots {
  private readonly live = new BetbyClient('live');
  private readonly pre = new BetbyClient('prematch');
  private liveSnap: Snapshot | null = null;
  private preSnap: Snapshot | null = null;

  async bootstrap(): Promise<void> {
    this.liveSnap = await this.live.bootstrap();
    this.preSnap = await this.pre.bootstrap();
  }

  /** Перечитывает оба фида, если версии сдвинулись. Ошибку глотает — старое
   *  состояние остаётся в силе до следующей удачной попытки. */
  async refresh(): Promise<void> {
    for (const [client, set] of [
      [this.live, (s: Snapshot) => (this.liveSnap = s)],
      [this.pre, (s: Snapshot) => (this.preSnap = s)],
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
      tournament: snap!.tournaments[String(d.tournament)]?.name ?? '',
      home,
      away,
      virtual: d.virtual === true || CYBER_MARK.test(home) || CYBER_MARK.test(away),
      live,
      scheduled: Number(d.scheduled) || 0,
    };
  }

  /** Событие по id: сначала live (значит, идёт), затем prematch. */
  resolve(eventId: string): ResolvedEvent | null {
    return this.describe(this.liveSnap, eventId, true) ?? this.describe(this.preSnap, eventId, false);
  }

  get ready(): boolean {
    return this.liveSnap !== null && this.preSnap !== null;
  }
}
