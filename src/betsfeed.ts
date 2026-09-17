/**
 * Опрос ленты ставок BetBy (bets_feed).
 *
 * Без авторизации, как и фид котировок. Возвращает JSON-массив последних
 * ставок (обычно ~50), новые сверху. Инкремента нет — каждый запрос отдаёт
 * актуальный срез, поэтому новизна определяется по стабильному полю `id`.
 */

import { fetch } from 'undici';
import { envInt } from './env.ts';
import { dispatcherFor } from './http.ts';

const HOST = 'https://api-g-c7818b61-607.sptpub.com';
const BRAND = '2186449803775455232';
const URL = `${HOST}/api/v1/promo/bets_feed/brand/${BRAND}`;
const TIMEOUT_MS = envInt('HTTP_TIMEOUT_MS', 20_000);

const { dispatcher, proxy: PROXY } = dispatcherFor('BETBY');

export interface Selection {
  event_id: string;
  market_id: string;
  outcome_id: string;
  specifiers: string;
  /** коэффициент этого плеча, строкой */
  k: string;
}

export interface Bet {
  id: string;
  /** итоговый коэффициент, строкой */
  odds: string;
  /** сумма с символом валюты: "1700.00 $" */
  stake: string;
  pot_win: string;
  /** маскированный сайтом ник: "****276" */
  player: string;
  type: 'single' | 'combo';
  selections: Selection[];
}

export async function fetchBets(): Promise<Bet[]> {
  let res;
  try {
    res = await fetch(URL, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      dispatcher,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(
      `bets_feed недоступен${PROXY ? ` (через прокси ${PROXY})` : ' (напрямую)'}`,
      { cause: e },
    );
  }
  if (!res.ok) throw new Error(`bets_feed: HTTP ${res.status}`);
  const data = (await res.json()) as Bet[];
  if (!Array.isArray(data)) throw new Error('bets_feed: ответ не массив');
  return data;
}
