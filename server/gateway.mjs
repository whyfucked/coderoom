import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openStore, sqliteAvailable } from './db.mjs';

// Model health checker — runs every 30 min, checks which models work
const MODEL_HEALTH_FILE = 'model-health.json';
const HEALTH_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const HEALTH_TIMEOUT_MS = 15000;

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.CODEROOM_GATEWAY_DATA
  ? path.resolve(process.env.CODEROOM_GATEWAY_DATA)
  : path.join(HERE, 'data');
const HEALTH_FILE_PATH = path.join(DATA_DIR, MODEL_HEALTH_FILE);

function loadModelHealth() {
  try {
    return JSON.parse(fs.readFileSync(HEALTH_FILE_PATH, 'utf8'));
  } catch {
    return { checkedAt: null, models: {} };
  }
}

function saveModelHealth(data) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(HEALTH_FILE_PATH, JSON.stringify(data, null, 2), { mode: 0o600 });
  } catch { /* ignore */ }
}

async function checkModelHealth(upstream, modelId, apiKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(upstream.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'User-Agent': upstream.userAgent,
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 5,
        stream: false,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    return { ok: res.ok, status: res.status, error: res.ok ? null : `HTTP ${res.status}` };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, status: 0, error: e.name === 'AbortError' ? 'timeout' : e.message };
  }
}

async function runModelHealthCheck() {
  const up = loadUpstreams();
  const health = loadModelHealth();
  const now = new Date().toISOString();
  const results = { ...health.models };

  for (const [upId, upstream] of Object.entries(up)) {
    if (!upstream?.apiKeys?.length) continue;
    for (const modelId of upstream.models) {
      let result = { ok: false, status: 0, error: 'нет доступных API-ключей' };
      for (const apiKey of nextUpstreamKeys(upstream)) {
        result = await checkModelHealth(upstream, modelId, apiKey);
        if (result.ok) break;
        if (RETRYABLE_UPSTREAM_STATUSES.has(result.status)) coolDownUpstreamKey(upstream.id, apiKey);
      }
      results[toPublicId(modelId)] = {
        upstream: upId,
        ok: result.ok,
        status: result.status,
        error: result.error,
        checkedAt: now,
      };
    }
  }

  saveModelHealth({ checkedAt: now, models: results });
  console.log(`  [health] Проверено моделей: ${Object.keys(results).length}, рабочих: ${Object.values(results).filter(r => r.ok).length}`);
}

function startModelHealthChecker() {
  // Run immediately on startup
  runModelHealthCheck().catch(() => {});
  // Then every 30 minutes
  return setInterval(() => {
    runModelHealthCheck().catch(() => {});
  }, HEALTH_INTERVAL_MS);
}

export function getModelHealth() {
  return loadModelHealth();
}
const UPSTREAMS_FILE = path.join(DATA_DIR, 'upstreams.json');
const PUBLIC_KEYS_FILE = path.join(DATA_DIR, 'public-keys.json');
const upstreamCursor = new Map();
const keyCooldowns = new Map();
const RETRYABLE_UPSTREAM_STATUSES = new Set([401, 403, 408, 409, 425, 429, 500, 502, 503, 504]);
const KEY_COOLDOWN_MS = 60_000;

export { sqliteAvailable };

