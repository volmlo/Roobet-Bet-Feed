/**
 * Настройки из окружения (.env). Значения по умолчанию совпадают с прежним
 * Tampermonkey-скриптом v1.7, чтобы поведение не поехало при переходе.
 */

import { readFileSync } from 'node:fs';
import { envInt, envStr } from './env.ts';

const norm = (arr: string[]): string[] =>
  arr.map((s) => String(s).trim().toLowerCase()).filter(Boolean);

/** Список из переменной окружения (через запятую). */
function list(name: string): string[] {
  return norm(envStr(name).split(','));
}

/**
 * Чёрные списки лежат в git-файле filters.json (без секретов) — их удобно
 * править на Mac и катить `git pull`-ом. Файл не обязателен; при отсутствии
 * или ошибке разбора берутся только переменные окружения.
 */
interface Filters {
  teamBlacklist?: string[];
  tournamentBlacklist?: string[];
  consensusTeamBlacklist?: string[];
  consensusTournamentBlacklist?: string[];
  /** массив хвостов ["****112", …] ИЛИ объект {"****112":"Бутерброд"} (хвост → имя) */
  watchPlayers?: string[] | Record<string, string>;
}

/**
 * Нормализация помеченного игрока: имя в ленте маскировано («****a02»), видно
 * лишь хвост. Убираем звёздочки/пробелы, приводим к нижнему регистру, чтобы
 * сравнивать хвост ставки с хвостом из списка. Совпадение неточное (хвост из
 * нескольких символов могут делить разные игроки) — это ограничение маски.
 */
export const playerTail = (s: string): string =>
  String(s).replace(/[*\s]+/g, '').toLowerCase();

function loadFilters(): Filters {
  try {
    const url = new URL('../filters.json', import.meta.url);
    return JSON.parse(readFileSync(url, 'utf8')) as Filters;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`filters.json не разобран, беру только .env: ${(e as Error).message}`);
    }
    return {};
  }
}

/** Объединяет список из .env и из filters.json (без дублей). */
function combined(envName: string, fromFile: string[] | undefined): string[] {
  return Array.from(new Set([...list(envName), ...norm(fromFile ?? [])]));
}

/**
 * Помеченные игроки → пары «нормализованный хвост маски → имя». Источники:
 *   filters.json: массив ["****112", …] (без имён) ИЛИ объект {"****112":"Бутерброд"};
 *   env WATCH_PLAYERS: через запятую, элемент «хвост» или «хвост=Имя».
 * Хвост нормализуется playerTail («****112» → «112»); имя хранится как есть (регистр
 * важен для показа). Непустое имя не затирается пустым из другого источника.
 */
function parseWatch(
  fromFile: string[] | Record<string, string> | undefined,
  envRaw: string,
): Map<string, string> {
  const map = new Map<string, string>();
  const put = (rawTail: string, name: string): void => {
    const tail = playerTail(rawTail);
    if (!tail) return;
    const nm = String(name ?? '').trim();
    if (nm || !map.has(tail)) map.set(tail, nm || map.get(tail) || '');
  };
  if (Array.isArray(fromFile)) {
    for (const s of fromFile) put(String(s), '');
  } else if (fromFile && typeof fromFile === 'object') {
    for (const [tail, name] of Object.entries(fromFile)) put(tail, String(name));
  }
  for (const item of envRaw.split(',')) {
    const s = item.trim();
    if (!s) continue;
    const eq = s.indexOf('=');
    if (eq >= 0) put(s.slice(0, eq), s.slice(eq + 1));
    else put(s, '');
  }
  return map;
}

export interface Config {
  mainChatId: string;
  ttChatId: string;
  consensusChatId: string;
  /** канал помеченных игроков: любая их ставка, БЕЗ порогов и чёрных списков */
  watchChatId: string;
  /** помеченные игроки: нормализованный хвост маски («****a02» → «a02») → имя ('' если не задано) */
  watchPlayers: Map<string, string>;
  /** куда слать служебные тревоги (сторож тишины). Пусто → только в лог. */
  alertChatId: string;

  mainMinUsd: number;
  mainMinOdd: number;
  ttMinUsd: number;
  ttMinOdd: number;

  excludeCyber: boolean;

  consensus: {
    n: number;
    windowMs: number;
    retainMs: number;
    debounceMs: number;
    minUsd: number;
  };

  /** пауза между опросами ленты ставок */
  refreshMs: number;

  /** нет новых ставок дольше этого → тревога «фид завис» */
  stallAlertMs: number;

  /** подстроки (в нижнем регистре); совпадение в имени команды/турнира → пропуск ИЗ ВСЕХ каналов */
  teamBlacklist: string[];
  tournamentBlacklist: string[];

  /** то же, но исключает матч ТОЛЬКО из прогрузов (напр. топ-лиги); основной канал не трогает */
  consensusTeamBlacklist: string[];
  consensusTournamentBlacklist: string[];
}

export function loadConfig(): Config {
  const f = loadFilters();
  return {
    mainChatId: envStr('MAIN_CHAT_ID'),
    ttChatId: envStr('TT_CHAT_ID'),
    consensusChatId: envStr('CONSENSUS_CHAT_ID'),
    watchChatId: envStr('WATCH_CHAT_ID'),
    watchPlayers: parseWatch(f.watchPlayers, envStr('WATCH_PLAYERS')),
    alertChatId: envStr('ALERT_CHAT_ID'),

    mainMinUsd: envInt('MAIN_MIN_USD', 300),
    mainMinOdd: envInt('MAIN_MIN_ODD', 1.5),
    ttMinUsd: envInt('TT_MIN_USD', 250),
    ttMinOdd: envInt('TT_MIN_ODD', 1.5),

    excludeCyber: envStr('EXCLUDE_CYBER', 'true') !== 'false',

    consensus: {
      n: envInt('CONSENSUS_N', 3),
      windowMs: envInt('CONSENSUS_WINDOW_MS', 60_000),
      retainMs: envInt('CONSENSUS_RETAIN_MS', 360_000),
      debounceMs: envInt('CONSENSUS_DEBOUNCE_MS', 15_000),
      minUsd: envInt('CONSENSUS_MIN_USD', 1), // envInt отбрасывает 0; 1 = «любая ставка»
    },

    refreshMs: envInt('REFRESH_MS', 3_000),
    stallAlertMs: envInt('STALL_ALERT_MS', 600_000),

    teamBlacklist: combined('TEAM_BLACKLIST', f.teamBlacklist),
    tournamentBlacklist: combined('TOURNAMENT_BLACKLIST', f.tournamentBlacklist),

    consensusTeamBlacklist: combined('CONSENSUS_TEAM_BLACKLIST', f.consensusTeamBlacklist),
    consensusTournamentBlacklist: combined(
      'CONSENSUS_TOURNAMENT_BLACKLIST',
      f.consensusTournamentBlacklist,
    ),
  };
}
