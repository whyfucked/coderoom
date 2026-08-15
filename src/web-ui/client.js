/*
  CodeRoom · клиент веб-интерфейса.
  Обычный файл — грузится как есть, поэтому здесь нет экранирования шаблонных строк.
  Состояние живёт в S, лента — в feed, связь с сервером — SSE + fetch.
*/

/* global BOOT */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const S = {
  running: false,
  connected: true,
  model: BOOT.model,
  mode: BOOT.mode,
  theme: BOOT.theme,
  provider: null,
  providers: [],
  models: [],
  sessions: [],
  sessionId: BOOT.sessionId,
  usage: { input: 0, output: 0 },
  contextTokens: 0,
  startedAt: 0,
  lastSeq: 0,
};

const feed = $('#feed');
const inner = $('#feedInner');
const input = $('#input');

/* ─────────────────────────  мелкие утилиты  ───────────────────────── */

function el(tag, attrs, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const kfmt = (n) => (n >= 1_000_000 ? (n / 1e6).toFixed(1) + 'M'
  : n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n || 0));

const clock = (d = new Date()) =>
  String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');

function secs(ms) {
  if (ms < 950) return Math.max(0, Math.round(ms / 100) / 10) + 'с';
  if (ms < 60_000) return (ms / 1000).toFixed(ms < 10_000 ? 1 : 0) + 'с';
  return Math.floor(ms / 60_000) + 'м ' + Math.round((ms % 60_000) / 1000) + 'с';
}

function ago(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '';
  const m = Math.round(ms / 60_000);
  if (m < 1) return 'только что';
  if (m < 60) return m + ' мин назад';
  const h = Math.round(m / 60);
  if (h < 24) return h + ' ч назад';
  return Math.round(h / 24) + ' дн назад';
}

