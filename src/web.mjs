import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { Agent } from './agent.mjs';
import { Session } from './session.mjs';
import { WEB_THEMES, createTheme } from './themes.mjs';
import { renderDiff, stripAnsi } from './render.mjs';
import { MODES } from './permissions.mjs';
import { saveConfig, resolveProvider, maskKey, setProviderKey, PROVIDER_PRESETS } from './config.mjs';
import { Provider, estimateTokens } from './provider.mjs';
import { clientHtml } from './web-client.mjs';

const HISTORY_LIMIT = 400;        // событий в буфере для перезагрузки страницы
const EVENT_TEXT_LIMIT = 20_000;  // столько символов события храним в буфере
const CONFIRM_TTL = 10 * 60 * 1000;

export async function startWebServer({ cfg, cwd = process.cwd(), port, host } = {}) {
  const token = crypto.randomBytes(16).toString('hex');
  const listenPort = port ?? cfg.web?.port ?? 4517;
  const listenHost = host ?? cfg.web?.host ?? '127.0.0.1';
  const contextLimit = cfg.agent?.autoCompactAt ?? 140000;

  let session = new Session({ cwd, model: cfg.model, provider: cfg.provider });

  const pending = new Map();
  const clients = new Set();

  /* Кольцевой буфер событий: по нему страница восстанавливает ленту после F5,
     а SSE — досылает пропущенное по Last-Event-ID. */
  let history = [];
  let seq = 0;

  const remember = (event, data) => {
    if (event === 'text' || event === 'reasoning' || event === 'tool_progress') return;
    history.push({ seq, event, data, at: new Date().toISOString() });
    if (history.length > HISTORY_LIMIT) history = history.slice(-HISTORY_LIMIT);
  };

  const broadcast = (event, data) => {
    seq++;
    remember(event, trim(data));
    const payload = `id: ${seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
      try { res.write(payload); } catch { clients.delete(res); }
    }
  };

  const resetHistory = () => { history = []; };

  const ui = {
    onText: (delta) => broadcast('text', { delta }),
    onReasoning: (delta) => broadcast('reasoning', { delta }),
    onStep: (n) => broadcast('step', { n }),
    onNotice: (text, level) => broadcast('notice', { text, level }),
    onUsage: (usage, total) =>
      broadcast('usage', { usage, total, contextTokens: estimateTokens(session.messages) }),
    onToolStart: (call) =>
      broadcast('tool_start', { id: call.id, name: call.name, label: call.label }),
    onToolProgress: (call, chunk) => broadcast('tool_progress', { id: call.id, chunk }),

    onToolResult: (call, result) => {
      const payload = { id: call.id, name: call.name, output: result.output ?? '' };
      if (result.meta?.before !== undefined && result.meta?.after !== undefined) {
        payload.diff = renderDiffPlain(result.meta.before, result.meta.after);
        payload.path = result.meta.path;
      }
      broadcast('tool_result', payload);
      if (result.meta?.todos) broadcast('todos', { todos: result.meta.todos });
    },

    onToolError: (call, msg) => broadcast('tool_error', { id: call.id, name: call.name, error: msg }),

    confirm: (req) =>
      new Promise((resolve) => {
        const id = crypto.randomBytes(6).toString('hex');
        const timer = setTimeout(() => {
          if (pending.delete(id)) resolve('no');
        }, CONFIRM_TTL);
        pending.set(id, (answer) => { clearTimeout(timer); resolve(answer); });

        broadcast('confirm', {
          id,
          tool: req.tool,
          label: req.label,
          reason: req.reason,
          danger: req.danger,
          preview: req.preview
            ? {
                kind: req.preview.kind,
                path: req.preview.path,
                command: req.preview.command,
                existed: req.preview.existed,
                diff: req.preview.kind === 'bash'
                  ? null
                  : renderDiffPlain(req.preview.before, req.preview.after),
              }
            : null,
        });
      }),
  };

  const agent = new Agent({ cfg, session, cwd, ui });

  const swapSession = (next) => {
    session = next;
    agent.session = next;
    for (const resolve of pending.values()) resolve('no');
    pending.clear();
    resetHistory();
    broadcast('resync', {});
  };

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      return text(res, 400, 'Кривой URL');
    }

    /* Защита от DNS-rebinding: браузер стороннего сайта может резолвить свой домен
       в 127.0.0.1, но Host в запросе останется чужим. */
    if (!hostAllowed(req.headers.host, listenHost, listenPort)) {
      return text(res, 403, 'Чужой Host. Открывай по адресу из терминала.');
    }

    const provided = url.searchParams.get('token') ?? req.headers['x-coderoom-token'];
    if (!sameToken(provided, token)) {
      return text(res, 403, 'Нужен токен. Открой ссылку, которую напечатал CodeRoom в терминале.');
    }

    if (url.pathname === '/') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      });
      return res.end(clientHtml({
        token, cfg, cwd, themes: WEB_THEMES, modes: MODES,
        sessionId: session.id, contextLimit,
      }));
    }

    if (url.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 1500\n\n');
      clients.add(res);

      /* Досылаем то, что клиент пропустил, пока переподключался. */
      const since = Number(req.headers['last-event-id'] ?? url.searchParams.get('lastEventId') ?? 0);
      if (since > 0) {
        const missed = history.filter((h) => h.seq > since);
        const gap = history.length && history[0].seq > since + 1;
        if (gap) res.write(`event: resync\ndata: {}\n\n`);
        else for (const h of missed) {
          res.write(`id: ${h.seq}\nevent: ${h.event}\ndata: ${JSON.stringify(h.data)}\n\n`);
        }
      }

      const ping = setInterval(() => {
        try { res.write(': ping\n\n'); } catch { /* закрылось — уберём по close */ }
      }, 25000);

      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }

    if (url.pathname === '/api/state') {
      const p = resolveProvider(cfg);
      return json(res, {
        cwd,
        seq,
        sessionId: session.id,
        model: cfg.model,
        provider: { id: p.id, label: p.label, key: maskKey(p.apiKey) },
        providers: Object.entries(PROVIDER_PRESETS).map(([id, pr]) => ({
          id,
          label: pr.label,
          hasKey: Boolean(resolveProvider(cfg, id).apiKey) || Boolean(pr.keyOptional),
        })),
        mode: cfg.permissions.mode,
        modes: Object.entries(MODES).map(([id, m]) => ({ id, ...m })),
        models: (PROVIDER_PRESETS[cfg.provider]?.models ?? []).map((m) => ({ id: m.id, label: m.label })),
        webTheme: cfg.webTheme,
        themes: Object.entries(WEB_THEMES).map(([id, t]) => ({ id, label: t.label, description: t.description })),
        messages: session.messages.filter((m) => m.role === 'user' || (m.role === 'assistant' && m.content)),
        history,
        todos: session.todos,
        usage: session.usage,
        contextTokens: estimateTokens(session.messages),
        contextLimit,
        sessions: listSessions(cwd, session.id),
        running: agent.running,
      });
    }

    if (url.pathname === '/api/sessions') {
      return json(res, { sessions: listSessions(cwd, session.id) });
    }

    if (req.method === 'POST' && url.pathname === '/api/session') {
      if (agent.running) return json(res, { error: 'Агент занят — сначала останови его' }, 409);
      const body = await readBody(req);

      if (body.fresh || !body.id) {
        if (session.messages.length) { try { session.save(); } catch { /* диск подождёт */ } }
        swapSession(new Session({ cwd, model: cfg.model, provider: cfg.provider }));
        return json(res, { ok: true, sessionId: session.id });
      }

      const found = Session.list(cwd, 100).find((s) => s.id === body.id);
      if (!found) return json(res, { error: 'Диалог не найден' }, 404);
      try {
        const loaded = Session.load(found.file);
        swapSession(loaded);
        cfg.model = loaded.model ?? cfg.model;
        return json(res, { ok: true, sessionId: loaded.id });
      } catch (e) {
        return json(res, { error: 'Не открылся: ' + e.message }, 500);
      }
    }

    if (url.pathname === '/api/files') {
      const q = String(url.searchParams.get('q') ?? '');
      return json(res, { files: await findFiles(cwd, q) });
    }

    if (req.method === 'POST' && url.pathname === '/api/message') {
      const body = await readBody(req);
      const message = String(body.text ?? '').trim();
      if (!message) return json(res, { error: 'Пустое сообщение' }, 400);
      if (agent.running) return json(res, { error: 'Агент занят' }, 409);

      json(res, { ok: true });
      broadcast('user', { text: message });

      agent
        .send(message)
        .then((r) => {
          if (r.text) broadcast('assistant', { text: r.text });
          broadcast('done', { steps: r.steps, interrupted: r.interrupted });
        })
        .catch((e) => broadcast('error', { message: e.message, hint: e.hint }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/confirm') {
      const body = await readBody(req);
      const resolve = pending.get(body.id);
      if (resolve) {
        pending.delete(body.id);
        const ok = ['yes', 'always', 'forever'];
        resolve(ok.includes(body.answer) ? body.answer : 'no');
      }
      return json(res, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/interrupt') {
      agent.interrupt();
      return json(res, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/settings') {
      const body = await readBody(req);

      if (body.provider && PROVIDER_PRESETS[body.provider]) {
        cfg.provider = body.provider;
        const preset = PROVIDER_PRESETS[body.provider];
        if (body.key) setProviderKey(cfg, body.provider, String(body.key).trim());
        const known = (preset.models ?? []).some((m) => m.id === cfg.model);
        if (!known && preset.defaultModel) cfg.model = preset.defaultModel;
        session.model = cfg.model;
        agent.provider = new Provider(cfg);
      }

      if (body.model) { cfg.model = String(body.model); session.model = cfg.model; }
      if (body.mode && MODES[body.mode]) agent.permissions.setMode(body.mode);
      if (body.webTheme && WEB_THEMES[body.webTheme]) cfg.webTheme = body.webTheme;
      try { saveConfig(cfg); } catch { /* конфиг мог стать недоступен — не роняем сервер */ }

      const rp = resolveProvider(cfg);
      return json(res, {
        ok: true,
        model: cfg.model,
        mode: cfg.permissions.mode,
        webTheme: cfg.webTheme,
        provider: {
          id: rp.id,
          label: rp.label,
          hasKey: Boolean(rp.apiKey) || Boolean(PROVIDER_PRESETS[rp.id]?.keyOptional),
        },
        models: (PROVIDER_PRESETS[cfg.provider]?.models ?? []).map((m) => ({ id: m.id, label: m.label })),
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/clear') {
      session.messages = [];
      session.todos = [];
      session.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 };
      resetHistory();
      broadcast('todos', { todos: [] });
      return json(res, { ok: true });
    }

    if (url.pathname === '/api/models') {
      try {
        return json(res, { models: await new Provider(cfg).listModels() });
      } catch (e) {
        return json(res, { error: e.message }, 502);
      }
    }

    return text(res, 404, 'Не найдено');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, listenHost, resolve);
  });

  const url = `http://${listenHost}:${server.address().port}/?token=${token}`;
  if (cfg.web?.autoOpen) openBrowser(url);

  return {
    url,
    token,
    server,
    agent,
    get session() { return session; },
    close: () => {
      for (const res of clients) { try { res.end(); } catch { /* уже закрыт */ } }
      clients.clear();
      server.close();
    },
  };
}


/* ─────────────────────────  вспомогательное  ───────────────────────── */

function json(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(data));
}

