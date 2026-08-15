import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';


function quietSqliteWarning() {
  const prev = process.listeners('warning');
  process.removeAllListeners('warning');
  process.on('warning', (w) => {
    if (w.name === 'ExperimentalWarning' && /SQLite/i.test(w.message)) return;
    if (prev.length) for (const l of prev) l(w);
    else console.warn(`${w.name}: ${w.message}`);
  });
}

let DatabaseSync = null;
try {
  quietSqliteWarning();
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  DatabaseSync = null;
}

export const sqliteAvailable = Boolean(DatabaseSync);


const SCHEMA = `
CREATE TABLE IF NOT EXISTS keys (
  id           TEXT PRIMARY KEY,
  key          TEXT UNIQUE NOT NULL,
  label        TEXT NOT NULL DEFAULT '',
  limit_tokens INTEGER NOT NULL DEFAULT 0,
  disabled     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  req          INTEGER NOT NULL DEFAULT 0,
  tok_in       INTEGER NOT NULL DEFAULT 0,
  tok_out      INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS usage_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id   TEXT NOT NULL,
  model    TEXT,
  upstream TEXT,
  tok_in   INTEGER NOT NULL DEFAULT 0,
  tok_out  INTEGER NOT NULL DEFAULT 0,
  at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_key ON usage_log(key_id);
CREATE INDEX IF NOT EXISTS idx_usage_at  ON usage_log(at);

CREATE TABLE IF NOT EXISTS chats (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id    TEXT NOT NULL,
  key_label TEXT NOT NULL DEFAULT '',
  model     TEXT,
  upstream  TEXT,
  status    INTEGER NOT NULL DEFAULT 0,
  ms        INTEGER NOT NULL DEFAULT 0,
  tok_in    INTEGER NOT NULL DEFAULT 0,
  tok_out   INTEGER NOT NULL DEFAULT 0,
  ip        TEXT,
  prompt    TEXT NOT NULL DEFAULT '',
  reply     TEXT NOT NULL DEFAULT '',
  messages  TEXT,
  at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chats_at  ON chats(at);
CREATE INDEX IF NOT EXISTS idx_chats_key ON chats(key_id);
`;

/* Ограничения на то, сколько текста переписки храним. */
const MAX_PROMPT = 4000;
const MAX_REPLY = 8000;
const MAX_MESSAGES = 40_000;
const MAX_MESSAGE_TEXT = 1500;

const cut = (s, n) => {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n) + '\n…[обрезано]' : t;
};

const toChat = (r) => r && ({
  id: r.id,
  keyId: r.key_id,
  keyLabel: r.key_label ?? '',
  model: r.model ?? '(?)',
  upstream: r.upstream ?? '(?)',
  status: Number(r.status ?? 0),
  ms: Number(r.ms ?? 0),
  tokens: { input: Number(r.tok_in ?? 0), output: Number(r.tok_out ?? 0) },
  ip: r.ip ?? '',
  prompt: r.prompt ?? '',
  reply: r.reply ?? '',
  messages: r.messages ? safeJson(r.messages) : null,
  at: r.at,
});

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

/*
  Переписку укладываем в лимит, выбрасывая старые сообщения целиком.
  Резать саму JSON-строку нельзя — она перестанет разбираться при чтении.
*/
function packMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) return null;

  let list = messages.map((m) => ({
    role: m?.role ?? '?',
    ...(m?.name ? { name: String(m.name).slice(0, 60) } : {}),
    content: cut(m?.content, MAX_MESSAGE_TEXT),
  }));

  let json = JSON.stringify(list);
  while (json.length > MAX_MESSAGES && list.length > 1) {
    list = list.slice(1);
    json = JSON.stringify(list);
  }
  return json;
}

const normChat = (c) => ({
  keyId: String(c.keyId ?? ''),
  keyLabel: String(c.keyLabel ?? '').slice(0, 60),
  model: c.model ?? null,
  upstream: c.upstream ?? null,
  status: Number(c.status) || 0,
  ms: Number(c.ms) || 0,
  tokIn: Number(c.tokens?.input) || 0,
  tokOut: Number(c.tokens?.output) || 0,
  ip: String(c.ip ?? '').slice(0, 45),
  prompt: cut(c.prompt, MAX_PROMPT),
  reply: cut(c.reply, MAX_REPLY),
  messages: packMessages(c.messages),
  at: c.at ?? new Date().toISOString(),
});