export const GATEWAY_UPSTREAMS = {
  seekai: {
    label: 'SeekAI (seekai.cc)',
    baseUrl: 'https://seekai.cc',
    keyEnv: 'SEEKAI_API_KEY',
    userAgent: 'claude-cli/2.0.1 (external, cli)',
    models: [
      'claude-fable-5', 'claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5', 'claude-sonnet-5',
      'gpt-5-5', 'gpt-5.6', 'gpt-5.6-terra', 'gpt-5.6-luna',
      'gemini-3-1-pro', 'gemini-3-flash', 'gemini-3-pro', 'qwen-3-max', 'glm-5-2',
      'grok-4.5', 'grok-4.6', 'deepseek-v4-flash', 'DeepSeek-V4-Flash-0731',
      'deepseek-v4-pro', 'deepseek-v4-pro-0813',
    ],
  },
  bluesminds: {
    label: 'BluesMinds (api.bluesminds.com)',
    baseUrl: 'https://api.bluesminds.com',
    keyEnv: 'BLUESMINDS_API_KEY',
    userAgent: 'claude-cli/2.0.1 (external, cli)',
    models: [
      'gemma-4',
      'gemma-4-26b',
      'google/codegemma-7b',
      'google/diffusiongemma-26b-a4b-it',
      'google/gemma-2-2b-it',
      'google/gemma-3-12b-it',
      'openai/gpt-oss-120b',
      'openai/gpt-oss-20b',
      'qwen/qwen3-coder-480b-a35b-instruct',
      'qwen/qwen3-next-80b-a3b-instruct',
      'qwen/qwen3.5-122b-a10b',
      'qwen/qwen3.5-397b-a17b',
      'qwen2.5',
      'z-ai/glm-5.1',
      'z-ai/glm-5.2',
    ],
  },
  nvidia: {
    label: 'NVIDIA NIM (integrate.api.nvidia.com)',
    baseUrl: 'https://integrate.api.nvidia.com',
    keyEnv: 'NVIDIA_API_KEY',
    userAgent: 'claude-cli/2.0.1 (external, cli)',
    defaultParams: () =>
      /^(0|false|no)$/i.test(String(process.env.NVIDIA_ENABLE_THINKING ?? ''))
        ? {}
        : { chat_template_kwargs: { enable_thinking: true } },
    // Только Nemotron: остальное у NVIDIA — те же чужие модели, что уже есть
    // на других апстримах, и держать их в двух местах смысла нет.
    models: [
      'nvidia/nemotron-3-ultra-550b-a55b',
      'nvidia/nemotron-3-super-120b-a12b',
      'nvidia/nemotron-3-nano-30b-a3b',
      'nvidia/llama-3.3-nemotron-super-49b-v1.5',
      'nvidia/llama-3.3-nemotron-super-49b-v1',
      'nvidia/llama-3.1-nemotron-70b-instruct',
      'nvidia/nvidia-nemotron-nano-9b-v2',
    ],
  },
  hcnsec: {
    label: 'HCN (api.hcnsec.cn)',
    baseUrl: 'https://api.hcnsec.cn',
    keyEnv: 'HCNSEC_API_KEY',
    userAgent: 'claude-cli/2.0.1 (external, cli)',
    // Только чат: картинки/аудио (step-image-edit, stepaudio-*) убраны —
    // клиент у нас текстовый, а в списке моделей они только мешали.
    models: [
      'auto', 'DeepSeek-V4-Flash', 'DeepSeek-V4-Pro', 'glm-5.1', 'glm-5.2',
      'kat-coder-pro-v2.5', 'Kimi-K2.6', 'MiniMax-M3', 'Qwen3.5-397B-A17B',
      'Qwen3.6-35B-A3B', 'sensenova-6.7-flash-lite',
      'step-3.5-flash', 'step-3.5-flash-2603', 'step-3.7-flash', 'step-router-v1',
    ],
  },
};

function parseApiKeys(value) {
  if (Array.isArray(value)) return [...new Set(value.map(String).map((v) => v.trim()).filter(Boolean))];
  const raw = String(value || '').trim();
  if (!raw) return [];
  if (raw.startsWith('[')) {
    try { return parseApiKeys(JSON.parse(raw)); } catch { /* use separated format below */ }
  }
  return [...new Set(raw.split(/[\s,;]+/).map((v) => v.trim()).filter(Boolean))];
}

function nextUpstreamKeys(upstream) {
  const keys = upstream?.apiKeys || [];
  if (!keys.length) return [];
  const start = upstreamCursor.get(upstream.id) || 0;
  upstreamCursor.set(upstream.id, (start + 1) % keys.length);
  const ordered = keys.map((_, i) => keys[(start + i) % keys.length]);
  const now = Date.now();
  const ready = ordered.filter((key) => (keyCooldowns.get(`${upstream.id}:${key}`) || 0) <= now);
  return ready.length ? ready : ordered;
}

function coolDownUpstreamKey(upstreamId, apiKey) {
  keyCooldowns.set(`${upstreamId}:${apiKey}`, Date.now() + KEY_COOLDOWN_MS);
}


/**
 * Публичное имя → внутреннее имя апстрима.
 *
 * Клиент никогда не видит вендорских путей вида «nvidia/…» — только короткие
 * публичные id. Каждый алиас обязан указывать на модель, которая реально есть
 * в GATEWAY_UPSTREAMS (это проверяет тест).
 */
export const MODEL_ALIASES = {
  // — Nvidia (Nemotron) —
  'nemotron-3-ultra-550b': 'nvidia/nemotron-3-ultra-550b-a55b',
  'nemotron-3-super-120b': 'nvidia/nemotron-3-super-120b-a12b',
  'nemotron-3-nano-30b': 'nvidia/nemotron-3-nano-30b-a3b',
  'llama-nemotron-super-49b-v1.5': 'nvidia/llama-3.3-nemotron-super-49b-v1.5',
  'llama-nemotron-super-49b': 'nvidia/llama-3.3-nemotron-super-49b-v1',
  'llama-nemotron-70b': 'nvidia/llama-3.1-nemotron-70b-instruct',
  'nemotron-nano-9b-v2': 'nvidia/nvidia-nemotron-nano-9b-v2',

  // — ChatGPT (открытые веса) —
  'gpt-oss-120b': 'openai/gpt-oss-120b',
  'gpt-oss-20b': 'openai/gpt-oss-20b',

  // — Google —
  'gemma-3-12b': 'google/gemma-3-12b-it',
  'gemma-2-2b': 'google/gemma-2-2b-it',
  'codegemma-7b': 'google/codegemma-7b',
  'diffusiongemma-26b': 'google/diffusiongemma-26b-a4b-it',

  // — Qwen —
  'qwen3-coder-480b': 'qwen/qwen3-coder-480b-a35b-instruct',
  'qwen3-next-80b': 'qwen/qwen3-next-80b-a3b-instruct',
  'qwen3.5-122b': 'qwen/qwen3.5-122b-a10b',
  'qwen3.5-397b-alt': 'qwen/qwen3.5-397b-a17b',

  // — Z-AI —
  'glm-5.2-alt': 'z-ai/glm-5.2',
  'glm-5.1-alt': 'z-ai/glm-5.1',

};


