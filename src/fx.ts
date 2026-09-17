/**
 * Конвертация ставок в доллары.
 *
 * Лента отдаёт сумму с СИМВОЛОМ валюты ("1320000.00 Rp"), а не с ISO-кодом.
 * Поэтому: символ → код (стабильная карта) → курс. Курсы берём живые с
 * open.er-api.com (база USD, обновляется раз в сутки), обновляем раз в 12 ч.
 * Если API недоступен — зашитый приблизительный фолбэк, так что офлайн тоже
 * считает. Незнакомый символ даёт 0 (безопаснее пропустить, чем посчитать как
 * доллар 1:1 и выдать ложный «крупный» сигнал).
 *
 * Для порога это фильтр, а не бухгалтерия: важен порядок величины.
 */

import { fetch } from 'undici';
import { envInt } from './env.ts';
import { dispatcherFor } from './http.ts';

const TIMEOUT_MS = envInt('HTTP_TIMEOUT_MS', 20_000);
const { dispatcher } = dispatcherFor('BETBY');

/** Символ валюты в ленте → ISO-код. Символы стабильны; BetBy разводит
 *  неоднозначные разными знаками (A$, C$, R$, NZ$), поэтому «$» = USD. */
const SYMBOL_TO_CODE: Record<string, string> = {
  $: 'USD',
  '€': 'EUR',
  '£': 'GBP',
  CHF: 'CHF',
  '₺': 'TRY',
  R$: 'BRL',
  '₹': 'INR',
  C$: 'CAD',
  A$: 'AUD',
  'NZ$': 'NZD',
  zł: 'PLN',
  '¥': 'JPY', // юань BetBy шлёт как CNY
  CNY: 'CNY',
  '₩': 'KRW',
  '₦': 'NGN',
  '₨': 'PKR',
  Rp: 'IDR',
  '₫': 'VND',
  '฿': 'THB',
  '₱': 'PHP',
  RM: 'MYR',
  '₸': 'KZT',
  '₴': 'UAH',
  '₽': 'RUB',
  'S/': 'PEN',
  '৳': 'BDT',
  '₪': 'ILS',
  Kč: 'CZK',
  Ft: 'HUF',
  '₾': 'GEL',
  '₼': 'AZN',
  kr: 'SEK', // скандинавские кроны неотличимы по символу; берём SEK
};

/** Долларов за 1 единицу — приблизительный офлайн-фолбэк по символу. */
const FALLBACK: Record<string, number> = {
  $: 1,
  '€': 1.08,
  '£': 1.27,
  CHF: 1.12,
  '₺': 0.029,
  R$: 0.18,
  '₹': 0.012,
  C$: 0.72,
  A$: 0.65,
  'NZ$': 0.6,
  zł: 0.25,
  '¥': 0.0066,
  CNY: 0.14,
  '₩': 0.00072,
  '₦': 0.00065,
  '₨': 0.0036,
  Rp: 0.00006,
  '₫': 0.00004,
  '฿': 0.028,
  '₱': 0.017,
  RM: 0.22,
  '₸': 0.002,
  '₴': 0.024,
  '₽': 0.011,
  'S/': 0.27,
  '৳': 0.0083,
  '₪': 0.27,
  Kč: 0.043,
  Ft: 0.0027,
  '₾': 0.37,
  '₼': 0.59,
  kr: 0.09,
};

/** Живые курсы (долларов за 1 единицу) по символу; пусто до первого рефреша. */
let live: Record<string, number> = {};
const unknownCurrencies = new Set<string>();

/**
 * Обновляет курсы с open.er-api.com. true при успехе. При неудаче прежние
 * (или фолбэк) остаются в силе — наблюдение не останавливаем из-за курсов.
 */
export async function refreshRates(): Promise<boolean> {
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      dispatcher,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { result?: string; rates?: Record<string, number> };
    const rates = json.rates;
    if (json.result !== 'success' || !rates) throw new Error('нет rates');
    // rates[C] = сколько единиц C за 1 USD → долларов за единицу = 1/rates[C]
    const map: Record<string, number> = {};
    for (const [sym, code] of Object.entries(SYMBOL_TO_CODE)) {
      const perUsd = rates[code];
      if (typeof perUsd === 'number' && perUsd > 0) map[sym] = 1 / perUsd;
    }
    if (Object.keys(map).length === 0) throw new Error('пустая карта курсов');
    live = map;
    return true;
  } catch (e) {
    console.warn(`курсы валют не обновлены (${(e as Error).message}) — беру прежние/фолбэк`);
    return false;
  }
}

/** Запускает обновление курсов на старте и каждые 12 часов. */
export async function startRates(): Promise<void> {
  await refreshRates();
  const twelveH = 12 * 60 * 60 * 1000;
  setInterval(() => void refreshRates(), twelveH).unref();
}

const rateFor = (cur: string): number | undefined => live[cur] ?? FALLBACK[cur];

/**
 * "1700.00 $" | "1 000,00 €" → доллары. Валюта — суффикс после суммы.
 * Незнакомая валюта → 0 + разовое предупреждение.
 */
export function stakeUsd(stake: string): number {
  const trimmed = stake.trim();
  const sp = trimmed.lastIndexOf(' ');
  const numRaw = sp >= 0 ? trimmed.slice(0, sp) : trimmed;
  const cur = sp >= 0 ? trimmed.slice(sp + 1) : '$';
  const n = Number(numRaw.replace(/\s/g, '').replace(/,(\d{2})$/, '.$1').replace(/,/g, ''));
  const rate = rateFor(cur);
  if (rate === undefined) {
    if (!unknownCurrencies.has(cur)) {
      unknownCurrencies.add(cur);
      console.warn(`неизвестная валюта "${cur}" (${stake}) — пропускаю; добавь в SYMBOL_TO_CODE`);
    }
    return 0;
  }
  return (Number.isFinite(n) ? n : 0) * rate;
}
