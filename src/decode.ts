/**
 * Оффлайн-проверка: печатает текущую ленту ставок так, как её увидит парсер,
 * но НИЧЕГО не шлёт в Telegram. Нужен, чтобы глазами сверить восстановленные
 * названия исходов с сайтом перед боевым запуском.
 *
 *   npm run decode              — все целевые виды спорта
 *   npm run decode -- --all     — вообще все, включая virtual и прочие спорты
 */

import { fetchBets } from './betsfeed.ts';
import { Snapshots } from './snapshot.ts';
import { classify, formatSignal } from './signal.ts';
import { isTargetSport } from './labels.ts';
import { loadShipped, refreshFromApi } from './descriptions.ts';
import { refreshRates } from './fx.ts';

const showAll = process.argv.includes('--all');
const strip = (html: string) => html.replace(/<[^>]+>/g, '');

// при `| head` труба закрывается раньше — это не ошибка, тихо выходим
process.stdout.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EPIPE') process.exit(0);
});

async function main(): Promise<void> {
  const snaps = new Snapshots();
  loadShipped();
  await refreshFromApi();
  await refreshRates();
  console.error('загружаю снапшоты…');
  await snaps.bootstrap();
  const bets = await fetchBets();
  console.error(`лента: ${bets.length} ставок\n`);

  let shown = 0;
  for (const b of bets) {
    const sig = await classify(b, snaps);
    if (!showAll) {
      if (!isTargetSport(sig.primarySport)) continue;
      if (sig.virtual) continue;
    }
    shown++;
    const flags = [
      sig.virtual ? 'VIRTUAL' : '',
      isTargetSport(sig.primarySport) ? '' : `спорт:${sig.primarySport || '?'}`,
    ]
      .filter(Boolean)
      .join(' ');
    console.log(strip(formatSignal(sig)) + (flags ? `   ⟨${flags}⟩` : ''));
    console.log('─'.repeat(48));
  }
  console.error(`\nпоказано: ${shown}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
