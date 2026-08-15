#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadDotenv, startGateway, listKeys, createKey, loadUpstreams, chatLogEnabled,
} from './gateway.mjs';
import { startBotFromEnv } from './bot.mjs';
import { startPublicBotFromEnv } from './public-bot.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
loadDotenv(path.join(here, '.env'));

const info = await startGateway({});
const up = loadUpstreams();

let first = null;
if (!listKeys().length) first = createKey({ label: 'default' });

const upline = Object.entries(up).map(([id, u]) => `${id} ${u?.apiKeys?.length ? `✓ ${u.apiKeys.length}` : '— нет ключа'}`).join('   ');

console.log('\n  CodeRoom Gateway');
console.log('  ─────────────────────────────────────────────');
console.log('  API для клиента: ' + info.url);
if (info.publicUrl) console.log('  Локально:        ' + info.localUrl);
console.log('  Слушает:         ' + info.host + ':' + info.port +
  (info.host === '0.0.0.0' ? '  (все интерфейсы)' : ''));
console.log('  Админка:         ' + info.adminUrl);
console.log('  .env:            ' + path.join(here, '.env'));
console.log('  Апстримы:        ' + upline);
console.log('  Логи чатов:      ' + (chatLogEnabled() ? 'пишутся в базу' : 'выключены (CODEROOM_LOG_CHATS=0)'));

const bot = await startBotFromEnv().catch((e) => {
  console.log('  Телеграм-бот:    не поднялся — ' + e.message);
  return null;
});
const publicBot = await startPublicBotFromEnv().catch((e) => {
  console.log('  Публичный бот:   не поднялся — ' + e.message);
  return null;
});
if (publicBot) {
  console.log(`  Публичный бот:   @${publicBot.me.username} ✓ (бесплатные ключи)`);
} else if (!process.env.TELEGRAM_PUBLIC_BOT_TOKEN) {
  console.log('  Публичный бот:   выключен (нет TELEGRAM_PUBLIC_BOT_TOKEN в .env)');
}
if (!bot && process.env.TELEGRAM_BOT_TOKEN === undefined) {
  console.log('  Телеграм-бот:    выключен (нет TELEGRAM_BOT_TOKEN в .env)');
}
if (info.host === '0.0.0.0' && !process.env.GATEWAY_ADMIN_TOKEN) {
  console.log('  ⚠ Порт открыт наружу, а GATEWAY_ADMIN_TOKEN не задан —');
  console.log('    токен админки сменится при перезапуске. Пропиши его в server/.env.');
}
if (!Object.values(up).some((u) => u?.apiKeys?.length)) {
  console.log('  ⚠ Нет ключей апстримов — впиши их в server/.env');
}
if (first) {
  console.log('\n  Первый ключ (вставь в клиенте, провайдер coderoom):');
  console.log('    ' + first.key);
}
console.log('\n  Управление ключами: node keys.mjs new|ls|rm   ·   Ctrl+C — остановить\n');

process.on('SIGINT', () => {
  bot?.stop();
  publicBot?.stop();
  console.log('\n  Остановлено.');
  process.exit(0);
});
