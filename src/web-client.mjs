const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function clientHtml({ token, cfg, cwd, themes, modes }) {
  const themeCss = Object.entries(themes)
    .map(([id, t]) => `[data-theme="${id}"]{${Object.entries(t.vars).map(([k, v]) => `${k}:${v}`).join(';')}}`)
    .join('\n');

  const bootstrap = JSON.stringify({
    token,
    cwd,
    model: cfg.model,
    mode: cfg.permissions.mode,
    theme: themes[cfg.webTheme] ? cfg.webTheme : 'aurora',
    themes: Object.entries(themes).map(([id, t]) => ({ id, label: t.label, description: t.description })),
    modes: Object.entries(modes).map(([id, m]) => ({ id, label: m.label ?? id, hint: m.hint ?? '' })),
  });

  return `<!DOCTYPE html>
<html lang="ru" data-theme="${esc(themes[cfg.webTheme] ? cfg.webTheme : 'aurora')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CodeRoom — ${esc(cwd.split(/[\\/]/).pop())}</title>
<style>
${themeCss}

*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{
  background:var(--body-bg,var(--bg));color:var(--text);
  font-family:var(--font);font-size:15px;line-height:1.6;
  -webkit-font-smoothing:antialiased;
}
[data-theme="terminal"] body::after{
  content:"";position:fixed;inset:0;pointer-events:none;z-index:99;
  background:repeating-linear-gradient(0deg,rgba(0,0,0,.16) 0 1px,transparent 1px 3px);
}
#app{display:flex;flex-direction:column;height:100vh;max-width:1000px;margin:0 auto;padding:0 20px}

/* ── шапка ── */
header{
  display:flex;align-items:center;gap:14px;padding:16px 4px;
  border-bottom:1px solid var(--border);position:sticky;top:0;z-index:20;
  background:var(--body-bg,var(--bg));
}
.logo{font-weight:700;letter-spacing:-.3px;font-size:17px;color:var(--primary)}
.logo small{color:var(--muted);font-weight:400;font-size:12px;margin-left:6px}
.spacer{flex:1}
.pill{
  display:inline-flex;align-items:center;gap:6px;padding:5px 11px;
  border:1px solid var(--border);border-radius:999px;background:var(--bg-elev);
  color:var(--muted);font-size:12.5px;cursor:pointer;transition:.15s;
  font-family:var(--font);
}
.pill:hover{color:var(--text);border-color:var(--primary)}
.pill b{color:var(--text);font-weight:500}
.dot{width:7px;height:7px;border-radius:50%;background:var(--success)}
.dot.busy{background:var(--warn);animation:pulse 1s infinite}
@keyframes pulse{50%{opacity:.25}}

/* ── лента ── */
#feed{flex:1;overflow-y:auto;padding:22px 4px 8px;scroll-behavior:smooth}
#feed::-webkit-scrollbar{width:9px}
#feed::-webkit-scrollbar-thumb{background:var(--border);border-radius:9px}

.msg{margin-bottom:20px;animation:in .22s ease}
@keyframes in{from{opacity:0;transform:translateY(6px)}}
.msg.user .bubble{
  background:var(--primary-soft);border:1px solid var(--border);
  border-radius:var(--radius);padding:11px 15px;margin-left:auto;max-width:80%;
  width:fit-content;white-space:pre-wrap;word-break:break-word;
}
.msg.assistant .bubble{padding:0 2px}
.role{font-size:11px;text-transform:uppercase;letter-spacing:.7px;color:var(--muted);margin-bottom:6px}
.msg.user .role{text-align:right}

.bubble p{margin:.55em 0}
.bubble h1,.bubble h2,.bubble h3{margin:1em 0 .4em;line-height:1.3}
.bubble h1{font-size:1.35em}.bubble h2{font-size:1.2em}.bubble h3{font-size:1.06em}
.bubble ul,.bubble ol{margin:.5em 0 .5em 1.3em}
.bubble li{margin:.24em 0}
.bubble a{color:var(--accent)}
.bubble code{
  font-family:var(--font-mono);font-size:.88em;background:var(--code-bg);
  padding:2px 5px;border-radius:5px;
}
.bubble pre{
  background:var(--code-bg);border:1px solid var(--border);border-radius:var(--radius);
  padding:13px 15px;overflow-x:auto;margin:.7em 0;
}
.bubble pre code{background:none;padding:0;font-size:13px;line-height:1.55}
.bubble blockquote{border-left:2px solid var(--primary);padding-left:12px;color:var(--muted);margin:.6em 0}

/* ── инструменты ── */
.tool{
  border:1px solid var(--border);border-radius:var(--radius);
  background:var(--bg-elev);margin:10px 0;overflow:hidden;
}
.tool-head{
  display:flex;align-items:center;gap:9px;padding:9px 13px;cursor:pointer;
  font-family:var(--font-mono);font-size:12.5px;
}
.tool-head:hover{background:var(--primary-soft)}
.tool-name{color:var(--primary);font-weight:600}
.tool-arg{color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.tool-stat{font-size:11px;color:var(--muted)}
.tool-body{
  display:none;border-top:1px solid var(--border);padding:11px 13px;
  font-family:var(--font-mono);font-size:12.5px;white-space:pre-wrap;
  max-height:420px;overflow:auto;color:var(--muted);word-break:break-word;
}
.tool.open .tool-body{display:block}
.tool.err .tool-name{color:var(--error)}
.spin{
  width:11px;height:11px;border:2px solid var(--border);border-top-color:var(--primary);
  border-radius:50%;animation:spin .7s linear infinite;flex:none;
}
@keyframes spin{to{transform:rotate(360deg)}}
.ok{color:var(--success)}.bad{color:var(--error)}

.diff{font-family:var(--font-mono);font-size:12.5px;line-height:1.5}
.diff .a{color:var(--success);background:color-mix(in srgb,var(--success) 12%,transparent);display:block}
.diff .d{color:var(--error);background:color-mix(in srgb,var(--error) 12%,transparent);display:block}
.diff .c{color:var(--muted);display:block}

/* ── подтверждение ── */
.confirm{
  border:1px solid var(--primary);border-radius:var(--radius);
  background:var(--bg-glass);backdrop-filter:blur(12px);
  box-shadow:var(--glow);padding:15px;margin:14px 0;
}
.confirm h4{color:var(--primary);font-size:14px;margin-bottom:4px}
.confirm .why{color:var(--muted);font-size:13px;margin-bottom:10px}
.confirm .danger{color:var(--error);font-weight:600}
.confirm pre{
  background:var(--code-bg);border-radius:8px;padding:11px;overflow:auto;
  max-height:300px;font-family:var(--font-mono);font-size:12.5px;margin-bottom:12px;
}
.btns{display:flex;gap:8px;flex-wrap:wrap}
button{
  font-family:var(--font);font-size:13px;padding:8px 15px;border-radius:9px;
  border:1px solid var(--border);background:var(--bg-elev);color:var(--text);
  cursor:pointer;transition:.15s;
}
button:hover{border-color:var(--primary)}
button.yes{background:var(--primary);border-color:var(--primary);color:#fff;font-weight:500}
button.no{color:var(--error)}
button:disabled{opacity:.4;cursor:default}

.notice{color:var(--muted);font-size:13px;padding:6px 2px}
.notice.warn{color:var(--warn)}
.notice.error{color:var(--error)}
.notice.success{color:var(--success)}

/* ── план ── */
#todos{border:1px solid var(--border);border-radius:var(--radius);padding:12px 14px;margin:12px 0;background:var(--bg-elev)}
#todos .t{display:flex;gap:9px;font-size:13.5px;padding:2px 0}
#todos .done{color:var(--muted);text-decoration:line-through}
#todos .cur{color:var(--warn)}

/* ── ввод ── */
footer{padding:12px 4px 18px;border-top:1px solid var(--border);background:var(--body-bg,var(--bg))}
.inputwrap{
  display:flex;gap:10px;align-items:flex-end;border:1px solid var(--border);
  border-radius:var(--radius);background:var(--bg-elev);padding:10px 12px;transition:.15s;
}
.inputwrap:focus-within{border-color:var(--primary);box-shadow:var(--glow)}
textarea{
  flex:1;background:none;border:none;outline:none;color:var(--text);
  font-family:var(--font);font-size:15px;line-height:1.55;resize:none;
  max-height:190px;min-height:24px;
}
textarea::placeholder{color:var(--muted)}
.send{
  width:34px;height:34px;border-radius:50%;background:var(--primary);color:#fff;
  border:none;display:grid;place-items:center;font-size:15px;flex:none;
}
.hint{font-size:11.5px;color:var(--muted);padding:7px 4px 0;display:flex;gap:14px}
kbd{font-family:var(--font-mono);font-size:10.5px;border:1px solid var(--border);border-radius:4px;padding:1px 4px}

/* ── панель настроек ── */
#panel{
  position:fixed;inset:0;background:rgba(0,0,0,.55);backdrop-filter:blur(4px);
  display:none;place-items:center;z-index:60;padding:20px;
}
#panel.open{display:grid}
.sheet{
  background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);
  max-width:520px;width:100%;padding:22px;box-shadow:0 24px 70px rgba(0,0,0,.5);
  max-height:86vh;overflow:auto;
}
.sheet h3{font-size:16px;margin-bottom:16px;color:var(--primary)}
.sheet section{margin-bottom:20px}
.sheet h5{font-size:12px;text-transform:uppercase;letter-spacing:.6px;color:var(--muted);margin-bottom:8px}
.opt{
  display:flex;gap:11px;align-items:center;padding:9px 11px;border:1px solid var(--border);
  border-radius:10px;margin-bottom:6px;cursor:pointer;transition:.15s;
}
.opt:hover{border-color:var(--primary)}
.opt.sel{border-color:var(--primary);background:var(--primary-soft)}
.opt .t{font-size:13.5px}
.opt .h{font-size:11.5px;color:var(--muted)}
.swatch{display:flex;gap:3px;flex:none}
.swatch i{width:12px;height:12px;border-radius:3px;display:block}
.meta{font-size:11.5px;color:var(--muted);font-family:var(--font-mono);word-break:break-all}
@media(max-width:640px){#app{padding:0 12px}.msg.user .bubble{max-width:92%}}
</style>
</head>
<body>
<div id="app">
  <header>
    <div class="logo">CodeRoom<small>${esc(cwd.split(/[\\/]/).pop())}</small></div>
    <div class="spacer"></div>
    <span class="pill" id="stat"><span class="dot" id="dot"></span><span id="statText">готов</span></span>
    <span class="pill" id="btnModel"><b id="modelLabel"></b></span>
    <span class="pill" id="btnSettings">⚙</span>
  </header>

  <div id="feed"></div>

  <footer>
    <div class="inputwrap">
      <textarea id="input" rows="1" placeholder="Что нужно сделать? Опиши задачу…"></textarea>
      <button class="send" id="btnSend" title="Отправить">↑</button>
    </div>
    <div class="hint">
      <span><kbd>Enter</kbd> отправить</span>
      <span><kbd>Shift</kbd>+<kbd>Enter</kbd> новая строка</span>
      <span><kbd>Esc</kbd> прервать</span>
      <span class="spacer"></span>
      <span id="usage"></span>
    </div>
  </footer>
</div>

<div id="panel"><div class="sheet" id="sheet"></div></div>

<script>
const BOOT = ${bootstrap};
const $ = (s) => document.querySelector(s);
const feed = $('#feed'), input = $('#input');
let state = { running:false, theme:BOOT.theme, model:BOOT.model, mode:BOOT.mode, models:[], providers:[], provider:null };
let cur = null;          // текущее сообщение ассистента
let curBuf = '';

const api = (path, body) => fetch(path + '?token=' + BOOT.token, {
  method: body ? 'POST' : 'GET',
  headers: { 'Content-Type':'application/json', 'X-CodeRoom-Token': BOOT.token },
  body: body ? JSON.stringify(body) : undefined,
}).then(r => r.json());

/* ─── минимальный markdown ─── */
function md(src){
  const esc = s => s.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  const blocks = [];
  let s = src.replace(/\`\`\`(\\w*)\\n?([\\s\\S]*?)(?:\`\`\`|$)/g, (_,lang,code) => {
    blocks.push('<pre><code>' + esc(code.replace(/\\n$/,'')) + '</code></pre>');
    return '\\u0000' + (blocks.length-1) + '\\u0000';
  });
  s = esc(s)
    .replace(/^###\\s+(.*)$/gm,'<h3>$1</h3>')
    .replace(/^##\\s+(.*)$/gm,'<h2>$1</h2>')
    .replace(/^#\\s+(.*)$/gm,'<h1>$1</h1>')
    .replace(/^&gt;\\s?(.*)$/gm,'<blockquote>$1</blockquote>')
    .replace(/\`([^\`]+)\`/g,'<code>$1</code>')
    .replace(/\\*\\*([^*]+)\\*\\*/g,'<strong>$1</strong>')
    .replace(/(?<![\\w*])\\*([^*\\n]+)\\*(?![\\w*])/g,'<em>$1</em>')
    .replace(/\\[([^\\]]+)\\]\\((https?:[^)]+)\\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/^\\s*[-*+]\\s+(.*)$/gm,'\\u0001<li>$1</li>')
    .replace(/^\\s*\\d+[.)]\\s+(.*)$/gm,'\\u0002<li>$1</li>');
  s = s.replace(/(?:\\u0001<li>.*<\\/li>\\n?)+/g, m => '<ul>' + m.replace(/\\u0001/g,'') + '</ul>')
       .replace(/(?:\\u0002<li>.*<\\/li>\\n?)+/g, m => '<ol>' + m.replace(/\\u0002/g,'') + '</ol>');
  s = s.split(/\\n{2,}/).map(p =>
    /^\\s*<(h\\d|ul|ol|pre|blockquote)/.test(p) ? p : (p.trim() ? '<p>' + p.replace(/\\n/g,'<br>') + '</p>' : '')
  ).join('');
  return s.replace(/\\u0000(\\d+)\\u0000/g, (_,i) => blocks[+i]);
}

const atBottom = () => feed.scrollHeight - feed.scrollTop - feed.clientHeight < 120;
function scroll(force){ if(force || atBottom()) feed.scrollTop = feed.scrollHeight; }

function addUser(text){
  const el = document.createElement('div');
  el.className = 'msg user';
  el.innerHTML = '<div class="role">ты</div><div class="bubble"></div>';
  el.querySelector('.bubble').textContent = text;
  feed.append(el); scroll(true);
}

function bubble(){
  if(cur) return cur;
  const el = document.createElement('div');
  el.className = 'msg assistant';
  el.innerHTML = '<div class="role">агент</div><div class="bubble"></div>';
  feed.append(el);
  cur = el.querySelector('.bubble'); curBuf = '';
  return cur;
}
function endBubble(){ cur = null; curBuf = ''; }

function setBusy(on, label){
  state.running = on;
  $('#dot').className = 'dot' + (on ? ' busy' : '');
  $('#statText').textContent = on ? (label || 'работаю…') : 'готов';
  $('#btnSend').textContent = on ? '■' : '↑';
}

/* ─── SSE ─── */
const es = new EventSource('/events?token=' + BOOT.token);
const on = (n, f) => es.addEventListener(n, e => f(JSON.parse(e.data)));

on('text', d => { const b = bubble(); curBuf += d.delta; b.innerHTML = md(curBuf); scroll(); });
on('step', d => setBusy(true, d.n > 1 ? 'шаг ' + d.n : 'думаю…'));
on('reasoning', () => setBusy(true, 'размышляю…'));

on('tool_start', d => {
  endBubble();
  const el = document.createElement('div');
  el.className = 'tool'; el.id = 't_' + d.id;
  el.innerHTML = '<div class="tool-head"><span class="spin"></span>' +
    '<span class="tool-name"></span><span class="tool-arg"></span><span class="tool-stat"></span></div>' +
    '<div class="tool-body"></div>';
  el.querySelector('.tool-name').textContent = d.name;
  el.querySelector('.tool-arg').textContent = d.label || '';
  el.querySelector('.tool-head').onclick = () => el.classList.toggle('open');
  feed.append(el); scroll();
});

on('tool_result', d => {
  const el = document.getElementById('t_' + d.id); if(!el) return;
  el.querySelector('.spin').outerHTML = '<span class="ok">✓</span>';
  const body = el.querySelector('.tool-body');
  if(d.diff){
    el.querySelector('.tool-stat').innerHTML =
      '<span class="ok">+' + d.diff.adds + '</span> <span class="bad">-' + d.diff.dels + '</span>';
    body.innerHTML = '<div class="diff">' + d.diff.text.split('\\n').map(l => {
      const c = l.startsWith('+') ? 'a' : l.startsWith('-') ? 'd' : 'c';
      return '<span class="' + c + '">' + l.replace(/[&<>]/g, x=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[x])) + '</span>';
    }).join('') + '</div>';
    el.classList.add('open');
  } else {
    const lines = String(d.output).split('\\n');
    el.querySelector('.tool-stat').textContent = lines.length > 1 ? lines.length + ' стр.' : '';
    body.textContent = d.output;
  }
  scroll();
});

on('tool_error', d => {
  const el = document.getElementById('t_' + d.id);
  if(!el) return;
  el.classList.add('err','open');
  el.querySelector('.spin').outerHTML = '<span class="bad">✕</span>';
  el.querySelector('.tool-body').textContent = d.error;
  scroll();
});

on('tool_progress', d => {
  const b = document.querySelector('#t_' + d.id + ' .tool-body');
  if(b){ b.textContent += d.chunk; }
});

on('notice', d => {
  endBubble();
  const el = document.createElement('div');
  el.className = 'notice ' + (d.level||'');
  el.textContent = d.text;
  feed.append(el); scroll();
});

on('usage', d => {
  const k = n => n >= 1000 ? (n/1000).toFixed(1)+'k' : n;
  $('#usage').textContent = '↑' + k(d.total.input) + ' ↓' + k(d.total.output);
});

on('done', d => { endBubble(); setBusy(false); if(d.interrupted) notice('Прервано.','warn'); });
on('error', d => { endBubble(); setBusy(false); notice(d.message + (d.hint ? ' — ' + d.hint : ''), 'error'); });

function notice(text, level){
  const el = document.createElement('div');
  el.className = 'notice ' + (level||''); el.textContent = text;
  feed.append(el); scroll(true);
}

/* ─── подтверждения ─── */
on('confirm', d => {
  endBubble();
  const el = document.createElement('div');
  el.className = 'confirm';
  const p = d.preview;
  let inner = '';

  if(p && p.kind === 'bash'){
    inner = '<pre>' + p.command.replace(/[&<>]/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[x])) + '</pre>';
  } else if(p && p.diff){
    inner = '<div class="meta">' + (p.existed ? 'изменить ' : 'создать ') + p.path +
      '  <span class="ok">+' + p.diff.adds + '</span> <span class="bad">-' + p.diff.dels + '</span></div>' +
      '<pre class="diff">' + p.diff.text.split('\\n').map(l=>{
        const c = l.startsWith('+')?'a':l.startsWith('-')?'d':'c';
        return '<span class="'+c+'">'+l.replace(/[&<>]/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[x]))+'</span>';
      }).join('') + '</pre>';
  }

  el.innerHTML =
    '<h4>' + (d.danger ? '<span class="danger">⚠ ' + d.danger + '</span>' : 'Разрешить: ' + d.tool) + '</h4>' +
    '<div class="why">' + (d.reason || d.label || '') + '</div>' + inner +
    '<div class="btns">' +
      '<button class="yes" data-a="yes">Разрешить</button>' +
      '<button data-a="always">Разрешать такие</button>' +
      '<button class="no" data-a="no">Отклонить</button>' +
    '</div>';

  el.querySelectorAll('button').forEach(b => b.onclick = () => {
    el.querySelectorAll('button').forEach(x => x.disabled = true);
    b.textContent = b.dataset.a === 'no' ? 'отклонено' : 'разрешено';
    api('/api/confirm', { id: d.id, answer: b.dataset.a });
  });

  feed.append(el); scroll(true);
});

/* ─── отправка ─── */
async function send(){
  const text = input.value.trim();
  if(!text) return;
  if(state.running){ api('/api/interrupt', {}); return; }

  input.value = ''; input.style.height = 'auto';
  addUser(text); endBubble(); setBusy(true, 'думаю…');
  const r = await api('/api/message', { text });
  if(r.error){ setBusy(false); notice(r.error, 'error'); }
}

$('#btnSend').onclick = send;
input.addEventListener('keydown', e => {
  if(e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); send(); }
});
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 190) + 'px';
});
document.addEventListener('keydown', e => {
  if(e.key === 'Escape' && state.running) api('/api/interrupt', {});
});

/* ─── настройки ─── */
function openPanel(){
  const sw = { aurora:['#7c5cff','#00d4ff','#3ddc97'], terminal:['#00ff41','#adff2f','#0c0f0c'],
               paper:['#d97757','#0969da','#ffffff'], midnight:['#82aaff','#c792ea','#11151c'],
               sunset:['#ff7e5f','#feb47b','#ef476f'] };

  $('#sheet').innerHTML =
    '<h3>Настройки</h3>' +
    '<section><h5>Дизайн</h5>' + BOOT.themes.map(t =>
      '<div class="opt ' + (t.id===state.theme?'sel':'') + '" data-k="theme" data-v="' + t.id + '">' +
      '<span class="swatch">' + (sw[t.id]||[]).map(c=>'<i style="background:'+c+'"></i>').join('') + '</span>' +
      '<span><span class="t">' + t.label + '</span><br><span class="h">' + t.description + '</span></span></div>'
    ).join('') + '</section>' +
    '<section><h5>Провайдер</h5>' + (state.providers.length ? state.providers : [{id:state.provider,label:state.provider,hasKey:true}]).map(p =>
      '<div class="opt ' + (p.id===state.provider?'sel':'') + '" data-k="provider" data-v="' + p.id + '">' +
      '<span><span class="t">' + p.label + '</span><br><span class="h">' + (p.hasKey ? p.id : (p.id + ' · нужен ключ')) + '</span></span></div>'
    ).join('') + '</section>' +
    '<section><h5>Модель</h5>' + (state.models.length ? state.models : [{id:state.model,label:state.model}]).map(m =>
      '<div class="opt ' + (m.id===state.model?'sel':'') + '" data-k="model" data-v="' + m.id + '">' +
      '<span><span class="t">' + (m.label||m.id) + '</span><br><span class="h">' + m.id + '</span></span></div>'
    ).join('') + '</section>' +
    '<section><h5>Права агента</h5>' + BOOT.modes.map(m =>
      '<div class="opt ' + (m.id===state.mode?'sel':'') + '" data-k="mode" data-v="' + m.id + '">' +
      '<span><span class="t">' + m.id + '</span><br><span class="h">' + m.hint + '</span></span></div>'
    ).join('') + '</section>' +
    '<section><h5>Папка</h5><div class="meta">' + BOOT.cwd + '</div></section>' +
    '<div class="btns"><button id="btnClear">Очистить историю</button>' +
    '<button class="yes" id="btnClose">Готово</button></div>';

  $('#sheet').querySelectorAll('.opt').forEach(o => o.onclick = async () => {
    const k = o.dataset.k, v = o.dataset.v;
    if(k === 'theme'){ document.documentElement.dataset.theme = v; state.theme = v; await api('/api/settings',{webTheme:v}); }
    if(k === 'model'){ state.model = v; $('#modelLabel').textContent = v; await api('/api/settings',{model:v}); }
    if(k === 'mode'){ state.mode = v; await api('/api/settings',{mode:v}); }
    if(k === 'provider' && v !== state.provider){
      const prov = state.providers.find(p => p.id === v);
      const body = { provider: v };
      if(prov && !prov.hasKey){
        const key = window.prompt('Ключ для ' + (prov.label||v) + ' (sk-...):');
        if(!key) return;
        body.key = key.trim();
      }
      const r = await api('/api/settings', body);
      if(r.provider){ state.provider = r.provider.id; state.providers = state.providers.map(p => p.id===r.provider.id ? Object.assign({}, p, {hasKey:r.provider.hasKey}) : p); }
      if(r.models){ state.models = r.models; }
      if(r.model){ state.model = r.model; $('#modelLabel').textContent = r.model; }
    }
    openPanel();
  });
  $('#btnClear').onclick = async () => { await api('/api/clear',{}); feed.innerHTML=''; closePanel(); };
  $('#btnClose').onclick = closePanel;
  $('#panel').classList.add('open');
}
const closePanel = () => $('#panel').classList.remove('open');
$('#btnSettings').onclick = openPanel;
$('#btnModel').onclick = openPanel;
$('#panel').onclick = e => { if(e.target.id === 'panel') closePanel(); };

/* ─── старт ─── */
$('#modelLabel').textContent = BOOT.model;
api('/api/state').then(s => {
  state.models = s.models || [];
  state.providers = s.providers || [];
  state.provider = s.provider && s.provider.id;
  state.model = s.model; state.mode = s.mode;
  $('#modelLabel').textContent = s.model;
  if(!feed.children.length && !(s.messages||[]).length){
    notice('Готов к работе. Опиши задачу — прочитаю код, внесу правки, запущу тесты.');
  }
  (s.messages||[]).forEach(m => {
    if(m.role === 'user'){ addUser(m.content); }
    else if(m.content){ bubble().innerHTML = md(m.content); endBubble(); }
  });
});
api('/api/models').then(r => { if(r.models) state.models = r.models; }).catch(()=>{});
input.focus();
</script>
</body>
</html>`;
}
