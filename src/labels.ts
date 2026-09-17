/**
 * Виды спорта, валюты, суммы. Названия рынков/исходов — в descriptions.ts.
 */

/** Виды спорта, которые нас интересуют. Остальные (в т.ч. любой virtual) отсекаются. */
export const SPORTS: Record<string, { emoji: string; name: string }> = {
  '1': { emoji: '⚽️', name: 'Футбол' },
  '2': { emoji: '🏀', name: 'Баскетбол' },
  '5': { emoji: '🎾', name: 'Теннис' },
  '20': { emoji: '🏓', name: 'Настольный теннис' },
};

export const isTargetSport = (sportId: string): boolean => sportId in SPORTS;

/**
 * Курсы к доллару по символу валюты в строке ставки ("1000.00 ₺").
 * Приблизительные и заведомо устаревают — это фильтр порога, а не бухгалтерия:
 * ошибка в пару процентов не меняет решения «слать/не слать».
 */
export const FX: Record<string, number> = {
  $: 1,
  '€': 1.08,
  '£': 1.27,
  '₺': 0.03,
  R$: 0.19,
  '₹': 0.012,
  C$: 0.73,
  A$: 0.66,
  zł: 0.25,
  '¥': 0.0067,
  '₩': 0.00072,
  '₦': 0.00065,
  '₨': 0.0036,
};

/** "1700.00 $" | "1 000,00 €" → доллары. Неизвестная валюта считается долларом. */
export function stakeUsd(stake: string): number {
  const trimmed = stake.trim();
  const sp = trimmed.lastIndexOf(' ');
  const numRaw = sp >= 0 ? trimmed.slice(0, sp) : trimmed;
  const cur = sp >= 0 ? trimmed.slice(sp + 1) : '$';
  const n = Number(numRaw.replace(/\s/g, '').replace(/,(\d{2})$/, '.$1').replace(/,/g, ''));
  return (Number.isFinite(n) ? n : 0) * (FX[cur] ?? 1);
}