const PUBLIC_BY_UPSTREAM = Object.fromEntries(
  Object.entries(MODEL_ALIASES).map(([pub, up]) => [up, pub]),
);

const toUpstreamId = (m) => MODEL_ALIASES[m] ?? m;
const toPublicId = (m) => PUBLIC_BY_UPSTREAM[m] ?? m;

export function loadDotenv(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return false; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (!(key in process.env)) process.env[key] = val;
  }
  return true;
}


let _store = null;
let _storeDir = null;

export function store() {
  if (_store && _storeDir === DATA_DIR) return _store;
  _store?.close?.();
  _store = openStore(DATA_DIR);
  _storeDir = DATA_DIR;
  return _store;
}

export function closeStore() {
  _store?.close?.();
  _store = null;
  _storeDir = null;
}

export const createKey = (opts) => store().createKey(opts);
export const listKeys = () => store().listKeys();
export const revokeKey = (idOrKey) => store().revokeKey(idOrKey);
export const setKeyDisabled = (idOrKey, disabled) => store().setDisabled(idOrKey, disabled);
export const stats = (opts) => store().stats(opts);
export const loadKeys = () => ({ keys: listKeys() });

function loadPublicKeys() {
  try { return JSON.parse(fs.readFileSync(PUBLIC_KEYS_FILE, 'utf8')); } catch { return {}; }
}

function savePublicKeys(records) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PUBLIC_KEYS_FILE, JSON.stringify(records, null, 2), { mode: 0o600 });
}

export function issuePublicKey(userId, { limitTokens = 100_000, windowHours = 5, days = 30 } = {}) {
  const uid = String(userId);
  const records = loadPublicKeys();
  const existing = Object.values(records).find((r) => r.userId === uid);
  if (existing) {
    const key = listKeys().find((k) => k.id === existing.keyId);
    if (Date.parse(existing.expiresAt) <= Date.now()) return { key, quota: existing, expired: true };
    if (key) return { key, quota: existing, expired: false };
  }
  const key = createKey({ label: `telegram:${uid}`, limitTokens: 0 });
  const now = Date.now();
  const quota = {
    keyId: key.id, userId: uid, limitTokens, windowMs: windowHours * 3_600_000,
    windowStartedAt: new Date(now).toISOString(), baselineTokens: 0,
    expiresAt: new Date(now + days * 86_400_000).toISOString(),
  };
  records[key.id] = quota;
  savePublicKeys(records);
  return { key, quota, expired: false };
}

export function publicKeyStatus(userId) {
  const uid = String(userId);
  const records = loadPublicKeys();
  const quota = Object.values(records).find((r) => r.userId === uid);
  if (!quota) return null;
  const key = listKeys().find((k) => k.id === quota.keyId) ?? null;
  const total = (key?.used.input ?? 0) + (key?.used.output ?? 0);
  if (Date.now() - Date.parse(quota.windowStartedAt) >= quota.windowMs) {
    quota.windowStartedAt = new Date().toISOString();
    quota.baselineTokens = total;
    records[quota.keyId] = quota;
    savePublicKeys(records);
  }
  const resetAt = new Date(Date.parse(quota.windowStartedAt) + quota.windowMs).toISOString();
  return {
    key, quota, expired: Date.parse(quota.expiresAt) <= Date.now(), resetAt,
    used: Math.max(0, total - quota.baselineTokens),
    remaining: Math.max(0, quota.limitTokens - Math.max(0, total - quota.baselineTokens)),
  };
}

function publicQuota(rec) {
  const records = loadPublicKeys();
  const q = records[rec.id];
  if (!q) return { ok: true };
  const now = Date.now();
  if (now >= Date.parse(q.expiresAt)) return { ok: false, status: 403, message: 'Срок ключа истёк. Купить новый: @udpallow' };
  const total = rec.used.input + rec.used.output;
  if (now - Date.parse(q.windowStartedAt) >= q.windowMs) {
    q.windowStartedAt = new Date(now).toISOString();
    q.baselineTokens = total;
    records[rec.id] = q;
    savePublicKeys(records);
  }
  const used = Math.max(0, total - q.baselineTokens);
  if (used >= q.limitTokens) return { ok: false, status: 429, message: 'Лимит 100k исчерпан. Он сбросится через 5 часов от начала окна.' };
  return { ok: true, used, remaining: q.limitTokens - used, quota: q };
}

