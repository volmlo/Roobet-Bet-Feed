/**
 * Чтение числовых настроек из окружения.
 *
 * Наивное `Number(process.env.X ?? DEFAULT)` — источник тихих отказов.
 * Оператор `??` подставляет запасное значение только для undefined и null,
 * поэтому пустая строка проходит насквозь и превращается в 0. Для таймаута
 * это означает `AbortSignal.timeout(0)`, то есть отмену запроса немедленно —
 * симптом выглядит как «сеть не работает», хотя сеть в полном порядке.
 *
 * Та же ловушка с `\r` на конце строки, если .env редактировали в Windows
 * или собирали через heredoc: `Number('45000\r')` даёт NaN.
 */
export function envInt(name: string, fallback: number): number {
  const raw = (process.env[name] ?? '').trim();
  if (raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.warn(`${name}="${raw}" — не положительное число, беру ${fallback}`);
    return fallback;
  }
  return n;
}

/**
 * Прокси для конкретного сервиса. Сначала персональная переменная, затем
 * общий PROXY_URL. Такой порядок нужен потому, что у провайдера могут быть
 * заблокированы все три хоста разом — тогда одной переменной достаточно, —
 * но природа блокировок разная и когда-нибудь может понадобиться развести их.
 */
export function proxyFor(service: 'PINNACLE' | 'BETBY' | 'TELEGRAM'): string {
  return envStr(`${service}_PROXY`) || envStr('PROXY_URL');
}

/** Строковая настройка: пустая строка равнозначна отсутствию. */
export function envStr(name: string, fallback = ''): string {
  const raw = (process.env[name] ?? '').trim();
  return raw === '' ? fallback : raw;
}
