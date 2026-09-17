/**
 * Общий диспетчер для всех сетевых модулей.
 *
 * Существует ради одной настройки, которую легко пропустить: у undici свой
 * таймаут на УСТАНОВКУ соединения, по умолчанию 10 секунд, и `AbortSignal`
 * его не заменяет. Через туннель под нагрузкой десяти секунд не хватает,
 * и в логе появляются `Connect Timeout Error ... timeout: 10000ms` при
 * настроенных сорока пяти.
 */

import { Agent, ProxyAgent, type Dispatcher } from 'undici';
import { envInt, proxyFor } from './env.ts';

export function dispatcherFor(
  service: 'PINNACLE' | 'BETBY' | 'TELEGRAM',
): { dispatcher: Dispatcher | undefined; proxy: string } {
  const proxy = proxyFor(service);
  const connect = { timeout: envInt('CONNECT_TIMEOUT_MS', 30_000) };
  // Даже без прокси стоит задать свой Agent: дефолтные 10 секунд на connect
  // одинаково коротки и при прямом соединении на слабом канале.
  const dispatcher = proxy
    ? new ProxyAgent({ uri: proxy, connect })
    : new Agent({ connect });
  return { dispatcher, proxy };
}