export const listChats = (opts) => store().listChats(opts);
export const getChat = (id) => store().getChat(id);
export const countChats = () => store().countChats();
export const deleteChats = (opts) => store().deleteChats(opts);

/** Логировать переписку или нет (CODEROOM_LOG_CHATS=0 — выключить). */
export const chatLogEnabled = () => !/^(0|false|no|off)$/i.test(String(process.env.CODEROOM_LOG_CHATS ?? '1'));

/** Убрать переписку старше N дней (CODEROOM_CHAT_KEEP_DAYS). */
export function pruneChats(days = Number(process.env.CODEROOM_CHAT_KEEP_DAYS) || 0) {
  if (!days) return 0;
  const before = new Date(Date.now() - days * 86_400_000).toISOString();
  try { return store().deleteChats({ before }); } catch { return 0; }
}

const findKeyRecord = (rawKey) => store().findKey(rawKey);
const recordUsage = (id, usage, meta) => store().recordUsage(id, usage, meta);


export function loadUpstreams() {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(UPSTREAMS_FILE, 'utf8')); } catch { /* нет файла */ }

  const build = (id) => {
    const u = GATEWAY_UPSTREAMS[id];
    if (!u) return null;
    const envKeys = process.env[`${u.keyEnv}S`] || process.env[u.keyEnv];
    const apiKeys = parseApiKeys(envKeys || file[id]?.apiKeys || file[id]?.apiKey);
    return {
      id,
      label: u.label,
      apiKeys,
      apiKey: apiKeys[0] || '', // совместимость со старым кодом и конфигами
      baseUrl: String(file[id]?.baseUrl || u.baseUrl || '').replace(/\/+$/, ''),
      userAgent: u.userAgent || 'claude-cli/2.0.1 (external, cli)',
      models: u.models || [],
      defaultParams: typeof u.defaultParams === 'function' ? u.defaultParams() : (u.defaultParams || {}),
    };
  };

  const out = {};
  for (const id of Object.keys(GATEWAY_UPSTREAMS)) out[id] = build(id);
  return out;
}

function routeModel(model, up) {
  const id = String(model || '');
  // Точное совпадение: у кого модель заявлена — тот и отвечает.
  // Если модель есть у нескольких (например claude-* у seekai и bluesminds),
  // берём первого, у кого реально есть ключ, — иначе просто первого.
  const owners = Object.values(up).filter((u) => u && u.models.includes(id));
  if (owners.length) return owners.find((u) => u.apiKeys.length) || owners[0];

  const m = id.toLowerCase();
  if (/^(claude|gpt-5|gemini|grok|qwen-3-max|glm-5-2|deepseek-v4)/.test(m) && up.seekai) return up.seekai;
  return up.hcnsec || Object.values(up)[0] || null;
}


function combinedModels(up) {
  const out = [];
  for (const u of Object.values(up)) {
    if (!u) continue;
    for (const id of u.models) {
      out.push({
        id: toPublicId(id),
        object: 'model',
        owned_by: 'coderoom',
        created: 1626777600,
        available: Boolean(u.apiKeys.length),
      });
    }
  }
  return out;
}

const MSG_TEXT_LIMIT = 1500;
const REPLY_LIMIT = 12_000;

/** Текст сообщения: строка или массив частей (vision-формат). */
function messageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).filter(Boolean).join(' ');
  }
  return '';
}

/** Компактный слепок переписки для лога: последние 30 сообщений, каждое обрезано. */
function snapshotMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.slice(-30).map((m) => {
    const text = messageText(m?.content);
    const calls = Array.isArray(m?.tool_calls)
      ? m.tool_calls.map((c) => c?.function?.name).filter(Boolean).join(', ')
      : '';
    return {
      role: m?.role ?? '?',
      name: m?.name,
      content: (text.length > MSG_TEXT_LIMIT ? text.slice(0, MSG_TEXT_LIMIT) + '…' : text) ||
        (calls ? '[вызов инструментов: ' + calls + ']' : ''),
    };
  });
}