const toRec = (r) => r && ({
  id: r.id,
  key: r.key,
  label: r.label ?? '',
  limitTokens: Number(r.limit_tokens ?? 0),
  disabled: Boolean(r.disabled),
  createdAt: r.created_at,
  used: { requests: Number(r.req ?? 0), input: Number(r.tok_in ?? 0), output: Number(r.tok_out ?? 0) },
});

export function openStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return DatabaseSync ? sqliteStore(dir) : jsonStore(dir);
}


function sqliteStore(dir) {
  const file = path.join(dir, 'coderoom.db');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 4000');
  db.exec(SCHEMA);
  try { fs.chmodSync(file, 0o600); } catch { /* Windows */ }

  migrateFromJson(dir, {
    count: () => db.prepare('SELECT COUNT(*) AS n FROM keys').get().n,
    insert: (k) => db.prepare(
      'INSERT OR IGNORE INTO keys (id,key,label,limit_tokens,disabled,created_at,req,tok_in,tok_out) VALUES (?,?,?,?,?,?,?,?,?)',
    ).run(k.id, k.key, k.label ?? '', k.limitTokens ?? 0, k.disabled ? 1 : 0,
      k.createdAt ?? new Date().toISOString(), k.used?.requests ?? 0, k.used?.input ?? 0, k.used?.output ?? 0),
  });

  const q = {
    all: db.prepare('SELECT * FROM keys ORDER BY created_at'),
    byKey: db.prepare('SELECT * FROM keys WHERE key = ?'),
    byId: db.prepare('SELECT * FROM keys WHERE id = ?'),
    insert: db.prepare('INSERT INTO keys (id,key,label,limit_tokens,disabled,created_at) VALUES (?,?,?,?,0,?)'),
    del: db.prepare('DELETE FROM keys WHERE id = ? OR key = ? OR key LIKE ?'),
    delUsage: db.prepare('DELETE FROM usage_log WHERE key_id NOT IN (SELECT id FROM keys)'),
    setDis: db.prepare('UPDATE keys SET disabled = ? WHERE id = ? OR key = ?'),
    bump: db.prepare('UPDATE keys SET req = req + 1, tok_in = tok_in + ?, tok_out = tok_out + ? WHERE id = ?'),
    log: db.prepare('INSERT INTO usage_log (key_id,model,upstream,tok_in,tok_out,at) VALUES (?,?,?,?,?,?)'),
    totals: db.prepare('SELECT COUNT(*) AS keys_n, COALESCE(SUM(req),0) AS req, COALESCE(SUM(tok_in),0) AS tok_in, COALESCE(SUM(tok_out),0) AS tok_out FROM keys'),
    byModel: db.prepare('SELECT model, upstream, COUNT(*) AS req, SUM(tok_in) AS tok_in, SUM(tok_out) AS tok_out FROM usage_log GROUP BY model, upstream ORDER BY (SUM(tok_in)+SUM(tok_out)) DESC LIMIT ?'),
    recent: db.prepare('SELECT model, upstream, tok_in, tok_out, at FROM usage_log ORDER BY id DESC LIMIT ?'),

    chatAdd: db.prepare(
      'INSERT INTO chats (key_id,key_label,model,upstream,status,ms,tok_in,tok_out,ip,prompt,reply,messages,at) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ),
    chatList: db.prepare('SELECT id,key_id,key_label,model,upstream,status,ms,tok_in,tok_out,ip,prompt,reply,at FROM chats ORDER BY id DESC LIMIT ? OFFSET ?'),
    chatListKey: db.prepare('SELECT id,key_id,key_label,model,upstream,status,ms,tok_in,tok_out,ip,prompt,reply,at FROM chats WHERE key_id = ? ORDER BY id DESC LIMIT ? OFFSET ?'),
    chatSearch: db.prepare('SELECT id,key_id,key_label,model,upstream,status,ms,tok_in,tok_out,ip,prompt,reply,at FROM chats WHERE prompt LIKE ? OR reply LIKE ? ORDER BY id DESC LIMIT ? OFFSET ?'),
    chatGet: db.prepare('SELECT * FROM chats WHERE id = ?'),
    chatCount: db.prepare('SELECT COUNT(*) AS n FROM chats'),
    chatDel: db.prepare('DELETE FROM chats WHERE id = ?'),
    chatDelAll: db.prepare('DELETE FROM chats'),
    chatDelOld: db.prepare('DELETE FROM chats WHERE at < ?'),
    chatDelKey: db.prepare('DELETE FROM chats WHERE key_id = ?'),
  };

  return {
    file, kind: 'sqlite',

    createKey({ label = '', limitTokens = 0 } = {}) {
      const rec = {
        id: crypto.randomBytes(4).toString('hex'),
        key: 'cr-' + crypto.randomBytes(24).toString('base64url'),
        label: String(label || '').slice(0, 60),
        limitTokens: Math.max(0, Number(limitTokens) || 0),
        disabled: false,
        createdAt: new Date().toISOString(),
        used: { requests: 0, input: 0, output: 0 },
      };
      q.insert.run(rec.id, rec.key, rec.label, rec.limitTokens, rec.createdAt);
      return rec;
    },

    listKeys: () => q.all.all().map(toRec),
    findKey: (raw) => (raw ? toRec(q.byKey.get(raw)) ?? null : null),

    revokeKey(idOrKey) {
      const s = String(idOrKey ?? '');
      if (!s) return 0;
      const n = q.del.run(s, s, '%' + s).changes;
      if (n) q.delUsage.run();
      return n;
    },

    setDisabled(idOrKey, v) {
      const s = String(idOrKey ?? '');
      return q.setDis.run(v ? 1 : 0, s, s).changes > 0;
    },

    recordUsage(id, usage, meta = {}) {
      const i = Number(usage?.input) || 0;
      const o = Number(usage?.output) || 0;
      q.bump.run(i, o, id);
      q.log.run(id, meta.model ?? null, meta.upstream ?? null, i, o, new Date().toISOString());
    },

    stats({ top = 10, recent = 0 } = {}) {
      const t = q.totals.get();
      return {
        keys: Number(t.keys_n), requests: Number(t.req),
        input: Number(t.tok_in), output: Number(t.tok_out),
        byModel: q.byModel.all(top).map((r) => ({
          model: r.model ?? '(?)', upstream: r.upstream ?? '(?)',
          requests: Number(r.req), input: Number(r.tok_in ?? 0), output: Number(r.tok_out ?? 0),
        })),
        recent: recent ? q.recent.all(recent) : [],
        chats: Number(q.chatCount.get().n),
      };
    },

    logChat(chat) {
      const c = normChat(chat);
      const r = q.chatAdd.run(c.keyId, c.keyLabel, c.model, c.upstream, c.status, c.ms,
        c.tokIn, c.tokOut, c.ip, c.prompt, c.reply, c.messages, c.at);
      return Number(r.lastInsertRowid);
    },

    listChats({ limit = 20, offset = 0, keyId = '', q: query = '' } = {}) {
      const lim = Math.max(1, Math.min(200, Number(limit) || 20));
      const off = Math.max(0, Number(offset) || 0);
      const rows = query
        ? q.chatSearch.all('%' + query + '%', '%' + query + '%', lim, off)
        : keyId
          ? q.chatListKey.all(keyId, lim, off)
          : q.chatList.all(lim, off);
      return rows.map(toChat);
    },

    getChat: (id) => toChat(q.chatGet.get(Number(id))) ?? null,
    countChats: () => Number(q.chatCount.get().n),

    deleteChats({ id, keyId, before, all } = {}) {
      if (id) return q.chatDel.run(Number(id)).changes;
      if (keyId) return q.chatDelKey.run(String(keyId)).changes;
      if (before) return q.chatDelOld.run(String(before)).changes;
      if (all) return q.chatDelAll.run().changes;
      return 0;
    },

    close: () => db.close(),
  };
}

function migrateFromJson(dir, { count, insert }) {
  const legacy = path.join(dir, 'keys.json');
  if (!fs.existsSync(legacy)) return;
  try {
    if (count() > 0) return;
    const data = JSON.parse(fs.readFileSync(legacy, 'utf8'));
    for (const k of data.keys ?? []) if (k?.id && k?.key) insert(k);
    fs.renameSync(legacy, legacy + '.migrated');
  } catch {
  }
}


function jsonStore(dir) {
  const file = path.join(dir, 'keys.json');
  const read = () => {
    try {
      const db = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(db.keys)) db.keys = [];
      return db;
    } catch { return { keys: [], log: [] }; }
  };
  const write = (db) => {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch { /* Windows */ }
  };

  return {
    file, kind: 'json',

    createKey({ label = '', limitTokens = 0 } = {}) {
      const db = read();
      const rec = {
        id: crypto.randomBytes(4).toString('hex'),
        key: 'cr-' + crypto.randomBytes(24).toString('base64url'),
        label: String(label || '').slice(0, 60),
        limitTokens: Math.max(0, Number(limitTokens) || 0),
        disabled: false,
        createdAt: new Date().toISOString(),
        used: { requests: 0, input: 0, output: 0 },
      };
      db.keys.push(rec);
      write(db);
      return rec;
    },

    listKeys: () => read().keys,
    findKey: (raw) => (raw ? read().keys.find((k) => k.key === raw) ?? null : null),

    revokeKey(idOrKey) {
      const db = read();
      const before = db.keys.length;
      db.keys = db.keys.filter((k) => k.id !== idOrKey && k.key !== idOrKey && !k.key.endsWith(String(idOrKey)));
      write(db);
      return before - db.keys.length;
    },

    setDisabled(idOrKey, v) {
      const db = read();
      const k = db.keys.find((x) => x.id === idOrKey || x.key === idOrKey);
      if (!k) return false;
      k.disabled = Boolean(v);
      write(db);
      return true;
    },

    recordUsage(id, usage, meta = {}) {
      const db = read();
      const k = db.keys.find((x) => x.id === id);
      if (!k) return;
      k.used.requests += 1;
      k.used.input += Number(usage?.input) || 0;
      k.used.output += Number(usage?.output) || 0;
      db.log = [...(db.log ?? []).slice(-999), {
        key_id: id, model: meta.model ?? null, upstream: meta.upstream ?? null,
        tok_in: Number(usage?.input) || 0, tok_out: Number(usage?.output) || 0,
        at: new Date().toISOString(),
      }];
      write(db);
    },

    stats({ top = 10, recent = 0 } = {}) {
      const db = read();
      const agg = new Map();
      for (const r of db.log ?? []) {
        const key = `${r.model} ${r.upstream}`;
        const a = agg.get(key) ?? { model: r.model ?? '(?)', upstream: r.upstream ?? '(?)', requests: 0, input: 0, output: 0 };
        a.requests++; a.input += r.tok_in ?? 0; a.output += r.tok_out ?? 0;
        agg.set(key, a);
      }
      return {
        keys: db.keys.length,
        requests: db.keys.reduce((s, k) => s + k.used.requests, 0),
        input: db.keys.reduce((s, k) => s + k.used.input, 0),
        output: db.keys.reduce((s, k) => s + k.used.output, 0),
        byModel: [...agg.values()].sort((a, b) => (b.input + b.output) - (a.input + a.output)).slice(0, top),
        recent: recent ? (db.log ?? []).slice(-recent).reverse() : [],
        chats: (db.chats ?? []).length,
      };
    },

    logChat(chat) {
      const c = normChat(chat);
      const db = read();
      const chats = db.chats ?? [];
      const id = (chats.length ? chats[chats.length - 1].id : 0) + 1;
      chats.push({
        id, key_id: c.keyId, key_label: c.keyLabel, model: c.model, upstream: c.upstream,
        status: c.status, ms: c.ms, tok_in: c.tokIn, tok_out: c.tokOut, ip: c.ip,
        prompt: c.prompt, reply: c.reply, messages: c.messages, at: c.at,
      });
      db.chats = chats.slice(-500);
      write(db);
      return id;
    },

    listChats({ limit = 20, offset = 0, keyId = '', q: query = '' } = {}) {
      const all = (read().chats ?? []).slice().reverse();
      const low = String(query).toLowerCase();
      const hit = (c) => (!keyId || c.key_id === keyId) &&
        (!low || String(c.prompt).toLowerCase().includes(low) || String(c.reply).toLowerCase().includes(low));
      return all.filter(hit).slice(offset, offset + limit).map(toChat);
    },

    getChat: (id) => toChat((read().chats ?? []).find((c) => c.id === Number(id))) ?? null,
    countChats: () => (read().chats ?? []).length,

    deleteChats({ id, keyId, before, all } = {}) {
      const db = read();
      const chats = db.chats ?? [];
      const keep = all ? []
        : id ? chats.filter((c) => c.id !== Number(id))
          : keyId ? chats.filter((c) => c.key_id !== keyId)
            : before ? chats.filter((c) => String(c.at) >= String(before))
              : chats;
      const n = chats.length - keep.length;
      if (n) { db.chats = keep; write(db); }
      return n;
    },

    close() {},
  };
}
