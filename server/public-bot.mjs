#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { issuePublicKey, publicKeyStatus, loadDotenv } from './gateway.mjs';

const API = 'https://api.telegram.org/bot';

export function createPublicBot({ token, onLog = console.log } = {}) {
  if (!token) throw new Error('Нет TELEGRAM_PUBLIC_BOT_TOKEN');
  let running = false;
  let offset = 0;
  const call = async (method, body) => {
    const res = await fetch(API + token + '/' + method, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!data.ok) throw new Error(data.description || String(res.status));
    return data.result;
  };
  const send = (chatId, text, extra = {}) => call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra });
  const handle = async (update) => {
    const msg = update.message;
    if (!msg?.text) return;
    const chatId = msg.chat.id;
    if (/^\/(start|key)(?:@\w+)?/i.test(msg.text)) {
      const { key, quota, expired } = issuePublicKey(msg.from.id);
      if (expired) return send(chatId, '<b>Бесплатный период закончился</b>\n\nБесплатный ключ выдаётся один раз и работает 30 дней.\nКупить новый ключ: @udpallow');
      const expires = new Date(quota.expiresAt).toLocaleDateString('ru-RU');
      return send(chatId, `<b>Бесплатный ключ CodeRoom</b>\n\n<code>${key.key}</code>\n\n🎁 Бесплатно\nЛимит: 100 000 токенов на 5 часов\nСброс лимита: автоматически каждые 5 часов\nКлюч действует 30 дней — до ${expires}\n\nПроверить остаток: /limits`);
    }
    if (/^\/limits(?:@\w+)?/i.test(msg.text)) {
      const status = publicKeyStatus(msg.from.id);
      if (!status) return send(chatId, 'У тебя ещё нет бесплатного ключа. Получить: /key');
      if (status.expired) return send(chatId, 'Срок бесплатного ключа закончился. Купить новый: @udpallow');
      const reset = new Date(status.resetAt).toLocaleString('ru-RU');
      const expires = new Date(status.quota.expiresAt).toLocaleDateString('ru-RU');
      return send(chatId, `<b>Лимиты бесплатного ключа</b>\n\nИспользовано: ${status.used.toLocaleString('ru-RU')}\nОсталось: ${status.remaining.toLocaleString('ru-RU')} токенов\nСброс: ${reset}\nКлюч действует до: ${expires}`);
    }
    return send(chatId, '<b>Бесплатный ключ CodeRoom</b>\n\n/key — получить ключ\n/limits — остаток лимита\n\n100k токенов на 5 часов, срок 30 дней.');
  };
  const poll = async () => {
    while (running) {
      try {
        const updates = await call('getUpdates', { offset, timeout: 30, allowed_updates: ['message'] });
        for (const u of updates) { offset = u.update_id + 1; await handle(u); }
      } catch (e) { onLog('  публичный бот: ' + e.message); await new Promise((r) => setTimeout(r, 3000)); }
    }
  };
  return {
    handle,
    async start() {
      const me = await call('getMe', {});
      await call('setMyCommands', { commands: [
        { command: 'key', description: 'получить бесплатный ключ' },
        { command: 'limits', description: 'остаток и время сброса' },
      ] }).catch(() => {});
      running = true;
      poll();
      return me;
    },
    stop() { running = false; },
  };
}

export async function startPublicBotFromEnv() {
  if (!process.env.TELEGRAM_PUBLIC_BOT_TOKEN) return null;
  const bot = createPublicBot({ token: process.env.TELEGRAM_PUBLIC_BOT_TOKEN });
  bot.me = await bot.start();
  return bot;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  loadDotenv(path.join(path.dirname(fileURLToPath(import.meta.url)), '.env'));
  const bot = await startPublicBotFromEnv();
  if (!bot) throw new Error('Добавь TELEGRAM_PUBLIC_BOT_TOKEN в server/.env');
  console.log(`Публичный бот @${bot.me.username} запущен`);
}