async function api(path, body, method) {
  const res = await fetch(path + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(BOOT.token), {
    method: method || (body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', 'X-CodeRoom-Token': BOOT.token },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json().catch(() => ({}));
}

function toast(text, kind) {
  const t = el('div', { class: 'toast ' + (kind || ''), text });
  $('#toasts').append(t);
  setTimeout(() => {
    t.style.transition = 'opacity .3s';
    t.style.opacity = '0';
    setTimeout(() => t.remove(), 300);
  }, kind === 'error' ? 6000 : 3000);
}

async function copy(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = el('textarea', { text });
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    try { document.execCommand('copy'); } catch { /* не вышло */ }
    ta.remove();
  }
  if (btn) {
    const was = btn.textContent;
    btn.textContent = 'скопировано';
    btn.classList.add('done');
    setTimeout(() => { btn.textContent = was; btn.classList.remove('done'); }, 1400);
  }
}

/* ─────────────────────────  markdown  ───────────────────────── */

function inlineMd(src) {
  const code = [];
  let s = esc(src).replace(/`([^`\n]+)`/g, (_, c) => {
    code.push('<code>' + c + '</code>');
    return '\u0000' + (code.length - 1) + '\u0000';
  });

  s = s
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      (_, t, u) => '<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + t + '</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g,
      (_, p, u) => p + '<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + u + '</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');

  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => code[+i]);
}

function codeCard(lang, body) {
  const card = el('div', { class: 'code' });
  const btn = el('button', { class: 'copy', text: 'копировать', type: 'button' });
  btn.addEventListener('click', () => copy(body, btn));
  card.append(
    el('div', { class: 'code-top' }, el('span', { text: lang || 'код' }), el('span', { class: 'spacer' }), btn),
    el('pre', {}, el('code', { text: body })),
  );
  return card;
}

/* Блочный разбор. Возвращает DocumentFragment, чтобы блоки кода были живыми узлами. */
function md(src) {
  const out = document.createDocumentFragment();
  const lines = String(src ?? '').split('\n');
  let i = 0;
  const html = (s) => { const d = el('div'); d.innerHTML = s; out.append(...d.childNodes); };

  while (i < lines.length) {
    const line = lines[i];

    const fence = /^\s*(?:```|~~~)\s*([\w+.#-]*)\s*$/.exec(line);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !/^\s*(?:```|~~~)\s*$/.test(lines[i])) body.push(lines[i++]);
      i++;
      out.append(codeCard(fence[1], body.join('\n')));
      continue;
    }

    if (!line.trim()) { i++; continue; }

    const head = /^(#{1,4})\s+(.*)$/.exec(line);
    if (head) {
      const lvl = Math.min(head[1].length, 3);
      html('<h' + lvl + '>' + inlineMd(head[2]) + '</h' + lvl + '>');
      i++;
      continue;
    }

    if (/^\s*(?:[-*_]\s*){3,}$/.test(line)) { html('<hr>'); i++; continue; }

    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      html('<blockquote>' + inlineMd(buf.join('\n')).replace(/\n/g, '<br>') + '</blockquote>');
      continue;
    }

    /* таблица: | a | b |  +  разделитель */
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
      const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head2 = cells(lines[i]);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      html('<table><thead><tr>' + head2.map((c) => '<th>' + inlineMd(c) + '</th>').join('') +
        '</tr></thead><tbody>' + rows.map((r) => '<tr>' + r.map((c) => '<td>' + inlineMd(c) + '</td>').join('') + '</tr>').join('') +
        '</tbody></table>');
      continue;
    }

    const bullet = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      const ordered = /\d/.test(bullet[2]);
      const items = [];
      while (i < lines.length) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (!m || /\d/.test(m[2]) !== ordered) break;
        const buf = [m[3]];
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*(?:[-*+]|\d+[.)])\s/.test(lines[i])) {
          buf.push(lines[i++].trim());
        }
        items.push(buf.join('\n'));
      }
      const tag = ordered ? 'ol' : 'ul';
      html('<' + tag + '>' + items.map((t) => '<li>' + inlineMd(t).replace(/\n/g, '<br>') + '</li>').join('') + '</' + tag + '>');
      continue;
    }

    const buf = [];
    while (i < lines.length && lines[i].trim() &&
      !/^\s*(?:```|~~~|#{1,4}\s|>\s?|[-*+]\s|\d+[.)]\s|\|)/.test(lines[i])) buf.push(lines[i++]);
    if (!buf.length) buf.push(lines[i++]);
    html('<p>' + inlineMd(buf.join('\n')).replace(/\n/g, '<br>') + '</p>');
  }
  return out;
}

/* ─────────────────────────  лента  ───────────────────────── */

let stream = null;          // текущий блок ответа агента
let streamBuf = '';
const tools = new Map();    // id вызова -> { node, startedAt }

const atBottom = () => feed.scrollHeight - feed.scrollTop - feed.clientHeight < 140;
function scroll(force) {
  if (force || atBottom()) requestAnimationFrame(() => { feed.scrollTop = feed.scrollHeight; });
}

function entry(kind, body, at) {
  const row = el('article', { class: 'ev ' + kind },
    el('div', { class: 'gut', text: clock(at ? new Date(at) : new Date()) }),
    el('div', { class: 'body' }, body));
  inner.append(row);
  return row;
}

function clearFeed() {
  inner.replaceChildren();
  tools.clear();
  stream = null;
  streamBuf = '';
}

function showHello() {
  const starters = [
    ['Разберись в проекте', 'прочитай структуру и объясни, как всё устроено'],
    ['Найди и исправь баг', 'опиши симптом — найду причину и починю'],
    ['Напиши тесты', 'покрою тестами то, что уже написано'],
    ['Отрефактори кусок', 'назови файл — приведу в порядок, не сломав'],
  ];
  const box = el('div', { class: 'hello' },
    el('h1', {}, 'Что делаем в ', el('span', { text: BOOT.projectName }), '?'),
    el('p', { text: 'Читаю и правлю файлы прямо в этой папке, запускаю команды, показываю каждый шаг. Перед изменениями спрошу.' }),
    el('div', { class: 'starters' }, starters.map(([t, h]) =>
      el('button', {
        class: 'starter', type: 'button',
        onclick: () => { input.value = t + ' — ' + h; input.focus(); autosize(); },
      }, el('b', { text: t }), el('span', { text: h })))),
  );
  inner.append(box);
}

function addUser(text, at) {
  closeStream();
  $('.hello')?.remove();
  entry('user', el('div', { class: 'said' }, el('div', { class: 'txt', text })), at);
  scroll(true);
}

function proseBox() {
  if (stream) return stream;
  const box = el('div', { class: 'prose streaming' });
  entry('agent live', box);
  stream = box;
  streamBuf = '';
  return box;
}

function closeStream() {
  if (stream) {
    stream.classList.remove('streaming');
    stream.closest('.ev')?.classList.remove('live');
  }
  stream = null;
  streamBuf = '';
}

/* Финальный текст ответа: если блок уже стримился — заменяем его содержимое, а не плодим второй. */
function addAssistant(text, at) {
  if (stream) {
    stream.replaceChildren(md(text));
    closeStream();
    return;
  }
  const box = el('div', { class: 'prose' });
  box.append(md(text));
  entry('agent', box, at);
}

function note(text, level, at) {
  closeStream();
  entry('notice', el('div', { class: 'note ' + (level || ''), text }), at);
  scroll();
}

/* дифф из renderDiff(): "+ 12 текст" / "- 12 текст" / "  12 текст" */
function diffBox(text) {
  const box = el('div', { class: 'diff' });
  for (const raw of String(text || '').split('\n')) {
    const m = /^([+\- ])\s*(\d+) ?(.*)$/.exec(raw);
    if (!m) {
      if (raw.trim()) box.append(el('div', { class: 'ln skip' }, el('span', { text: raw.trim() })));
      continue;
    }
    const kind = m[1] === '+' ? 'add' : m[1] === '-' ? 'del' : 'ctx';
    box.append(el('div', { class: 'ln ' + kind },
      el('i', { text: m[2] }),
      el('span', { text: m[3] })));
  }
  return box;
}

function toolStart(d) {
  closeStream();
  const card = el('div', { class: 'tool' });
  const stat = el('span', { class: 'tool-stat' }, el('span', { class: 'spin' }));
  const head = el('button', { class: 'tool-head', type: 'button' },
    el('span', { class: 'tool-caret', text: '▶' }),
    el('span', { class: 'tool-name', text: d.name }),
    el('span', { class: 'tool-arg', text: d.label || '' }),
    stat);
  const body = el('div', { class: 'tool-body' });
  head.addEventListener('click', () => card.classList.toggle('open'));
  card.append(head, body);

  const row = entry('tool live', card);
  tools.set(d.id, { card, body, stat, row, startedAt: performance.now() });
  scroll();
}

function toolFinish(id, ok) {
  const t = tools.get(id);
  if (!t) return null;
  t.row.classList.remove('live');
  t.row.classList.add(ok ? 'done' : 'err');
  if (!ok) t.card.classList.add('err');
  t.stat.replaceChildren();
  const took = performance.now() - t.startedAt;
  if (took > 400) t.stat.append(el('span', { class: 'mut', text: secs(took) }));
  return t;
}

function toolResult(d) {
  const t = toolFinish(d.id, true);
  if (!t) return;
  if (d.diff) {
    t.stat.prepend(el('span', { class: 'ok', text: '+' + d.diff.adds }),
      el('span', { class: 'bad', text: '−' + d.diff.dels }));
    t.body.classList.add('diff');
    t.body.replaceChildren(diffBox(d.diff.text));
    if (d.path) {
      const btn = el('button', { class: 'copy', type: 'button', text: 'копировать путь' });
      btn.addEventListener('click', () => copy(d.path, btn));
      t.card.append(el('div', { class: 'tool-file' }, el('span', { text: d.path }), el('span', { class: 'spacer' }), btn));
    }
    t.card.classList.add('open');
  } else {
    const out = String(d.output ?? '');
    const n = out ? out.split('\n').length : 0;
    if (n > 1) t.stat.prepend(el('span', { text: n + ' стр.' }));
    t.body.textContent = out || '(пусто)';
  }
  scroll();
}

function toolError(d) {
  const t = toolFinish(d.id, false);
  if (!t) return;
  t.stat.prepend(el('span', { class: 'bad', text: 'ошибка' }));
  t.body.textContent = d.error;
  t.card.classList.add('open');
  scroll();
}

/* ─────────────────────────  подтверждения  ───────────────────────── */

let pendingAsk = null;

function askCard(d) {
  closeStream();
  const card = el('div', { class: 'ask' });
  const p = d.preview;

  card.append(el('div', { class: 'ask-top' },
    el('h4', {}, d.danger
      ? el('span', { class: 'danger', text: '⚠ ' + d.danger })
      : 'Разрешить ' + d.tool + '?'),
    el('div', { class: 'why', text: d.reason || d.label || '' })));

  if (p && p.kind === 'bash') {
    card.append(el('pre', { text: p.command }));
  } else if (p && p.diff) {
    card.append(el('div', { class: 'tool-file' },
      el('span', { text: (p.existed ? 'изменить ' : 'создать ') + p.path }),
      el('span', { class: 'spacer' }),
      el('span', { class: 'ok', text: '+' + p.diff.adds }),
      el('span', { class: 'bad', text: '−' + p.diff.dels })));
    card.append(el('div', { class: 'diffbox' }, diffBox(p.diff.text)));
  }

  const answer = (a, label) => {
    if (!pendingAsk || pendingAsk.id !== d.id) return;
    pendingAsk = null;
    card.classList.add('answered');
    $$('button', card).forEach((b) => { b.disabled = true; });
    card.querySelector('.ask-btns').replaceChildren(el('div', { class: 'note ' + (a === 'no' ? 'error' : 'success'), text: label }));
    api('/api/confirm', { id: d.id, answer: a });
    input.focus();
  };

  const yes = el('button', { class: 'btn pri', type: 'button', onclick: () => answer('yes', 'разрешено') },
    'Разрешить', el('kbd', { text: 'Y' }));
  card.append(el('div', { class: 'ask-btns' },
    yes,
    el('button', { class: 'btn', type: 'button', onclick: () => answer('always', 'разрешено, больше не спрашиваю') },
      'Всегда для таких', el('kbd', { text: 'A' })),
    el('button', { class: 'btn no', type: 'button', onclick: () => answer('no', 'отклонено') },
      'Отклонить', el('kbd', { text: 'N' }))));

  entry('ask live', card);
  pendingAsk = { id: d.id, yes, always: card.querySelectorAll('.btn')[1], no: card.querySelector('.btn.no') };
  scroll(true);
  yes.focus({ preventScroll: true });
}

/* ─────────────────────────  состояние шапки и панели  ───────────────────────── */

let elapsedTimer = null;

function setBusy(on, label) {
  S.running = on;
  document.body.classList.toggle('busy', on);
  $('#statusText').textContent = on ? (label || 'работаю') : (S.connected ? 'готов' : 'нет связи');
  const send = $('#btnSend');
  send.classList.toggle('stop', on);
  send.textContent = on ? '■' : '↑';
  send.title = on ? 'Остановить (Esc)' : 'Отправить (Enter)';

  if (on && !elapsedTimer) {
    S.startedAt = S.startedAt || Date.now();
    elapsedTimer = setInterval(() => {
      $('#elapsed').textContent = secs(Date.now() - S.startedAt);
      for (const t of tools.values()) {
        if (t.row.classList.contains('live')) {
          const took = performance.now() - t.startedAt;
          if (took > 900) t.stat.querySelector('.spin').title = secs(took);
        }
      }
    }, 200);
  }
  if (!on) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
    S.startedAt = 0;
    $('#elapsed').textContent = '';
  }
}

function renderTodos(todos) {
  const sec = $('#planSec');
  const list = $('#plan');
  if (!todos || !todos.length) { sec.hidden = true; list.replaceChildren(); return; }
  sec.hidden = false;
  const icon = { completed: '✓', in_progress: '▸', pending: '○' };
  const done = todos.filter((t) => t.status === 'completed').length;
  $('#planCount').textContent = done + '/' + todos.length;
  list.replaceChildren(...todos.map((t) => el('li', { class: 'todo ' + (t.status || 'pending') },
    el('i', { text: icon[t.status] || '○' }),
    el('span', { text: t.content }))));
}

function renderUsage() {
  $('#tokIn').textContent = kfmt(S.usage.input);
  $('#tokOut').textContent = kfmt(S.usage.output);
  const pct = Math.min(100, Math.round((S.contextTokens / BOOT.contextLimit) * 100));
  $('#ctxFill').style.width = pct + '%';
  $('#ctxPct').textContent = pct + '%';
  $('#ctxPct').className = pct > 85 ? 'bad' : pct > 60 ? 'mut' : 'mut';
}

function renderChips() {
  $('#chipModel').querySelector('b').textContent = S.model;
  const m = BOOT.modes.find((x) => x.id === S.mode);
  $('#chipMode').querySelector('b').textContent = m ? m.label : S.mode;
  $('#chipMode').classList.toggle('warn', S.mode === 'yolo');

  // Update health chip
  if (S.modelHealth && S.modelHealth.models) {
    const models = S.modelHealth.models;
    const working = Object.values(models).filter(m => m.ok).length;
    const total = Object.keys(models).length;
    $('#chipHealth').querySelector('b').textContent = working + '/' + total;
    $('#chipHealth').classList.toggle('warn', working < total);
  }
}

function renderSessions() {
  const list = $('#sessions');
  if (!S.sessions.length) {
    list.replaceChildren(el('div', { class: 'sess', text: 'пока пусто' }));
    return;
  }
  list.replaceChildren(...S.sessions.slice(0, 25).map((s) => el('button', {
    class: 'sess' + (s.id === S.sessionId ? ' cur' : ''),
    type: 'button',
    title: s.title,
    onclick: () => openSession(s.id),
  },
  el('div', { class: 'sess-title', text: s.title || '(без названия)' }),
  el('div', { class: 'sess-meta', text: ago(s.updatedAt) + ' · ' + s.messages + ' запр.' }))));
}

async function refreshSessions() {
  const r = await api('/api/sessions');
  S.sessions = r.sessions || [];
  renderSessions();
}

/* ─────────────────────────  сессии  ───────────────────────── */

async function openSession(id) {
  if (S.running) { toast('Сначала останови текущий запуск', 'error'); return; }
  const r = await api('/api/session', { id });
  if (r.error) return toast(r.error, 'error');
  await hydrate();
  closeRail();
}

async function newSession() {
  if (S.running) { toast('Сначала останови текущий запуск', 'error'); return; }
  await api('/api/session', { fresh: true });
  await hydrate();
  closeRail();
  input.focus();
}

/* Полная перерисовка из состояния сервера. */
async function hydrate() {
  const s = await api('/api/state');
  if (s.error) return toast(s.error, 'error');

  S.model = s.model;
  S.mode = s.mode;
  S.provider = s.provider && s.provider.id;
  S.providers = s.providers || [];
  S.models = s.models && s.models.length ? s.models : S.models;
  S.modelHealth = s.modelHealth || { checkedAt: null, models: {} };
  S.usage = s.usage || S.usage;
  S.contextTokens = s.contextTokens || 0;
  S.sessionId = s.sessionId;
  S.lastSeq = s.seq || 0;

  clearFeed();
  renderChips();
  renderUsage();
  renderTodos(s.todos);

  if (s.history && s.history.length) {
    for (const ev of s.history) apply(ev.event, ev.data, ev.at);
  } else if (s.messages && s.messages.length) {
    for (const m of s.messages) {
      if (m.role === 'user') addUser(m.content);
      else if (m.content) addAssistant(m.content);
    }
  } else {
    showHello();
  }

  setBusy(Boolean(s.running));
  scroll(true);
  S.sessions = s.sessions || S.sessions;
  renderSessions();
}

/* ─────────────────────────  события сервера  ───────────────────────── */

function apply(name, d, at) {
  switch (name) {
    case 'user':
      addUser(d.text, at);
      break;
    case 'text': {
      const box = proseBox();
      streamBuf += d.delta;
      box.replaceChildren(md(streamBuf));
      scroll();
      break;
    }
    case 'assistant':
      addAssistant(d.text, at);
      break;
    case 'step':
      setBusy(true, d.n > 1 ? 'шаг ' + d.n : 'думаю');
      break;
    case 'reasoning':
      setBusy(true, 'размышляю');
      break;
    case 'tool_start':
      toolStart(d);
      break;
    case 'tool_progress': {
      const t = tools.get(d.id);
      if (t) { t.body.textContent += d.chunk; t.card.classList.add('open'); }
      break;
    }
    case 'tool_result':
      toolResult(d);
      break;
    case 'tool_error':
      toolError(d);
      break;
    case 'todos':
      renderTodos(d.todos);
      break;
    case 'notice':
      note(d.text, d.level, at);
      break;
    case 'usage':
      S.usage = d.total;
      S.contextTokens = d.contextTokens || S.contextTokens;
      renderUsage();
      break;
    case 'confirm':
      askCard(d);
      break;
    case 'done':
      closeStream();
      setBusy(false);
      if (d.interrupted) note('Остановлено.', 'warn');
      refreshSessions();
      break;
    case 'error':
      closeStream();
      setBusy(false);
      note(d.message + (d.hint ? ' — ' + d.hint : ''), 'error');
      toast(d.message, 'error');
      break;
    default:
      break;
  }
}

function connect() {
  const es = new EventSource('/events?token=' + encodeURIComponent(BOOT.token));
  const names = ['user', 'text', 'assistant', 'step', 'reasoning', 'tool_start', 'tool_progress',
    'tool_result', 'tool_error', 'todos', 'notice', 'usage', 'confirm', 'done', 'error'];

  for (const n of names) {
    es.addEventListener(n, (e) => {
      S.lastSeq = Number(e.lastEventId) || S.lastSeq;
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      apply(n, data);
    });
  }

  es.addEventListener('resync', () => { hydrate(); });

  es.addEventListener('open', () => {
    if (!S.connected) {
      S.connected = true;
      document.body.classList.remove('offline');
      setBusy(S.running);
      hydrate();
    }
  });

  es.addEventListener('error', () => {
    if (es.readyState === EventSource.CLOSED || es.readyState === EventSource.CONNECTING) {
      S.connected = false;
      document.body.classList.add('offline');
      $('#statusText').textContent = 'нет связи';
    }
  });
}

/* ─────────────────────────  отправка  ───────────────────────── */

function autosize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 220) + 'px';
}

async function send() {
  const text = input.value.trim();
  if (S.running) { api('/api/interrupt', {}); return; }
  if (!text) return;

  if (text.startsWith('/')) {
    const handled = await runSlash(text);
    if (handled) { input.value = ''; autosize(); return; }
  }

  input.value = '';
  autosize();
  hideSuggest();
  S.startedAt = Date.now();
  setBusy(true, 'думаю');
  /* Само сообщение нарисует событие 'user' с сервера — так одинаково во всех вкладках. */

  const r = await api('/api/message', { text });
  if (r.error) { setBusy(false); note(r.error, 'error'); }
}

/* ─────────────────────────  слэш-команды  ───────────────────────── */

const COMMANDS = [
  { key: '/new', desc: 'новый диалог', run: newSession },
  { key: '/clear', desc: 'очистить историю текущего диалога', run: clearHistory },
  { key: '/model', desc: 'сменить модель', run: () => palette('model') },
  { key: '/mode', desc: 'права агента', run: () => palette('mode') },
  { key: '/theme', desc: 'оформление', run: () => palette('theme') },
  { key: '/sessions', desc: 'прошлые диалоги', run: () => palette('session') },
  { key: '/settings', desc: 'настройки и ключ', run: openSettings },
  { key: '/health', desc: 'здоровье моделей', run: showModelHealth },
  { key: '/stop', desc: 'прервать агента', run: () => api('/api/interrupt', {}) },
];

async function runSlash(text) {
  const name = text.split(/\s+/)[0].toLowerCase();
  const cmd = COMMANDS.find((c) => c.key === name);
  if (!cmd) return false;
  await cmd.run();
  return true;
}

async function clearHistory() {
  await api('/api/clear', {});
  clearFeed();
  showHello();
  renderTodos([]);
  toast('История очищена');
}

async function showModelHealth() {
  try {
    const res = await fetch('/api/model-health?token=' + encodeURIComponent(BOOT.token));
    const data = await res.json();
    if (!data.models) return toast('Нет данных о здоровье моделей', 'error');

    const models = data.models;
    const working = Object.values(models).filter(m => m.ok).length;
    const total = Object.keys(models).length;
    const checkedAt = data.checkedAt ? new Date(data.checkedAt).toLocaleString('ru-RU') : 'неизвестно';

    const rows = [];
    const byUpstream = {};
    for (const [modelId, info] of Object.entries(models)) {
      const up = info.upstream || 'unknown';
      if (!byUpstream[up]) byUpstream[up] = [];
      byUpstream[up].push({ modelId, ...info });
    }

    for (const [up, list] of Object.entries(byUpstream)) {
      rows.push(el('div', { class: 'grp' }, up));
      for (const m of list) {
        rows.push(el('div', { class: 'row' + (m.ok ? ' ok' : ' err') },
          el('div', { class: 'mid' },
            el('div', { class: 't', text: m.modelId }),
            el('div', { class: 'h', text: m.ok ? 'работает' : 'ошибка: ' + (m.error || m.status) })
          ),
          el('span', { class: m.ok ? 'ok' : 'bad', text: m.ok ? '���' : '���' })
        ));
      }
    }

    sheet('Здоровье моделей', '🩺', [
      el('div', { class: 'kv' }, el('b', { text: 'Проверено' }), el('span', { text: checkedAt })),
      el('div', { class: 'kv' }, el('b', { text: 'Рабочих / Всего' }), el('span', { text: working + ' / ' + total })),
      ...rows
    ], [el('button', { class: 'btn pri', type: 'button', text: 'Закрыть', onclick: closeOverlay })]);
  } catch (e) {
    toast('Ошибка: ' + e.message, 'error');
  }
}

/* ─────────────────────────  подсказки в поле ввода  ───────────────────────── */

const sug = $('#suggest');
let sugItems = [];
let sugIdx = 0;
let sugKind = null;
let fileReq = 0;

function hideSuggest() {
  sug.hidden = true;
  sugItems = [];
  sugKind = null;
}

function drawSuggest(items, kind) {
  sugItems = items;
  sugKind = kind;
  sugIdx = 0;
  if (!items.length) return hideSuggest();
  sug.hidden = false;
  paintSuggest();
}

function paintSuggest() {
  sug.replaceChildren(...sugItems.map((it, n) => el('div', {
    class: 'sug' + (n === sugIdx ? ' on' : ''),
    onmousedown: (e) => { e.preventDefault(); acceptSuggest(n); },
  },
  el('span', { class: 'key', text: it.key }),
  el('span', { class: 'desc', text: it.desc || '' }))));
  sug.querySelector('.sug.on')?.scrollIntoView({ block: 'nearest' });
}

function acceptSuggest(n) {
  const it = sugItems[n ?? sugIdx];
  if (!it) return;
  if (sugKind === 'cmd') {
    input.value = it.key + ' ';
  } else {
    const caret = input.selectionStart;
    const before = input.value.slice(0, caret).replace(/@[^\s@]*$/, '@' + it.key + ' ');
    input.value = before + input.value.slice(caret);
    input.setSelectionRange(before.length, before.length);
  }
  hideSuggest();
  autosize();
  input.focus();
}

async function updateSuggest() {
  const caret = input.selectionStart;
  const before = input.value.slice(0, caret);

  const cmd = /^\/(\w*)$/.exec(input.value.trim());
  if (cmd && caret <= input.value.trim().length) {
    const q = cmd[1].toLowerCase();
    return drawSuggest(COMMANDS.filter((c) => c.key.slice(1).startsWith(q)), 'cmd');
  }

  const at = /@([^\s@]*)$/.exec(before);
  if (at) {
    const my = ++fileReq;
    const r = await api('/api/files?q=' + encodeURIComponent(at[1]));
    if (my !== fileReq) return;
    return drawSuggest((r.files || []).map((f) => ({ key: f, desc: '' })), 'file');
  }

  hideSuggest();
}

/* ─────────────────────────  палитра команд  ───────────────────────── */

const overlay = $('#overlay');
let paletteRows = [];
let paletteIdx = 0;

function closeOverlay() {
  overlay.hidden = true;
  overlay.replaceChildren();
  input.focus();
}

function sheet(title, glyph, bodyNodes, footNodes, mode) {
  overlay.className = 'overlay ' + (mode || 'mid');
  overlay.hidden = false;
  const body = el('div', { class: 'sheet-body scroll' }, bodyNodes);
  const box = el('div', { class: 'sheet' },
    el('div', { class: 'sheet-head' },
      typeof title === 'string' ? el('span', { class: 'glyph', text: glyph }) : null,
      typeof title === 'string' ? el('h3', { text: title }) : title,
      el('span', { class: 'spacer' }),
      el('button', { class: 'icon-btn', type: 'button', text: '✕', onclick: closeOverlay, 'aria-label': 'Закрыть' })),
    body,
    footNodes ? el('div', { class: 'sheet-foot' }, footNodes) : null);
  overlay.replaceChildren(box);
  return { box, body };
}

overlay.addEventListener('click', (e) => { if (e.target === overlay) closeOverlay(); });

function paletteActions(filter) {
  const list = [];
  const add = (group, key, desc, run, on) => list.push({ group, key, desc, run, on });

  if (!filter || filter === 'cmd') {
    add('Действия', 'Новый диалог', 'Ctrl+N', newSession);
    add('Действия', 'Очистить историю', '', clearHistory);
    add('Действия', 'Настройки', '/settings', openSettings);
    if (S.running) add('Действия', 'Остановить агента', 'Esc', () => api('/api/interrupt', {}));
  }
  if (!filter || filter === 'model') {
    for (const m of S.models) {
      add('Модель', m.label || m.id, m.id, () => setSetting({ model: m.id }), m.id === S.model);
    }
  }
  if (!filter || filter === 'health') {
    add('Здоровье моделей', 'Показать статус', 'проверка работоспособности', showModelHealth);
  }
  if (!filter || filter === 'mode') {
    for (const m of BOOT.modes) add('Права', m.label, m.hint, () => setSetting({ mode: m.id }), m.id === S.mode);
  }
  if (!filter || filter === 'theme') {
    for (const t of BOOT.themes) add('Оформление', t.label, t.description, () => setTheme(t.id), t.id === S.theme);
  }
  if (!filter || filter === 'session') {
    for (const s of S.sessions.slice(0, 12)) {
      add('Диалоги', s.title || '(без названия)', ago(s.updatedAt), () => openSession(s.id), s.id === S.sessionId);
    }
  }
  return list;
}

function palette(filter) {
  const search = el('input', {
    id: 'paletteInput', type: 'text', autocomplete: 'off', spellcheck: 'false',
    placeholder: filter ? 'Фильтр…' : 'Команда, модель, тема, диалог…',
  });
  const { body } = sheet(search, '⌘', [], [
    el('span', {}, el('kbd', { text: '↑↓' }), ' выбрать'),
    el('span', {}, el('kbd', { text: 'Enter' }), ' применить'),
    el('span', {}, el('kbd', { text: 'Esc' }), ' закрыть'),
  ], 'top');

  const all = paletteActions(filter);

  const draw = () => {
    const q = search.value.trim().toLowerCase();
    paletteRows = all.filter((a) => !q ||
      (a.key + ' ' + (a.desc || '') + ' ' + a.group).toLowerCase().includes(q));
    paletteIdx = Math.min(paletteIdx, Math.max(0, paletteRows.length - 1));

    const nodes = [];
    let group = null;
    paletteRows.forEach((a, n) => {
      if (a.group !== group) { group = a.group; nodes.push(el('div', { class: 'grp', text: group })); }
      nodes.push(el('button', {
        class: 'row' + (n === paletteIdx ? ' on' : '') + (a.on ? ' sel' : ''),
        type: 'button',
        onmouseenter: () => { paletteIdx = n; draw(); },
        onclick: async () => { closeOverlay(); await a.run(); },
      },
      el('div', { class: 'mid' }, el('div', { class: 't', text: a.key }), a.desc ? el('div', { class: 'h', text: a.desc }) : null),
      a.on ? el('span', { class: 'tick', text: '✓' }) : null));
    });
    if (!paletteRows.length) nodes.push(el('div', { class: 'grp', text: 'ничего не найдено' }));
    body.replaceChildren(...nodes);
    body.querySelector('.row.on')?.scrollIntoView({ block: 'nearest' });
  };

  search.addEventListener('input', () => { paletteIdx = 0; draw(); });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); paletteIdx = (paletteIdx + 1) % Math.max(1, paletteRows.length); draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); paletteIdx = (paletteIdx - 1 + paletteRows.length) % Math.max(1, paletteRows.length); draw(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const a = paletteRows[paletteIdx];
      if (a) { closeOverlay(); a.run(); }
    }
  });

  draw();
  search.focus();
}

/* ─────────────────────────  настройки  ───────────────────────── */

async function setSetting(patch) {
  const r = await api('/api/settings', patch);
  if (r.error) return toast(r.error, 'error');
  if (r.model) S.model = r.model;
  if (r.mode) S.mode = r.mode;
  if (r.models) S.models = r.models;
  if (r.provider) {
    S.provider = r.provider.id;
    S.providers = S.providers.map((p) => (p.id === r.provider.id ? { ...p, hasKey: r.provider.hasKey } : p));
  }
  renderChips();
  return r;
}

function setTheme(id) {
  S.theme = id;
  document.documentElement.dataset.theme = id;
  api('/api/settings', { webTheme: id });
}

function openSettings() {
  const rows = [];

  rows.push(el('div', { class: 'grp', text: 'Провайдер' }));
  const provs = S.providers.length ? S.providers : [{ id: S.provider, label: S.provider, hasKey: true }];
  for (const p of provs) {
    rows.push(el('button', {
      class: 'row' + (p.id === S.provider ? ' sel' : ''), type: 'button',
      onclick: async () => {
        const body = { provider: p.id };
        if (!p.hasKey) {
          const key = window.prompt('Ключ для ' + (p.label || p.id) + ':');
          if (!key) return;
          body.key = key.trim();
        }
        await setSetting(body);
        openSettings();
      },
    },
    el('div', { class: 'mid' },
      el('div', { class: 't', text: p.label || p.id }),
      el('div', { class: 'h', text: p.hasKey ? p.id : p.id + ' · нужен ключ' })),
    p.id === S.provider ? el('span', { class: 'tick', text: '✓' }) : null));
  }

  rows.push(el('div', { class: 'grp', text: 'Модель' }));
  const models = S.models.length ? S.models : [{ id: S.model, label: S.model }];
  for (const m of models.slice(0, 60)) {
    rows.push(el('button', {
      class: 'row' + (m.id === S.model ? ' sel' : ''), type: 'button',
      onclick: async () => { await setSetting({ model: m.id }); openSettings(); },
    },
    el('div', { class: 'mid' }, el('div', { class: 't', text: m.label || m.id }), el('div', { class: 'h', text: m.id })),
    m.id === S.model ? el('span', { class: 'tick', text: '✓' }) : null));
  }

  rows.push(el('div', { class: 'grp', text: 'Права агента' }));
  for (const m of BOOT.modes) {
    rows.push(el('button', {
      class: 'row' + (m.id === S.mode ? ' sel' : ''), type: 'button',
      onclick: async () => { await setSetting({ mode: m.id }); openSettings(); },
    },
    el('div', { class: 'mid' }, el('div', { class: 't', text: m.label }), el('div', { class: 'h', text: m.hint })),
    m.id === S.mode ? el('span', { class: 'tick', text: '✓' }) : null));
  }

  rows.push(el('div', { class: 'grp', text: 'Оформление' }));
  for (const t of BOOT.themes) {
    rows.push(el('button', {
      class: 'row' + (t.id === S.theme ? ' sel' : ''), type: 'button',
      onclick: () => { setTheme(t.id); openSettings(); },
    },
    el('span', { class: 'swatch' }, (t.colors || []).map((c) => el('i', { style: 'background:' + c }))),
    el('div', { class: 'mid' }, el('div', { class: 't', text: t.label }), el('div', { class: 'h', text: t.description })),
    t.id === S.theme ? el('span', { class: 'tick', text: '✓' }) : null));
  }

  rows.push(el('div', { class: 'grp', text: 'Папка' }));
  rows.push(el('div', { class: 'kv' }, el('b', { text: 'проект' }), el('span', { text: BOOT.cwd })));
  rows.push(el('div', { class: 'kv' }, el('b', { text: 'контекст' }), el('span', { text: kfmt(BOOT.contextLimit) + ' токенов до сжатия' })));

  sheet('Настройки', '⚙', rows, [
    el('button', { class: 'btn', type: 'button', text: 'Очистить историю', onclick: () => { clearHistory(); closeOverlay(); } }),
    el('span', { class: 'spacer' }),
    el('button', { class: 'btn pri', type: 'button', text: 'Готово', onclick: closeOverlay }),
  ]);
}

/* ─────────────────────────  привязка событий  ───────────────────────── */

const closeRail = () => document.body.classList.remove('rail-open');

$('#btnSend').addEventListener('click', send);
$('#btnNew').addEventListener('click', newSession);
$('#btnSettings').addEventListener('click', openSettings);
$('#btnPalette').addEventListener('click', () => palette());
$('#chipModel').addEventListener('click', () => palette('model'));
$('#chipMode').addEventListener('click', () => palette('mode'));
$('#chipHealth').addEventListener('click', showModelHealth);
$('#chipTheme').addEventListener('click', () => palette('theme'));
$('#btnRailOpen').addEventListener('click', () => document.body.classList.toggle('rail-open'));
$('#btnRailClose').addEventListener('click', closeRail);

input.addEventListener('input', () => { autosize(); updateSuggest(); });
input.addEventListener('blur', () => setTimeout(hideSuggest, 120));

input.addEventListener('keydown', (e) => {
  if (!sug.hidden && sugItems.length) {
    if (e.key === 'ArrowDown') { e.preventDefault(); sugIdx = (sugIdx + 1) % sugItems.length; paintSuggest(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); sugIdx = (sugIdx - 1 + sugItems.length) % sugItems.length; paintSuggest(); return; }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); acceptSuggest(); return; }
    if (e.key === 'Escape') { e.preventDefault(); hideSuggest(); return; }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); send(); }
});

document.addEventListener('keydown', (e) => {
  const inField = /^(INPUT|TEXTAREA)$/.test(e.target.tagName);

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    overlay.hidden ? palette() : closeOverlay();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n' && !e.shiftKey) {
    e.preventDefault();
    newSession();
    return;
  }
  if (e.key === 'Escape') {
    if (!overlay.hidden) { closeOverlay(); return; }
    if (document.body.classList.contains('rail-open')) { closeRail(); return; }
    if (S.running) api('/api/interrupt', {});
    return;
  }
  if (pendingAsk && !inField && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const k = e.key.toLowerCase();
    if (k === 'y' || k === 'д') { e.preventDefault(); pendingAsk.yes.click(); }
    else if (k === 'a' || k === 'ф') { e.preventDefault(); pendingAsk.always.click(); }
    else if (k === 'n' || k === 'т') { e.preventDefault(); pendingAsk.no.click(); }
    return;
  }
  if (!inField && overlay.hidden && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
    input.focus();
  }
});

/* ─────────────────────────  старт  ───────────────────────── */

$('#projName').textContent = BOOT.projectName;
$('#projPath').textContent = BOOT.cwd;
$('#projPath').title = BOOT.cwd;
renderChips();

connect();
hydrate().then(() => { refreshSessions(); input.focus(); });
setInterval(refreshSessions, 60_000);