function text(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

/** Сравнение токенов за постоянное время. */
function sameToken(a, b) {
  if (typeof a !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function hostAllowed(hostHeader, listenHost, listenPort) {
  if (!hostHeader) return false;
  const host = String(hostHeader).replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === listenHost) return true;
  if (/^127\.\d+\.\d+\.\d+$/.test(host) || host === '::1') return true;
  /* Слушаем наружу — судить о правильном имени не можем. */
  return listenHost === '0.0.0.0' || listenHost === '::';
}

async function readBody(req, limit = 5_000_000) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('Слишком большой запрос');
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    return {};
  }
}

/** Обрезаем то, что кладём в буфер истории: там могут быть мегабайтные выводы. */
function trim(data) {
  if (!data || typeof data !== 'object') return data;
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    out[k] = typeof v === 'string' && v.length > EVENT_TEXT_LIMIT
      ? v.slice(0, EVENT_TEXT_LIMIT) + '\n… обрезано'
      : v;
  }
  return out;
}

function listSessions(cwd, currentId) {
  try {
    const list = Session.list(cwd, 30);
    return list.map((s) => ({ ...s, file: undefined, current: s.id === currentId }));
  } catch {
    return [];
  }
}


const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'target', '.next', '.nuxt',
  '__pycache__', '.venv', 'venv', '.idea', '.vscode', 'coverage', '.cache', 'vendor',
]);

