/**
 * Тонкий клиент Bot API — нужны всего три метода.
 *
 * Сетевые ошибки здесь не бросаются наружу: упавший Telegram не должен
 * останавливать сбор данных. Потерянное уведомление — неприятность,
 * остановленный цикл — потеря наблюдения.
 */

// fetch из undici, а не глобальный: см. пояснение в pinnacle.ts.
import { fetch } from 'undici';
import { envInt } from './env.ts';
import { dispatcherFor } from './http.ts';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';

// api.telegram.org у ряда провайдеров заблокирован так же, как и букмекеры.
const { dispatcher, proxy: PROXY } = dispatcherFor('TELEGRAM');
const TIMEOUT_MS = envInt('HTTP_TIMEOUT_MS', 20_000);

interface ApiResult<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

async function call<T>(method: string, body: unknown): Promise<T | null> {
  if (!TOKEN) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      dispatcher,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json = (await res.json()) as ApiResult<T>;
    if (!json.ok) {
      console.warn(`telegram ${method}: ${json.description}`);
      return null;
    }
    return json.result ?? null;
  } catch (e) {
    // Голое «fetch failed» бесполезно: настоящая причина в цепочке cause.
    const chain: string[] = [];
    let cur: unknown = e;
    for (let i = 0; i < 3 && cur instanceof Error; i++) {
      chain.push(cur.message);
      cur = (cur as { cause?: unknown }).cause;
    }
    console.warn(
      `telegram ${method} ${PROXY ? `(через прокси ${PROXY})` : '(напрямую)'}: ${chain.join(' ← ')}`,
    );
    return null;
  }
}

export const configured = (): boolean => TOKEN.length > 0;

export async function send(chatId: string, text: string): Promise<number | null> {
  const r = await call<{ message_id: number }>('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
  return r?.message_id ?? null;
}

export async function edit(chatId: string, messageId: number, text: string): Promise<void> {
  await call('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
}

export const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
