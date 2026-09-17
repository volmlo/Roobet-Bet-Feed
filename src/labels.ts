/**
 * Виды спорта. Названия рынков/исходов — в descriptions.ts, валюты — в fx.ts.
 */

/** Виды спорта, которые нас интересуют. Остальные (в т.ч. любой virtual) отсекаются. */
export const SPORTS: Record<string, { emoji: string; name: string }> = {
  '1': { emoji: '⚽️', name: 'Футбол' },
  '2': { emoji: '🏀', name: 'Баскетбол' },
  '5': { emoji: '🎾', name: 'Теннис' },
  '20': { emoji: '🏓', name: 'Настольный теннис' },
};

export const isTargetSport = (sportId: string): boolean => sportId in SPORTS;