let fileCache = { at: 0, cwd: '', files: [] };

/** Список файлов проекта для подсказок по @ — с коротким кэшем. */
async function scanFiles(cwd) {
  if (fileCache.cwd === cwd && Date.now() - fileCache.at < 10_000) return fileCache.files;

  const files = [];
  const walk = async (dir, depth) => {
    if (depth > 8 || files.length > 8000) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.env.example') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name)) continue;
        await walk(full, depth + 1);
      } else if (e.isFile()) {
        files.push(path.relative(cwd, full).replace(/\\/g, '/'));
      }
    }
  };
  await walk(cwd, 0);

  fileCache = { at: Date.now(), cwd, files };
  return files;
}

/** Нечёткий поиск: подряд идущие буквы запроса, ближе к имени файла — выше. */
async function findFiles(cwd, query, limit = 24) {
  const files = await scanFiles(cwd);
  const q = query.toLowerCase().trim();
  if (!q) return files.slice(0, limit);

  const scored = [];
  for (const f of files) {
    const low = f.toLowerCase();
    const base = low.slice(low.lastIndexOf('/') + 1);
    let score = -1;
    if (base.startsWith(q)) score = 0;
    else if (base.includes(q)) score = 1;
    else if (low.includes(q)) score = 2;
    else if (fuzzy(low, q)) score = 3;
    if (score >= 0) scored.push([score, f.length, f]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return scored.slice(0, limit).map((s) => s[2]);
}

function fuzzy(hay, needle) {
  let i = 0;
  for (const ch of hay) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return false;
}


const PLAIN_THEME = createTheme('minimal');

function renderDiffPlain(before, after) {
  const { text: body, adds, dels } = renderDiff(before ?? '', after ?? '', PLAIN_THEME, {
    context: 3, maxLines: 400, indent: '', width: 200,
  });
  return { text: stripAnsi(body), adds, dels };
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch { /* не смогли открыть — не беда, ссылка есть в терминале */ }
}
