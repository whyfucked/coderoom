#!/usr/bin/env node

/*
  Телеграм-бот управления шлюзом: ключи, расход, история чатов.
  Без зависимостей — long polling через fetch.

  .env:
    TELEGRAM_BOT_TOKEN=123456:AA...      токен от @BotFather
    TELEGRAM_ADMIN_IDS=123456789,987...  кому можно (свой id покажет сам бот)
*/

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createKey, listKeys, revokeKey, setKeyDisabled, stats, store, loadUpstreams,
  listChats, getChat, countChats, deleteChats, chatLogEnabled, loadDotenv, DATA_DIR,
} from './gateway.mjs';

const API = 'https://api.telegram.org/bot';
const PAGE = 8;

const fmt = (n) => (n >= 1_000_000 ? (n / 1e6).toFixed(1) + 'M'
  : n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n ?? 0));

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const when = (iso) => String(iso ?? '').slice(0, 16).replace('T', ' ');

const short = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};


/* ─────────────────────────  транспорт  ───────────────────────── */

export function createBot({ token, admins = [], onLog = console.log } = {}) {
  if (!token) throw new Error('Нет TELEGRAM_BOT_TOKEN');

  const allowed = new Set(admins.map(String).filter(Boolean));
  let offset = 0;
  let running = false;
  let me = null;
  const pending = new Map();   // chatId -> ожидаемое подтверждение

  async function call(method, payload) {
    const res = await fetch(API + token + '/' + method, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
    });
    const data = await res.json().catch(() => ({ ok: false, description: 'ответ не JSON' }));
    if (!data.ok) throw new Error(`${method}: ${data.description || res.status}`);
    return data.result;
  }

  /** Телеграм режет сообщения на 4096 символов — шлём частями. */
  async function send(chatId, text, extra = {}) {
    const chunks = [];
    let rest = String(text);
    while (rest.length > 3800) {
      const cut = rest.lastIndexOf('\n', 3800);
      chunks.push(rest.slice(0, cut > 500 ? cut : 3800));
      rest = rest.slice(cut > 500 ? cut : 3800);
    }
    chunks.push(rest);

    let last = null;
    for (const [i, chunk] of chunks.entries()) {
      last = await call('sendMessage', {
        chat_id: chatId,
        text: chunk,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...(i === chunks.length - 1 ? extra : {}),
      }).catch((e) => { onLog('  ошибка отправки: ' + e.message); return null; });
    }
    return last;
  }

  const kb = (rows) => ({ reply_markup: { inline_keyboard: rows } });
  const btn = (text, data) => ({ text, callback_data: data });


  /* ─────────────────────────  экраны  ───────────────────────── */

  const HELP = [
    '<b>CodeRoom Gateway</b>',
    '',
    '<b>Ключи</b>',
    '/keys — список с кнопками',
    '/new <i>метка</i> [<i>лимит</i>] — новый ключ',
    '/rm <i>id</i> — удалить',
    '/off <i>id</i> · /on <i>id</i> — выключить / включить',
    '',
    '<b>Расход</b>',
    '/stats — итоги и топ моделей',
    '/health — апстримы и база',
    '',
    '<b>Переписка</b>',
    '/chats — последние чаты',
    '/chat <i>id</i> — показать целиком',
    '/find <i>текст</i> — поиск по чатам',
    '/clearchats — стереть всю историю',
  ].join('\n');

  function keyLine(k) {
    const used = k.used.input + k.used.output;
    const limit = k.limitTokens ? ` / ${fmt(k.limitTokens)}` : '';
    return `<code>${k.id}</code> · ${esc(k.label || '—')}${k.disabled ? ' · ⛔' : ''}\n` +
      `    <code>cr-…${esc(k.key.slice(-6))}</code> · ${fmt(used)}${limit} тк · ${k.used.requests} зпр`;
  }

  async function screenKeys(chatId, messageId) {
    const keys = listKeys();
    const text = keys.length
      ? `🔑 <b>Ключи</b> (${keys.length})\n\n` + keys.map(keyLine).join('\n\n')
      : '🔑 Ключей пока нет.\n\nСоздать: /new метка';

    const rows = keys.slice(0, 12).map((k) => [btn(
      (k.disabled ? '⛔ ' : '') + (k.label || k.id) + ' · …' + k.key.slice(-4),
      'key:' + k.id,
    )]);
    rows.push([btn('➕ Новый', 'key:new'), btn('🔄 Обновить', 'keys')]);

    return edit(chatId, messageId, text, kb(rows));
  }

  async function screenKey(chatId, messageId, id) {
    const k = listKeys().find((x) => x.id === id);
    if (!k) return edit(chatId, messageId, 'Ключ не найден — возможно, уже удалён.', kb([[btn('← К ключам', 'keys')]]));

    const used = k.used.input + k.used.output;
    const chats = listChats({ keyId: k.id, limit: 1 });
    const text = [
      `🔑 <b>${esc(k.label || 'без метки')}</b>${k.disabled ? '  ⛔ выключен' : ''}`,
      '',
      `<code>${esc(k.key)}</code>`,
      '',
      `id: <code>${k.id}</code>`,
      `создан: ${when(k.createdAt)}`,
      `расход: ${fmt(k.used.input)}↑ ${fmt(k.used.output)}↓ · ${k.used.requests} запросов`,
      k.limitTokens ? `лимит: ${fmt(used)} из ${fmt(k.limitTokens)} тк` : 'лимит: без ограничения',
      chats.length ? `последний чат: ${when(chats[0].at)}` : 'чатов нет',
    ].join('\n');

    return edit(chatId, messageId, text, kb([
      [k.disabled ? btn('✅ Включить', 'key:on:' + k.id) : btn('⛔ Выключить', 'key:off:' + k.id),
        btn('🗑 Удалить', 'key:del:' + k.id)],
      [btn('💬 Его чаты', 'chats:key:' + k.id + ':0'), btn('← К ключам', 'keys')],
    ]));
  }

  async function screenChats(chatId, messageId, { offset: off = 0, keyId = '', q = '' } = {}) {
    const chats = listChats({ limit: PAGE, offset: off, keyId, q });
    const total = countChats();

    const head = q ? `🔎 <b>Поиск:</b> ${esc(q)}`
      : keyId ? `💬 <b>Чаты ключа</b> <code>${esc(keyId)}</code>`
        : '💬 <b>Последние чаты</b>';

    if (!chats.length) {
      const why = !chatLogEnabled()
        ? '\n\nЛогирование выключено: <code>CODEROOM_LOG_CHATS=0</code> в .env'
        : total ? '' : '\n\nПока ни одного запроса через шлюз не прошло.';
      return edit(chatId, messageId, head + '\n\nНичего не найдено.' + why, kb([[btn('← Обновить', 'chats:0')]]));
    }

    const text = [head + `  <i>всего ${total}</i>`, '', ...chats.map((c) =>
      `<code>#${c.id}</code> ${when(c.at)} · ${esc(c.model)}${c.status >= 400 ? ' · ⚠ ' + c.status : ''}\n` +
      `    ${esc(short(c.prompt, 64) || '(пусто)')}\n` +
      `    <i>${esc(short(c.reply, 64) || '(нет ответа)')}</i>`,
    )].join('\n');

    /* callback_data ограничен 64 байтами — длинный запрос в кнопки не пихаем */
    const tail = keyId ? ':key:' + keyId : q && q.length <= 24 ? ':q:' + q : '';
    const nav = [];
    if (off > 0) nav.push(btn('← Новее', `chats:${Math.max(0, off - PAGE)}${tail}`));
    if (chats.length === PAGE) nav.push(btn('Старее →', `chats:${off + PAGE}${tail}`));

    const rows = chats.map((c) => [btn(`#${c.id} · ${short(c.prompt, 28) || c.model}`, 'chat:' + c.id)]);
    if (nav.length) rows.push(nav);
    rows.push([btn('🔄 Обновить', `chats:${off}${tail}`)]);

    return edit(chatId, messageId, text, kb(rows));
  }

  async function screenChat(chatId, messageId, id) {
    const c = getChat(id);
    if (!c) return edit(chatId, messageId, 'Чат не найден.', kb([[btn('← К чатам', 'chats:0')]]));

    const text = [
      `💬 <b>Чат #${c.id}</b>`,
      `${when(c.at)} · ${esc(c.model)} · ${esc(c.upstream)} · ${c.ms} мс · статус ${c.status}`,
      `ключ: ${esc(c.keyLabel || c.keyId)} · ${fmt(c.tokens.input)}↑ ${fmt(c.tokens.output)}↓${c.ip ? ' · ' + esc(c.ip) : ''}`,
      '',
      '<b>Запрос</b>',
      `<pre>${esc(short(c.prompt, 1200) || '(пусто)')}</pre>`,
      '<b>Ответ</b>',
      `<pre>${esc(short(c.reply, 1800) || '(пусто)')}</pre>`,
    ].join('\n');

    return edit(chatId, messageId, text, kb([
      [btn('🧵 Вся переписка', 'full:' + c.id), btn('🗑 Удалить', 'chat:del:' + c.id)],
      [btn('← К чатам', 'chats:0')],
    ]));
  }

  async function sendFullChat(chatId, id) {
    const c = getChat(id);
    if (!c) return send(chatId, 'Чат не найден.');
    if (!c.messages?.length) return send(chatId, 'Для этого чата переписка не сохранена.');

    const body = c.messages.map((m) =>
      `<b>${esc(m.role)}${m.name ? ' · ' + esc(m.name) : ''}</b>\n${esc(short(m.content, 900) || '(пусто)')}`,
    ).join('\n\n');
    return send(chatId, `🧵 <b>Чат #${c.id}</b> — ${c.messages.length} сообщений\n\n${body}`);
  }

  function statsText() {
    const st = stats({ top: 8 });
    const up = loadUpstreams();
    const db = store();

    const lines = [
      '📊 <b>Расход</b>',
      '',
      `ключей: ${st.keys} · запросов: ${st.requests}`,
      `токенов: ${fmt(st.input)}↑ ${fmt(st.output)}↓`,
      `чатов в логе: ${st.chats ?? countChats()}`,
      '',
      '<b>Апстримы</b>',
      ...Object.entries(up).map(([id, u]) =>
        `${u?.apiKeys?.length ? '✅' : '❌'} ${id} · ${u?.apiKeys?.length ?? 0} кл. · ${u?.models.length ?? 0} моделей`),
    ];

    if (st.byModel.length) {
      lines.push('', '<b>Топ моделей</b>');
      for (const m of st.byModel) {
        lines.push(`<code>${esc(m.model)}</code> · ${m.requests} зпр · ${fmt(m.input + m.output)} тк`);
      }
    }
    lines.push('', `<i>${esc(db.kind)}: ${esc(path.basename(db.file))}</i>`);
    return lines.join('\n');
  }


  /* ─────────────────────────  разбор команд  ───────────────────────── */

  async function edit(chatId, messageId, text, extra = {}) {
    if (!messageId) return send(chatId, text, extra);
    try {
      return await call('editMessageText', {
        chat_id: chatId, message_id: messageId, text,
        parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra,
      });
    } catch {
      return send(chatId, text, extra);   // «message is not modified» и прочее — просто шлём новое
    }
  }

  async function onCommand(msg) {
    const chatId = msg.chat.id;
    const raw = String(msg.text || '').trim();
    const [head, ...rest] = raw.split(/\s+/);
    const cmd = head.toLowerCase().replace(/@.*$/, '');
    const arg = rest.join(' ').trim();

    /* ждём подтверждения «удалить всё» (команда отменяет ожидание) */
    if (pending.get(chatId) === 'clearchats' && !raw.startsWith('/')) {
      pending.delete(chatId);
      if (/^(да|yes|y|стереть)$/i.test(raw)) {
        const n = deleteChats({ all: true });
        return send(chatId, `🗑 Удалено записей: ${n}`);
      }
      return send(chatId, 'Отменено.');
    }

    switch (cmd) {
      case '/start':
      case '/help':
        return send(chatId, HELP, kb([
          [btn('🔑 Ключи', 'keys'), btn('💬 Чаты', 'chats:0')],
          [btn('📊 Расход', 'stats'), btn('🩺 Состояние', 'health')],
        ]));

      case '/keys':
        return screenKeys(chatId, null);

      case '/new': {
        const parts = arg.split(/\s+/).filter(Boolean);
        let limit = 0;
        if (parts.length && /^\d+[km]?$/i.test(parts[parts.length - 1])) {
          const t = parts.pop().toLowerCase();
          limit = Number(t.replace(/[km]$/, '')) * (t.endsWith('m') ? 1e6 : t.endsWith('k') ? 1000 : 1);
        }
        const rec = createKey({ label: parts.join(' '), limitTokens: limit });
        return send(chatId,
          `✅ <b>Ключ создан</b>${rec.label ? ' · ' + esc(rec.label) : ''}\n\n<code>${esc(rec.key)}</code>\n\n` +
          `id <code>${rec.id}</code>${rec.limitTokens ? ` · лимит ${fmt(rec.limitTokens)} тк` : ''}`,
          kb([[btn('🔑 Все ключи', 'keys')]]));
      }

      case '/rm': {
        if (!arg) return send(chatId, 'Нужен id: <code>/rm a1b2c3d4</code>');
        const n = revokeKey(arg);
        return send(chatId, n ? `🗑 Удалено ключей: ${n}` : 'Ключ не найден.');
      }

      case '/off':
      case '/on': {
        if (!arg) return send(chatId, `Нужен id: <code>${cmd} a1b2c3d4</code>`);
        const ok = setKeyDisabled(arg, cmd === '/off');
        return send(chatId, ok
          ? (cmd === '/off' ? '⛔ Ключ выключен.' : '✅ Ключ включён.')
          : 'Ключ не найден.');
      }

      case '/stats':
        return send(chatId, statsText(), kb([[btn('🔄 Обновить', 'stats')]]));

      case '/health': {
        const up = loadUpstreams();
        const db = store();
        return send(chatId, [
          '🩺 <b>Состояние</b>',
          '',
          `база: <code>${esc(db.file)}</code> (${db.kind})`,
          `папка данных: <code>${esc(DATA_DIR)}</code>`,
          `логирование чатов: ${chatLogEnabled() ? 'включено' : 'выключено'}`,
          `ключей: ${listKeys().length} · чатов: ${countChats()}`,
          '',
          ...Object.entries(up).map(([id, u]) => `${u?.apiKeys?.length ? '✅' : '❌'} ${id} (${u?.apiKeys?.length ?? 0} кл.) — ${esc(u?.baseUrl ?? '')}`),
        ].join('\n'));
      }

      case '/chats':
        return screenChats(chatId, null, { offset: 0 });

      case '/chat': {
        if (!arg) return send(chatId, 'Нужен номер: <code>/chat 42</code>');
        return screenChat(chatId, null, arg.replace(/^#/, ''));
      }

      case '/find': {
        if (!arg) return send(chatId, 'Что искать? <code>/find текст</code>');
        return screenChats(chatId, null, { q: arg });
      }

      case '/clearchats':
        if (!countChats()) return send(chatId, 'История и так пуста.');
        pending.set(chatId, 'clearchats');
        return send(chatId, `Стереть всю историю чатов (${countChats()})? Напиши <b>да</b> для подтверждения.`);

      case '/id':
        return send(chatId, `Твой id: <code>${msg.from.id}</code>`);

      default:
        return send(chatId, 'Не знаю такой команды. /help');
    }
  }

  async function onCallback(cb) {
    const chatId = cb.message.chat.id;
    const mid = cb.message.message_id;
    const data = String(cb.data || '');
    const ack = (text) => call('answerCallbackQuery', { callback_query_id: cb.id, text }).catch(() => {});

    if (data === 'keys') { await ack(); return screenKeys(chatId, mid); }
    if (data === 'stats') { await ack(); return edit(chatId, mid, statsText(), kb([[btn('🔄 Обновить', 'stats')]])); }
    if (data === 'health') { await ack(); return onCommand({ chat: cb.message.chat, from: cb.from, text: '/health' }); }
    if (data === 'key:new') { await ack(); return send(chatId, 'Создать ключ: <code>/new метка 100k</code>'); }

    let m = /^key:(on|off|del|delok):(.+)$/.exec(data);
    if (m) {
      const [, action, id] = m;
      if (action === 'del') {
        await ack();
        return edit(chatId, mid, `Точно удалить ключ <code>${esc(id)}</code>? Отменить нельзя.`,
          kb([[btn('🗑 Да, удалить', 'key:delok:' + id), btn('← Назад', 'key:' + id)]]));
      }
      if (action === 'delok') {
        const n = revokeKey(id);
        await ack(n ? 'Удалён' : 'Не найден');
        return screenKeys(chatId, mid);
      }
      setKeyDisabled(id, action === 'off');
      await ack(action === 'off' ? 'Выключен' : 'Включён');
      return screenKey(chatId, mid, id);
    }

    m = /^key:(.+)$/.exec(data);
    if (m) { await ack(); return screenKey(chatId, mid, m[1]); }

    m = /^chats:(\d+)(?::key:(.+))?(?::q:(.+))?$/.exec(data);
    if (m) {
      await ack();
      return screenChats(chatId, mid, { offset: Number(m[1]), keyId: m[2] || '', q: m[3] || '' });
    }

    m = /^chats:key:(.+):(\d+)$/.exec(data);
    if (m) { await ack(); return screenChats(chatId, mid, { keyId: m[1], offset: Number(m[2]) }); }

    m = /^chat:del:(\d+)$/.exec(data);
    if (m) {
      deleteChats({ id: m[1] });
      await ack('Удалён');
      return screenChats(chatId, mid, { offset: 0 });
    }

    m = /^chat:(\d+)$/.exec(data);
    if (m) { await ack(); return screenChat(chatId, mid, m[1]); }

    m = /^full:(\d+)$/.exec(data);
    if (m) { await ack(); return sendFullChat(chatId, m[1]); }

    return ack();
  }

  async function handle(update) {
    const from = update.message?.from ?? update.callback_query?.from;
    const chat = update.message?.chat ?? update.callback_query?.message?.chat;
    if (!from || !chat) return;

    if (!allowed.has(String(from.id))) {
      onLog(`  чужой: ${from.id} (@${from.username ?? '—'})`);
      if (update.message) {
        await send(chat.id,
          'Этот бот только для владельца шлюза.\n\n' +
          `Твой id: <code>${from.id}</code>\n` +
          'Чтобы дать доступ — добавь его в <code>TELEGRAM_ADMIN_IDS</code> в server/.env и перезапусти бота.');
      }
      return;
    }

    try {
      if (update.callback_query) await onCallback(update.callback_query);
      else if (update.message?.text) await onCommand(update.message);
    } catch (e) {
      onLog('  ошибка обработки: ' + e.message);
      await send(chat.id, '⚠ Ошибка: ' + esc(e.message)).catch(() => {});
    }
  }

  async function poll() {
    let backoff = 1000;
    let conflictLogged = false;
    while (running) {
      try {
        const updates = await call('getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'callback_query'] });
        conflictLogged = false;
        backoff = 1000;
        for (const u of updates) {
          offset = u.update_id + 1;
          await handle(u);
        }
      } catch (e) {
        if (!running) break;
        if (/409/.test(e.message)) {
          if (!conflictLogged) {
            onLog('  ⚠ бот уже запущен где-то ещё (409): Telegram не разрешает несколько polling-процессов. Повторю попытку через 60 сек.');
            conflictLogged = true;
          } else {
            onLog('  ⚠ повторный конфликт бота (409) — жду 60 сек.');
          }
          await new Promise((r) => setTimeout(r, 60_000));
          continue;
        }
        conflictLogged = false;
        onLog('  сеть: ' + e.message);
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  }

  return {
    get me() { return me; },
    async start() {
      me = await call('getMe');
      await call('setMyCommands', {
        commands: [
          { command: 'keys', description: 'ключи' },
          { command: 'new', description: 'новый ключ: /new метка 100k' },
          { command: 'chats', description: 'история чатов' },
          { command: 'find', description: 'поиск по чатам' },
          { command: 'stats', description: 'расход' },
          { command: 'health', description: 'состояние шлюза' },
          { command: 'help', description: 'все команды' },
        ],
      }).catch(() => {});
      running = true;
      poll();
      return me;
    },
    stop() { running = false; },
    handle,
  };
}


/** Запуск из server.mjs или напрямую: node bot.mjs */
export async function startBotFromEnv({ quiet = false } = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;

  const admins = String(process.env.TELEGRAM_ADMIN_IDS || '')
    .split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);

  const bot = createBot({ token, admins, onLog: quiet ? () => {} : console.log });
  const me = await bot.start();
  if (!quiet) {
    console.log(`  Телеграм-бот:    @${me.username}` + (admins.length ? '' : '  ⚠ TELEGRAM_ADMIN_IDS пуст — напиши боту /start, он покажет твой id'));
  }
  return bot;
}


const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  loadDotenv(path.join(path.dirname(fileURLToPath(import.meta.url)), '.env'));
  const bot = await startBotFromEnv();
  if (!bot) {
    console.error('\n  Нет TELEGRAM_BOT_TOKEN в server/.env\n' +
      '  Получи токен у @BotFather и добавь:\n' +
      '    TELEGRAM_BOT_TOKEN=123456:AA...\n' +
      '    TELEGRAM_ADMIN_IDS=твой_id\n');
    process.exit(1);
  }
  console.log('\n  CodeRoom Bot');
  console.log('  ─────────────────────────────────────────────');
  console.log('  @' + bot.me.username + ' на связи. Ctrl+C — остановить.\n');
  process.on('SIGINT', () => { bot.stop(); console.log('\n  Остановлено.'); process.exit(0); });
}
