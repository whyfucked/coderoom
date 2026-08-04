import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from './config.mjs';

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web-ui');

const cache = new Map();
function asset(name) {
  if (!cache.has(name)) cache.set(name, fs.readFileSync(path.join(UI_DIR, name), 'utf8'));
  return cache.get(name);
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** JSON, безопасный для вставки внутрь <script>. */
const jsonForScript = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028|\u2029/g, (c) => '\\u' + c.charCodeAt(0).toString(16));

const projectName = (cwd) => String(cwd).split(/[\\/]/).filter(Boolean).pop() || cwd;

export function clientHtml({ token, cfg, cwd, themes, modes, sessionId = '', contextLimit } = {}) {
  const themeId = themes[cfg.webTheme] ? cfg.webTheme : 'aurora';

  const themeCss = Object.entries(themes)
    .map(([id, t]) => `[data-theme="${id}"]{${Object.entries(t.vars).map(([k, v]) => `${k}:${v}`).join(';')}}`)
    .join('\n');

  const boot = {
    token,
    cwd,
    projectName: projectName(cwd),
    version: VERSION,
    model: cfg.model,
    mode: cfg.permissions.mode,
    theme: themeId,
    sessionId,
    contextLimit: contextLimit ?? cfg.agent?.autoCompactAt ?? 140000,
    themes: Object.entries(themes).map(([id, t]) => ({
      id,
      label: t.label,
      description: t.description,
      colors: [t.vars['--primary'], t.vars['--accent'], t.vars['--bg']],
    })),
    modes: Object.entries(modes).map(([id, m]) => ({ id, label: m.label ?? id, hint: m.hint ?? '' })),
  };

  return `<!DOCTYPE html>
<html lang="ru" data-theme="${esc(themeId)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<meta name="robots" content="noindex,nofollow">
<title>${esc(projectName(cwd))} · CodeRoom</title>
<style>
${themeCss}
${asset('client.css')}
</style>
</head>
<body>

<div id="app">
  <aside class="rail" id="rail">
    <div class="rail-top">
      <div class="brand">
        <span class="brand-mark">CR</span>
        <span class="brand-text">CodeRoom<em>${esc(VERSION)}</em></span>
      </div>
      <span class="spacer"></span>
      <button class="icon-btn only-mobile" id="btnRailClose" type="button" aria-label="Закрыть панель">✕</button>
    </div>

    <div class="project">
      <div class="project-name" id="projName"></div>
      <div class="project-path" id="projPath"></div>
    </div>

    <button class="new-chat" id="btnNew" type="button">
      <span class="plus">+</span><span>Новый диалог</span><span class="spacer"></span><kbd>Ctrl N</kbd>
    </button>

    <nav class="rail-scroll scroll">
      <section class="rail-sec" id="planSec" hidden>
        <h6>План <b id="planCount"></b></h6>
        <ul id="plan"></ul>
      </section>
      <section class="rail-sec">
        <h6>Диалоги</h6>
        <div id="sessions"></div>
      </section>
    </nav>

    <div class="rail-bottom">
      <div class="meter">
        <div class="meter-row">
          <span>контекст <b id="ctxPct" class="mut">0%</b></span>
          <span>↑<b id="tokIn">0</b> ↓<b id="tokOut">0</b></span>
        </div>
        <div class="meter-bar"><div class="meter-fill" id="ctxFill"></div></div>
      </div>
      <div class="rail-actions">
        <button class="flat" id="btnPalette" type="button"><span>Команды</span><span class="spacer"></span><kbd>Ctrl K</kbd></button>
        <button class="flat sq" id="btnSettings" type="button" aria-label="Настройки">⚙</button>
      </div>
    </div>
  </aside>

  <main class="main">
    <header class="topbar">
      <button class="icon-btn only-mobile" id="btnRailOpen" type="button" aria-label="Панель">☰</button>
      <div class="status">
        <i class="dot"></i><span id="statusText">готов</span><span class="elapsed" id="elapsed"></span>
      </div>
      <span class="spacer"></span>
      <button class="chip" id="chipModel" type="button" title="Сменить модель"><span class="lbl">модель</span><b></b></button>
      <button class="chip" id="chipMode" type="button" title="Права агента"><span class="lbl">права</span><b></b></button>
      <button class="chip sq" id="chipTheme" type="button" title="Оформление" aria-label="Оформление">◑</button>
    </header>

    <div class="feed scroll" id="feed"><div class="feed-inner" id="feedInner"></div></div>

    <div class="composer-wrap">
      <div class="composer-inner">
        <div class="suggest scroll" id="suggest" hidden></div>
        <div class="composer">
          <span class="glyph">›</span>
          <textarea id="input" rows="1" placeholder="Что нужно сделать?" autofocus
            autocomplete="off" spellcheck="false"></textarea>
          <button class="send" id="btnSend" type="button" title="Отправить (Enter)">↑</button>
        </div>
        <div class="composer-hint">
          <span class="k"><kbd>@</kbd> файл</span>
          <span class="k"><kbd>/</kbd> команда</span>
          <span class="k"><kbd>Enter</kbd> отправить</span>
          <span class="k"><kbd>Shift</kbd>+<kbd>Enter</kbd> перенос</span>
          <span class="k"><kbd>Esc</kbd> прервать</span>
          <span class="k"><kbd>Ctrl</kbd>+<kbd>K</kbd> команды</span>
        </div>
      </div>
    </div>
  </main>
</div>

<div class="overlay" id="overlay" hidden></div>
<div id="toasts"></div>

<script>
const BOOT = ${jsonForScript(boot)};
</script>
<script>
${asset('client.js')}
</script>
</body>
</html>`;
}