/** Собирает текст ответа по мере прихода чанков: и SSE-поток, и обычный JSON. */
function replyCollector() {
  let partial = '';
  let text = '';
  let raw = '';
  let sawStream = false;

  const take = (piece) => {
    if (typeof piece === 'string' && piece && text.length < REPLY_LIMIT) text += piece;
  };

  return {
    push(piece) {
      if (raw.length < 300_000) raw += piece;
      partial += piece;
      const lines = partial.split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) {
        const l = line.trim();
        if (!l.startsWith('data:')) continue;
        const payload = l.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const j = JSON.parse(payload);
          const c = j.choices?.[0];
          if (!c) continue;
          sawStream = true;
          take(c.delta?.content ?? c.message?.content ?? '');
        } catch { /* кусок не разобрался — не беда */ }
      }
    },
    text() {
      if (sawStream || !raw) return text.slice(0, REPLY_LIMIT);
      try {
        const j = JSON.parse(raw);
        return messageText(j.choices?.[0]?.message?.content).slice(0, REPLY_LIMIT);
      } catch {
        return text.slice(0, REPLY_LIMIT);
      }
    },
  };
}

function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket?.remoteAddress || '';
}

function extractUsage(text) {
  if (!text) return null;
  const inM = [...text.matchAll(/"(?:prompt_tokens|input_tokens)"\s*:\s*(\d+)/g)];
  const outM = [...text.matchAll(/"(?:completion_tokens|output_tokens)"\s*:\s*(\d+)/g)];
  if (!inM.length && !outM.length) return null;
  return {
    input: inM.length ? Number(inM[inM.length - 1][1]) : 0,
    output: outM.length ? Number(outM[outM.length - 1][1]) : 0,
  };
}


function send(res, status, obj, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', ...extra });
  res.end(JSON.stringify(obj));
}

async function readBody(req, limit = 8_000_000) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function bearer(req) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : String(req.headers['x-api-key'] || '');
}

