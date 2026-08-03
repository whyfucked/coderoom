import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { Agent } from './agent.mjs';
import { Session } from './session.mjs';
import { WEB_THEMES, createTheme } from './themes.mjs';
import { renderDiff, stripAnsi } from './render.mjs';
import { MODES } from './permissions.mjs';
import { saveConfig, resolveProvider, maskKey, setProviderKey, PROVIDER_PRESETS } from './config.mjs';
import { Provider } from './provider.mjs';
import { clientHtml } from './web-client.mjs';

export async function startWebServer({ cfg, cwd = process.cwd(), port, host } = {}) {
  const token = crypto.randomBytes(16).toString('hex');
  const listenPort = port ?? cfg.web?.port ?? 4517;
  const listenHost = host ?? cfg.web?.host ?? '127.0.0.1';

  const session = new Session({ cwd, model: cfg.model, provider: cfg.provider });


  const pending = new Map();

  const clients = new Set();

  const broadcast = (event, data) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
      try { res.write(payload); } catch { clients.delete(res); }
    }
  };

  const ui = {
    onText: (delta) => broadcast('text', { delta }),
    onReasoning: (delta) => broadcast('reasoning', { delta }),
    onStep: (n) => broadcast('step', { n }),
    onNotice: (text, level) => broadcast('notice', { text, level }),
    onUsage: (usage, total) => broadcast('usage', { usage, total }),
    onToolStart: (call) => broadcast('tool_start', { id: call.id, name: call.name, label: call.label, args: call.args }),
    onToolProgress: (call, chunk) => broadcast('tool_progress', { id: call.id, chunk }),
    onToolResult: (call, result) => {
      const payload = { id: call.id, name: call.name, output: result.output ?? '' };
      if (result.meta?.before !== undefined && result.meta?.after !== undefined) {
        const d = renderDiffPlain(result.meta.before, result.meta.after);
        payload.diff = d;
        payload.path = result.meta.path;
      }
      broadcast('tool_result', payload);
    },
    onToolError: (call, msg) => broadcast('tool_error', { id: call.id, name: call.name, error: msg }),

    confirm: (req) =>
      new Promise((resolve) => {
        const id = crypto.randomBytes(6).toString('hex');
        pending.set(id, resolve);
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
                diff: req.preview.kind === 'bash' ? null : renderDiffPlain(req.preview.before, req.preview.after),
              }
            : null,
        });
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            resolve('no');
          }
        }, 10 * 60 * 1000);
      }),
  };

  const agent = new Agent({ cfg, session, cwd, ui });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    const provided = url.searchParams.get('token') ?? req.headers['x-coderoom-token'];
    const isPublic = url.pathname === '/' && url.searchParams.get('token') === token;
    if (!isPublic && provided !== token) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Нужен токен. Открой ссылку, которую напечатал CodeRoom в терминале.');
    }

    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(clientHtml({ token, cfg, cwd, themes: WEB_THEMES, modes: MODES }));
    }

    if (url.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(': connected\n\n');
      clients.add(res);

      const ping = setInterval(() => {
        try { res.write(': ping\n\n'); } catch { /* ignore */ }
      }, 25000);

      req.on('close', () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return;
    }

    if (url.pathname === '/api/state') {
      const p = resolveProvider(cfg);
      return json(res, {
        cwd,
        model: cfg.model,
        provider: { id: p.id, label: p.label, key: maskKey(p.apiKey) },
        providers: Object.entries(PROVIDER_PRESETS).map(([id, pr]) => ({
          id, label: pr.label,
          hasKey: Boolean(resolveProvider(cfg, id).apiKey) || Boolean(pr.keyOptional),
        })),
        mode: cfg.permissions.mode,
        modes: Object.entries(MODES).map(([id, m]) => ({ id, ...m })),
        models: (PROVIDER_PRESETS[cfg.provider]?.models ?? []).map((m) => ({ id: m.id, label: m.label })),
        webTheme: cfg.webTheme,
        themes: Object.entries(WEB_THEMES).map(([id, t]) => ({ id, label: t.label, description: t.description })),
        messages: session.messages.filter((m) => m.role === 'user' || (m.role === 'assistant' && m.content)),
        todos: session.todos,
        usage: session.usage,
        running: agent.running,
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/message') {
      const body = await readBody(req);
      if (agent.running) return json(res, { error: 'Агент занят' }, 409);

      json(res, { ok: true });
      agent
        .send(String(body.text ?? ''))
        .then((r) => broadcast('done', { steps: r.steps, interrupted: r.interrupted }))
        .catch((e) => broadcast('error', { message: e.message, hint: e.hint }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/confirm') {
      const body = await readBody(req);
      const resolve = pending.get(body.id);
      if (resolve) {
        pending.delete(body.id);
        resolve(body.answer === 'always' ? 'always' : body.answer === 'yes' ? 'yes' : 'no');
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

      if (body.model) { cfg.model = body.model; session.model = body.model; }
      if (body.mode && MODES[body.mode]) cfg.permissions.mode = body.mode;
      if (body.webTheme && WEB_THEMES[body.webTheme]) cfg.webTheme = body.webTheme;
      saveConfig(cfg);

      const rp = resolveProvider(cfg);
      return json(res, {
        ok: true,
        model: cfg.model,
        mode: cfg.permissions.mode,
        webTheme: cfg.webTheme,
        provider: {
          id: rp.id, label: rp.label,
          hasKey: Boolean(rp.apiKey) || Boolean(PROVIDER_PRESETS[rp.id]?.keyOptional),
        },
        models: (PROVIDER_PRESETS[cfg.provider]?.models ?? []).map((m) => ({ id: m.id, label: m.label })),
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/clear') {
      session.messages = [];
      session.todos = [];
      return json(res, { ok: true });
    }

    if (url.pathname === '/api/models') {
      try {
        const models = await new Provider(cfg).listModels();
        return json(res, { models });
      } catch (e) {
        return json(res, { error: e.message }, 502);
      }
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Не найдено');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, listenHost, resolve);
  });

  const url = `http://${listenHost}:${server.address().port}/?token=${token}`;

  if (cfg.web?.autoOpen) openBrowser(url);

  return { url, token, server, agent, session, close: () => server.close() };
}



function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 5_000_000) throw new Error('Слишком большой запрос');
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    return {};
  }
}


const PLAIN_THEME = createTheme('minimal');

function renderDiffPlain(before, after) {
  const { text, adds, dels } = renderDiff(before ?? '', after ?? '', PLAIN_THEME, {
    context: 3, maxLines: 200, indent: '',
  });
  return { text: stripAnsi(text), adds, dels };
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch { /* не смогли открыть — не беда, ссылка есть в терминале */ }
}
