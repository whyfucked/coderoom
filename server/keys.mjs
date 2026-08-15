#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadDotenv, createKey, listKeys, revokeKey, setKeyDisabled, loadUpstreams, stats, store,
  listChats, getChat, countChats, deleteChats, chatLogEnabled, DATA_DIR,
} from './gateway.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
loadDotenv(path.join(here, '.env'));

const fmt = (n) => (n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n));

const argv = process.argv.slice(2);
const flags = {};
const rest = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--label' || argv[i] === '-l') flags.label = argv[++i];
  else if (argv[i] === '--limit') flags.limit = Number(argv[++i]);
  else rest.push(argv[i]);
}
const action = rest[0] || 'ls';

if (action === 'new' || action === 'add' || action === 'create') {
  const rec = createKey({ label: flags.label || rest[1] || '', limitTokens: flags.limit || 0 });
  console.log('\n✓ ключ создан' + (rec.label ? `  (${rec.label})` : ''));
  console.log('  ' + rec.key);
  console.log('  id ' + rec.id + (rec.limitTokens ? ` · лимит ${fmt(rec.limitTokens)} токенов` : '') + '\n');
} else if (action === 'ls' || action === 'list') {
  const keys = listKeys();
  if (!keys.length) {
    console.log('\nКлючей нет. Создать: node keys.mjs new --label имя\n');
  } else {
    console.log('\nКлючи CodeRoom:\n');
    for (const k of keys) {
      const used = k.used.input + k.used.output;
      console.log(`  ${k.id}  ${(k.label || '—').padEnd(14)} cr-…${k.key.slice(-6)}  ` +
        `${fmt(used)} тк · ${k.used.requests} зпр${k.limitTokens ? ` / лимит ${fmt(k.limitTokens)}` : ''}${k.disabled ? ' · выкл' : ''}`);
    }
    console.log('\nУдалить: node keys.mjs rm <id>\n');
  }
} else if (action === 'rm' || action === 'del' || action === 'revoke') {
  const id = rest[1];
  if (!id) { console.log('Укажи id: node keys.mjs rm <id>'); process.exit(1); }
  const n = revokeKey(id);
  console.log(n ? `✓ удалено ключей: ${n}` : 'ключ не найден');
} else if (action === 'status') {
  const up = loadUpstreams();
  const st = stats({ top: 8 });
  const db = store();
  console.log('\nCodeRoom Gateway');
  console.log('  БД:     ' + db.file + `  (${db.kind})`);
  console.log('  ключей: ' + st.keys + ' · запросов: ' + st.requests +
    ' · расход: ' + fmt(st.input) + '↑ ' + fmt(st.output) + '↓');
  console.log('');
  for (const [id, u] of Object.entries(up)) {
    const keyCount = u?.apiKeys?.length || 0;
    console.log(`  ${id.padEnd(12)} ${keyCount ? `ключей: ${keyCount}` : 'нет ключа'}  (${u?.models.length} моделей)`);
  }
  if (st.byModel.length) {
    console.log('\n  по моделям:');
    const w = Math.max(...st.byModel.map((m) => m.model.length));
    for (const m of st.byModel) {
      console.log(`    ${m.model.padEnd(w)}  ${String(m.requests).padStart(4)} зпр  ` +
        `${fmt(m.input + m.output).padStart(7)} тк  ${m.upstream}`);
    }
  }
  console.log('');
} else if (action === 'stats') {
  const st = stats({ top: 20, recent: 10 });
  console.log('\nРасход: ' + st.requests + ' запросов · ' + fmt(st.input) + '↑ ' + fmt(st.output) + '↓\n');
  if (!st.byModel.length) console.log('  пока пусто\n');
  else {
    const w = Math.max(...st.byModel.map((m) => m.model.length));
    for (const m of st.byModel) {
      console.log(`  ${m.model.padEnd(w)}  ${String(m.requests).padStart(4)} зпр  ${fmt(m.input + m.output).padStart(7)} тк  ${m.upstream}`);
    }
    if (st.recent.length) {
      console.log('\n  последние запросы:');
      for (const r of st.recent) {
        console.log(`    ${String(r.at).slice(0, 19).replace('T', ' ')}  ${r.model ?? '(?)'}  ${(r.tok_in ?? 0) + (r.tok_out ?? 0)} тк`);
      }
    }
    console.log('');
  }
} else if (action === 'on' || action === 'off') {
  const id = rest[1];
  if (!id) { console.log(`Укажи id: node keys.mjs ${action} <id>`); process.exit(1); }
  const ok = setKeyDisabled(id, action === 'off');
  console.log(ok ? (action === 'off' ? '⛔ выключен' : '✓ включён') : 'ключ не найден');
} else if (action === 'chats') {
  const n = Number(rest[1]) || 20;
  const chats = listChats({ limit: n });
  if (!chatLogEnabled()) console.log('\n(логирование выключено: CODEROOM_LOG_CHATS=0)');
  if (!chats.length) {
    console.log('\nЧатов нет.\n');
  } else {
    console.log(`\nПоследние чаты (всего ${countChats()}):\n`);
    for (const c of chats) {
      const when = String(c.at).slice(0, 16).replace('T', ' ');
      const line = String(c.prompt).replace(/\s+/g, ' ').slice(0, 60);
      console.log(`  #${String(c.id).padEnd(5)} ${when}  ${c.model.padEnd(18)} ${(c.keyLabel || c.keyId).padEnd(12)} ${line}`);
    }
    console.log('\nПоказать целиком: node keys.mjs chat <id>\n');
  }
} else if (action === 'chat') {
  const c = getChat(rest[1]);
  if (!c) { console.log('Чат не найден'); process.exit(1); }
  console.log(`\nЧат #${c.id} · ${String(c.at).slice(0, 19).replace('T', ' ')} · ${c.model} (${c.upstream})`);
  console.log(`ключ ${c.keyLabel || c.keyId} · ${fmt(c.tokens.input)}↑ ${fmt(c.tokens.output)}↓ · ${c.ms} мс · статус ${c.status}\n`);
  for (const m of c.messages ?? [{ role: 'user', content: c.prompt }, { role: 'assistant', content: c.reply }]) {
    console.log(`── ${m.role} ${'─'.repeat(Math.max(0, 60 - m.role.length))}`);
    console.log(m.content || '(пусто)');
    console.log('');
  }
} else if (action === 'rmchats') {
  const n = deleteChats({ all: true });
  console.log(`удалено записей: ${n}`);
} else {
  console.log('Использование: node keys.mjs new|ls|rm|on|off|status|stats|chats|chat|rmchats');
}