export async function startGateway({ port, host, adminToken } = {}) {
  const listenPort = port !== undefined && port !== null
    ? Number(port)
    : Number(process.env.CODEROOM_GATEWAY_PORT) || 8787;
  const listenHost = host || process.env.CODEROOM_GATEWAY_HOST || '127.0.0.1';
  const admin = adminToken || process.env.GATEWAY_ADMIN_TOKEN || crypto.randomBytes(16).toString('hex');

  pruneChats();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'OPTIONS') {
      return res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization,Content-Type,X-Admin-Token,X-Api-Key',
      }).end();
    }

    if (url.pathname === '/health') return send(res, 200, { ok: true, service: 'coderoom-gateway' });

    if (url.pathname === '/admin' || url.pathname === '/') {
      if (url.searchParams.get('token') !== admin) {
        return res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
          .end('Нужен admin-токен. Открой ссылку, которую напечатал шлюз при старте.');
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(adminHtml(admin, listenPort));
    }

    if (url.pathname.startsWith('/admin/api/')) {
      const token = req.headers['x-admin-token'] || url.searchParams.get('token');
      if (token !== admin) return send(res, 403, { error: 'bad admin token' });

      if (req.method === 'GET' && url.pathname === '/admin/api/keys') {
        const up = loadUpstreams();
        const upstreams = {};
        for (const [id, u] of Object.entries(up)) upstreams[id] = u?.apiKeys?.length || 0;
        return send(res, 200, {
          keys: listKeys(),
          upstreams,
          stats: stats({ top: 8 }),
          storage: { kind: store().kind, file: store().file },
        });
      }
      if (req.method === 'POST' && url.pathname === '/admin/api/keys') {
        const body = JSON.parse((await readBody(req)) || '{}');
        return send(res, 200, { key: createKey({ label: body.label, limitTokens: body.limitTokens }) });
      }
      if (req.method === 'DELETE' && url.pathname.startsWith('/admin/api/keys/')) {
        const id = decodeURIComponent(url.pathname.split('/').pop());
        return send(res, 200, { removed: revokeKey(id) });
      }

      const toggle = /^\/admin\/api\/keys\/([^/]+)\/(on|off)$/.exec(url.pathname);
      if (req.method === 'POST' && toggle) {
        return send(res, 200, { ok: setKeyDisabled(decodeURIComponent(toggle[1]), toggle[2] === 'off') });
      }

      if (req.method === 'GET' && url.pathname === '/admin/api/chats') {
        return send(res, 200, {
          enabled: chatLogEnabled(),
          total: countChats(),
          chats: listChats({
            limit: Number(url.searchParams.get('limit')) || 30,
            offset: Number(url.searchParams.get('offset')) || 0,
            keyId: url.searchParams.get('key') || '',
            q: url.searchParams.get('q') || '',
          }),
        });
      }

      if (req.method === 'GET' && url.pathname.startsWith('/admin/api/chats/')) {
        const chat = getChat(url.pathname.split('/').pop());
        return chat ? send(res, 200, { chat }) : send(res, 404, { error: 'not found' });
      }

      if (req.method === 'DELETE' && url.pathname.startsWith('/admin/api/chats/')) {
        const last = url.pathname.split('/').pop();
        return send(res, 200, { removed: last === 'all' ? deleteChats({ all: true }) : deleteChats({ id: last }) });
      }

      return send(res, 404, { error: 'not found' });
    }

    if (url.pathname === '/v1/models' || url.pathname === '/v1/chat/completions') {
      const rec = findKeyRecord(bearer(req));
      if (!rec) return send(res, 401, { error: { message: 'Неверный или неизвестный ключ CodeRoom (cr-…)', type: 'invalid_api_key' } });
      if (rec.disabled) return send(res, 403, { error: { message: 'Ключ отключён', type: 'key_disabled' } });
      const quota = publicQuota(rec);
      if (!quota.ok) return send(res, quota.status, { error: { message: quota.message, type: 'public_key_limit' } });
      if (rec.limitTokens && rec.used.input + rec.used.output >= rec.limitTokens) {
        return send(res, 429, { error: { message: 'Исчерпан лимит токенов для этого ключа', type: 'limit_exceeded' } });
      }

      const up = loadUpstreams();

      if (url.pathname === '/v1/models') {
        return send(res, 200, { object: 'list', data: combinedModels(up) });
      }

      let bodyText = '';
      try { bodyText = await readBody(req); } catch { return send(res, 413, { error: { message: 'запрос слишком большой' } }); }
      let body;
      try { body = JSON.parse(bodyText || '{}'); } catch { return send(res, 400, { error: { message: 'тело не JSON' } }); }

      const publicModel = body.model;
      const knownHealth = getModelHealth().models?.[publicModel];
      if (knownHealth && knownHealth.ok === false) {
        return send(res, 503, { error: {
          message: `Технические работы: модель ${publicModel} сейчас недоступна. Выбери другую через /model.`,
          type: 'model_maintenance',
        } });
      }
      body.model = toUpstreamId(publicModel);

      const target = routeModel(body.model, up);
      if (!target) {
        return send(res, 502, { error: { message: 'На сервере нет апстримов. Задай ключи в server/.env.' } });
      }
      if (!target.apiKeys.length) {
        const keyEnv = GATEWAY_UPSTREAMS[target.id]?.keyEnv || 'ключ';
        return send(res, 502, { error: { message: `Модель «${publicModel}» временно недоступна: на сервере нет ${keyEnv} или ${keyEnv}S.` } });
      }

      for (const [k, v] of Object.entries(target.defaultParams ?? {})) {
        if (body[k] === undefined) body[k] = v;
      }

      const controller = new AbortController();
      let finished = false;
      res.on('close', () => { if (!finished) controller.abort(); });

      const startedAt = Date.now();
      const logChat = (status, reply, usage) => {
        if (!chatLogEnabled()) return;
        const msgs = Array.isArray(body.messages) ? body.messages : [];
        const lastUser = [...msgs].reverse().find((m) => m?.role === 'user');
        try {
          store().logChat({
            keyId: rec.id,
            keyLabel: rec.label,
            model: publicModel,
            upstream: target.id,
            status,
            ms: Date.now() - startedAt,
            tokens: usage ?? { input: 0, output: 0 },
            ip: clientIp(req),
            prompt: messageText(lastUser?.content),
            reply: reply ?? '',
            messages: snapshotMessages(msgs),
          });
        } catch { /* лог не должен ломать запрос */ }
      };

      let upstreamRes;
      let upstreamError;
      const requestBody = JSON.stringify(body);
      const candidateKeys = nextUpstreamKeys(target);
      for (let i = 0; i < candidateKeys.length; i++) {
        const apiKey = candidateKeys[i];
        try {
          upstreamRes = await fetch(target.baseUrl + '/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
              'User-Agent': target.userAgent,
            },
            body: requestBody,
            signal: controller.signal,
          });
          const canRetry = i + 1 < candidateKeys.length && RETRYABLE_UPSTREAM_STATUSES.has(upstreamRes.status);
          if (!canRetry) break;
          coolDownUpstreamKey(target.id, apiKey);
          try { await upstreamRes.body?.cancel(); } catch { /* ignore */ }
          upstreamRes = null;
        } catch (e) {
          upstreamError = e;
          if (controller.signal.aborted || i + 1 >= candidateKeys.length) break;
          coolDownUpstreamKey(target.id, apiKey);
        }
      }
      if (!upstreamRes) {
        finished = true;
        const message = upstreamError?.message || 'все API-ключи временно недоступны';
        logChat(502, 'Апстрим недоступен: ' + message);
        return send(res, 502, { error: { message: 'Апстрим недоступен: ' + message } });
      }

      res.writeHead(upstreamRes.status, {
        'Content-Type': upstreamRes.headers.get('content-type') || 'application/json',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        'X-CodeRoom-Upstream': target.id,
      });

      if (!upstreamRes.body) {
        finished = true;
        res.end();
        logChat(upstreamRes.status, '');
        return;
      }

      const dec = new TextDecoder();
      const reply = replyCollector();
      let tail = '';
      try {
        for await (const chunk of upstreamRes.body) {
          res.write(Buffer.from(chunk));
          const piece = dec.decode(chunk, { stream: true });
          tail += piece;
          if (tail.length > 24000) tail = tail.slice(-8000);
          reply.push(piece);
        }
      } catch { /* клиент отключился / апстрим оборвал */ }
      finished = true;
      res.end();

      const usage = extractUsage(tail);
      if (upstreamRes.ok) {
        try {
          recordUsage(rec.id, usage, { model: publicModel, upstream: target.id });
        } catch { /* учёт не критичен */ }
      }
      logChat(upstreamRes.status, reply.text(), usage);
      return;
    }

    // Model health endpoint
    if (url.pathname === '/v1/model-health') {
      return send(res, 200, getModelHealth());
    }

    return send(res, 404, { error: { message: 'not found' } });
  });

  // Start model health checker (every 30 min)
  const healthInterval = startModelHealthChecker();
  server.on('close', () => clearInterval(healthInterval));

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, listenHost, resolve);
  });

  const actualPort = server.address().port;
  const publicUrl = String(process.env.CODEROOM_PUBLIC_URL || '').replace(/\/+$/, '');
  const localUrl = `http://${listenHost === '0.0.0.0' ? '127.0.0.1' : listenHost}:${actualPort}`;
  const base = publicUrl || localUrl;

  return {
    server,
    port: actualPort,
    host: listenHost,
    adminToken: admin,
    url: base,
    localUrl,
    publicUrl: publicUrl || null,
    adminUrl: `${base}/admin?token=${admin}`,
    close: () => server.close(),
  };
}


function adminHtml(token, port) {
  return `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>CodeRoom Gateway</title>
<style>
:root{--bg:#0a0b14;--fg:#e8eaf6;--mut:#8b90b0;--pri:#7c5cff;--bd:rgba(255,255,255,.1);--ok:#3ddc97;--err:#ff5c7c}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,Segoe UI,sans-serif;padding:24px;max-width:860px;margin:auto}
h1{font-size:20px}h1 small{color:var(--mut);font-weight:400;font-size:13px}
.card{border:1px solid var(--bd);border-radius:12px;padding:16px;margin:16px 0;background:rgba(255,255,255,.03)}
input,button{font:inherit;padding:9px 12px;border-radius:9px;border:1px solid var(--bd);background:#12141f;color:var(--fg)}
button{background:var(--pri);border-color:var(--pri);color:#fff;cursor:pointer}button.g{background:transparent;color:var(--err);border-color:var(--bd)}
table{width:100%;border-collapse:collapse;margin-top:10px;font-size:13px}td,th{text-align:left;padding:7px 8px;border-bottom:1px solid var(--bd)}
code{font-family:ui-monospace,Consolas,monospace;background:#0006;padding:2px 6px;border-radius:6px}
.mut{color:var(--mut)}.up{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;border:1px solid var(--bd)}
.on{color:var(--ok)}.off{color:var(--err)}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
</style></head><body>
<h1>CodeRoom Gateway <small>порт ${port}</small></h1>
<div class="card"><b>Апстримы:</b> <span id="ups" class="mut">…</span>
<div class="mut" style="margin-top:6px">Ключи апстримов задаются на сервере в <code>server/.env</code>: <code>SEEKAI_API_KEY</code>, <code>BLUESMINDS_API_KEY</code>, <code>NVIDIA_API_KEY</code>, <code>HCNSEC_API_KEY</code>.</div></div>

<div class="card">
  <b>Новый ключ</b>
  <div class="row" style="margin-top:10px">
    <input id="label" placeholder="метка (например: телефон)" style="flex:1;min-width:160px">
    <input id="limit" type="number" min="0" placeholder="лимит токенов (0 = без)" style="width:220px">
    <button onclick="mk()">Создать</button>
  </div>
  <div id="new"></div>
</div>
<div class="card"><b>Ключи</b><table id="tbl"><thead><tr><th>метка</th><th>ключ</th><th>расход</th><th>лимит</th><th></th></tr></thead><tbody></tbody></table></div>
<div class="card"><b>Расход по моделям</b> <span id="tot" class="mut"></span>
<table id="st"><thead><tr><th>модель</th><th>апстрим</th><th>запросов</th><th>токенов</th></tr></thead><tbody></tbody></table></div>
<div class="card">
  <div class="row"><b>Чаты</b> <span id="chatTot" class="mut"></span><span style="flex:1"></span>
    <input id="q" placeholder="поиск по тексту" style="min-width:180px">
    <button onclick="loadChats()">Найти</button></div>
  <table id="ch"><thead><tr><th>когда</th><th>ключ</th><th>модель</th><th>запрос</th><th>токенов</th></tr></thead><tbody></tbody></table>
  <div id="chatView"></div>
</div>
<script>
const T=${JSON.stringify(token)};
const api=(p,o={})=>fetch(p,{...o,headers:{'X-Admin-Token':T,'Content-Type':'application/json',...(o.headers||{})}}).then(r=>r.json());
const esc=s=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
async function load(){
  const d=await api('/admin/api/keys');
  document.getElementById('ups').innerHTML=
    Object.entries(d.upstreams).map(([id,count])=>'<span class="up '+(count?'on':'off')+'">'+id+' '+(count?('ключей: '+count):'нет ключа')+'</span>').join(' ');
  const tb=document.querySelector('#tbl tbody');
  tb.innerHTML=d.keys.map(k=>'<tr><td>'+esc(k.label||'—')+'</td><td><code>cr-…'+esc(k.key.slice(-6))+'</code></td>'+
    '<td class="mut">'+(k.used.input+k.used.output)+' тк · '+k.used.requests+' зпр</td>'+
    '<td class="mut">'+(k.limitTokens||'∞')+'</td>'+
    '<td><button class="g" onclick="rm(\\''+k.id+'\\')">удалить</button></td></tr>').join('')||'<tr><td colspan=5 class="mut">пусто</td></tr>';

  const s=d.stats||{byModel:[]};
  document.getElementById('tot').textContent=
    (s.requests||0)+' запросов · '+(s.input||0)+' ↑ · '+(s.output||0)+' ↓'+
    (d.storage?'   ['+d.storage.kind+']':'');
  document.querySelector('#st tbody').innerHTML=(s.byModel||[]).map(m=>
    '<tr><td><code>'+esc(m.model)+'</code></td><td class="mut">'+esc(m.upstream)+'</td>'+
    '<td class="mut">'+m.requests+'</td><td class="mut">'+(m.input+m.output)+'</td></tr>'
  ).join('')||'<tr><td colspan=4 class="mut">пока нет запросов</td></tr>';
}
async function mk(){
  const label=document.getElementById('label').value;
  const limitTokens=Number(document.getElementById('limit').value)||0;
  const r=await api('/admin/api/keys',{method:'POST',body:JSON.stringify({label,limitTokens})});
  document.getElementById('new').innerHTML='<div style="margin-top:10px">Готово, скопируй (больше не покажу целиком):<br><code>'+esc(r.key.key)+'</code></div>';
  document.getElementById('label').value='';document.getElementById('limit').value='';load();
}
async function rm(id){ if(!confirm('Удалить ключ?'))return; await api('/admin/api/keys/'+id,{method:'DELETE'}); load(); }

const when=s=>String(s).slice(0,16).replace('T',' ');
async function loadChats(){
  const q=document.getElementById('q').value.trim();
  const d=await api('/admin/api/chats?limit=30'+(q?'&q='+encodeURIComponent(q):''));
  document.getElementById('chatTot').textContent=
    d.enabled?('всего '+d.total):'логирование выключено (CODEROOM_LOG_CHATS=0)';
  document.querySelector('#ch tbody').innerHTML=(d.chats||[]).map(c=>
    '<tr style="cursor:pointer" onclick="openChat('+c.id+')"><td class="mut">'+when(c.at)+'</td>'+
    '<td class="mut">'+esc(c.keyLabel||c.keyId)+'</td><td><code>'+esc(c.model)+'</code></td>'+
    '<td>'+esc(String(c.prompt).slice(0,70))+'</td>'+
    '<td class="mut">'+(c.tokens.input+c.tokens.output)+'</td></tr>'
  ).join('')||'<tr><td colspan=5 class="mut">пусто</td></tr>';
}
async function openChat(id){
  const d=await api('/admin/api/chats/'+id);
  if(!d.chat)return;
  const c=d.chat;
  const box=document.getElementById('chatView');
  box.innerHTML='<div class="card" style="background:#0006"><div class="row"><b>Чат #'+c.id+'</b>'+
    '<span class="mut">'+when(c.at)+' · '+esc(c.model)+' · '+esc(c.upstream)+' · '+c.ms+' мс · статус '+c.status+'</span>'+
    '<span style="flex:1"></span><button class="g" onclick="delChat('+c.id+')">удалить</button>'+
    '<button class="g" onclick="this.closest(\\'.card\\').remove()">закрыть</button></div>'+
    '<div class="mut" style="margin-top:8px">запрос</div><pre style="white-space:pre-wrap">'+esc(c.prompt)+'</pre>'+
    '<div class="mut">ответ</div><pre style="white-space:pre-wrap">'+esc(c.reply)+'</pre></div>';
  box.scrollIntoView({behavior:'smooth',block:'nearest'});
}
async function delChat(id){ await api('/admin/api/chats/'+id,{method:'DELETE'}); document.getElementById('chatView').innerHTML=''; loadChats(); }
load(); loadChats();
</script></body></html>`;
}
