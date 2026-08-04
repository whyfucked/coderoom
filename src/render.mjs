import { stdout } from 'node:process';
import { DIM, RESET, BOLD } from './themes.mjs';
import {
  visLen, stripAnsi as _stripAnsi, truncate, cursor, width as termW,
  glyphs, write as ansiWrite, unicodeOK, padEnd, progressBar,
} from './ansi.mjs';

export const termWidth = () => Math.min(termW(), 120);
export const stripAnsi = _stripAnsi;
export const visibleLength = visLen;
export { visLen, truncate, glyphs, progressBar, unicodeOK };

const G = (u, a) => (unicodeOK ? u : a);
const BOX = {
  h: G('─', '-'), v: G('│', '|'),
  tl: G('┌', '+'), tr: G('┐', '+'), bl: G('└', '+'), br: G('┘', '+'),
  lt: G('├', '+'), rt: G('┤', '+'), tt: G('┬', '+'), bt: G('┴', '+'), x: G('┼', '+'),
};
const ELL = G('…', '...');
const BULLETS = [G('•', '-'), G('◦', 'o'), G('‣', '+'), G('·', '.')];
const CHECK_ON = G('◉', '*');
const CHECK_OFF = G('◯', 'o');

export function setTerminalTitle(title) {
  if (process.env.NO_TITLE) return;
  if (!stdout?.isTTY) return;
  try {
    stdout.write(`\x1b]0;${String(title).replace(/[\x00-\x1f\x07]/g, '')}\x07`);
  } catch { /* не критично */ }
}

export function wrap(text, max = termWidth(), indent = '', hang = 0) {
  const padHang = indent + ' '.repeat(hang);
  const limit = Math.max(20, max - visLen(indent) - hang);
  const out = [];
  for (const para of String(text).split('\n')) {
    if (!para.trim()) { out.push(''); continue; }
    let cur = '';
    let first = true;
    const flush = () => { out.push((first ? indent : padHang) + cur); first = false; };
    for (const word of para.split(/ +/)) {
      if (!cur) { cur = word; continue; }
      const room = first ? limit + hang : limit;
      if (visLen(cur) + 1 + visLen(word) > room) { flush(); cur = word; }
      else cur += ' ' + word;
    }
    if (cur) flush();
  }
  return out.join('\n');
}


const KEYWORDS = new Set([
  'const','let','var','function','return','if','else','for','while','class','extends','new','import',
  'export','from','default','async','await','try','catch','finally','throw','typeof','instanceof',
  'def','elif','lambda','pass','None','True','False','self','print','with','as','in','not','and','or',
  'public','private','protected','static','void','int','string','bool','struct','type','interface',
  'func','fn','mut','pub','impl','use','match','enum','nil','end','do','then','echo',
]);

function highlightCode(line, t) {
  if (/^\s*(\/\/|#|--)/.test(line)) return t.muted(line);
  return line
    .replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, (m) => t.success(m))
    .replace(/\b(\d+(?:\.\d+)?)\b/g, (m) => t.accent(m))
    .replace(/\b([A-Za-z_$][\w$]*)\b/g, (m) => (KEYWORDS.has(m) ? t.primary(m) : m));
}


function inline(s, t) {
  let l = String(s);
  const code = [];
  l = l.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, _f, c) => {
    code.push(c.trim());
    return '\x00C' + (code.length - 1) + '\x00';
  });

  l = l.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, a) => a || '[изображение]');
  l = l.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_, txt, url) => t.accent(txt) + t.muted(' (' + url + ')'));
  l = l.replace(/~~([^~]+)~~/g, (_, c) => `\x1b[9m${c}\x1b[29m`);
  l = l.replace(/\*\*\*([^*]+?)\*\*\*/g, (_, c) => `${BOLD}${t.italic(c)}${RESET}`);
  l = l.replace(/\*\*([\s\S]+?)\*\*/g, (_, c) => `${BOLD}${c}${RESET}`);
  l = l.replace(/__([^_]+?)__/g, (_, c) => `${BOLD}${c}${RESET}`);
  l = l.replace(/(^|[\s(«"'])\*(?!\s)([^*\n]+?)\*(?=$|[\s.,;:!?)»"'])/g, (_, p, c) => p + t.italic(c));
  l = l.replace(/(^|[\s(«"'])_(?!\s)([^_\n]+?)_(?=$|[\s.,;:!?)»"'])/g, (_, p, c) => p + t.italic(c));
  l = l.replace(/(?<![(\w])(https?:\/\/[^\s)]+)/g, (m) => t.accent(m));

  return l.replace(/\x00C(\d+)\x00/g, (_, i) => t.code(code[i]));
}

const cleanStray = (s) => s.replace(/\*\*(?=\s|$)/g, '').replace(/(?:^|\s)\*\*/g, (m) => m.replace('**', ''));

const isTableSep = (l) => /^\s*\|?[\s:|-]*-[-\s:|]*\|?\s*$/.test(l) && l.includes('-');

function renderTable(rows, t, maxW, indent) {
  const cells = rows.map((r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim(), t)));
  const cols = Math.max(...cells.map((r) => r.length));
  const w = [];
  for (let c = 0; c < cols; c++) w[c] = Math.max(...cells.map((r) => visLen(r[c] ?? '')));

  const total = w.reduce((a, b) => a + b + 3, 1);
  if (total > maxW) {
    const widest = w.indexOf(Math.max(...w));
    w[widest] = Math.max(8, w[widest] - (total - maxW));
  }

  const line = (l, m, r) => t.muted(l + w.map((n) => BOX.h.repeat(n + 2)).join(m) + r);
  const fmt = (r, head) =>
    t.muted(BOX.v) +
    w.map((_, i) => {
      const cut = truncate(r[i] ?? '', w[i]);
      const padded = padEnd(cut, w[i]);
      return ' ' + (head ? `${BOLD}${padded}${RESET}` : padded) + ' ';
    }).join(t.muted(BOX.v)) +
    t.muted(BOX.v);

  const res = [];
  res.push(indent + line(BOX.tl, BOX.tt, BOX.tr));
  res.push(indent + fmt(cells[0], true));
  res.push(indent + line(BOX.lt, BOX.x, BOX.rt));
  for (const r of cells.slice(1)) res.push(indent + fmt(r, false));
  res.push(indent + line(BOX.bl, BOX.bt, BOX.br));
  return res;
}

export function renderMarkdown(md, t, { width = termWidth(), indent = '  ' } = {}) {
  const base = visLen(indent);
  const maxW = width;
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
  const res = [];
  let inCode = false;
  let fenceChar = '';

  const para = [];
  const flushPara = () => {
    if (!para.length) return;
    const joined = para.join(' ').replace(/\s+/g, ' ').trim();
    para.length = 0;
    if (joined) res.push(wrap(cleanStray(inline(joined, t)), maxW, indent));
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];

    const fence = raw.match(/^\s*(```+|~~~+)(\w*)/);
    if (fence && (!inCode || raw.trim().startsWith(fenceChar))) {
      if (!inCode) {
        flushPara();
        inCode = true;
        fenceChar = fence[1][0].repeat(3);
        res.push(t.muted(indent + BOX.tl + BOX.h + ' ' + (fence[2] || 'код')));
      } else {
        inCode = false;
        res.push(t.muted(indent + BOX.bl + BOX.h));
      }
      continue;
    }
    if (inCode) {
      res.push(t.muted(indent + BOX.v + ' ') + highlightCode(truncate(raw.replace(/\t/g, '  '), maxW - base - 4), t));
      continue;
    }

    if (!raw.trim()) {
      flushPara();
      if (res.length && res[res.length - 1] !== '') res.push('');
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) {
      flushPara();
      res.push(t.muted(indent + BOX.h.repeat(Math.max(10, maxW - base * 2))));
      continue;
    }

    if (/^\s*\|.*\|\s*$/.test(raw) && lines[i + 1] && isTableSep(lines[i + 1])) {
      flushPara();
      const rows = [raw];
      i++;
      while (i + 1 < lines.length && /\|/.test(lines[i + 1]) && lines[i + 1].trim()) rows.push(lines[++i]);
      res.push(...renderTable(rows, t, maxW - base - 2, indent));
      continue;
    }

    const h = raw.match(/^(#{1,6})\s+(.*?)\s*#*$/);
    if (h) {
      flushPara();
      const level = h[1].length;
      const text = cleanStray(inline(h[2], t));
      if (res.length && res[res.length - 1] !== '') res.push('');
      const color = level <= 2 ? t.primary : t.accent;
      const wrapped = wrap(text, maxW - base, '').split('\n');
      for (const w of wrapped) res.push(indent + `${BOLD}${color(w)}${RESET}`);
      if (level <= 2) {
        const rule = Math.min(Math.max(...wrapped.map((w) => visLen(w))), maxW - base * 2);
        res.push(indent + t.muted(BOX.h.repeat(Math.max(1, rule))));
      }
      continue;
    }

    const q = raw.match(/^\s*>\s?(.*)$/);
    if (q) {
      flushPara();
      res.push(t.muted(indent + BOX.v + ' ') + t.italic(truncate(inline(q[1], t), maxW - base - 4)));
      continue;
    }

    const li = raw.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      flushPara();
      const depth = Math.min(3, Math.floor(li[1].length / 2));
      const pad = indent + ' '.repeat(depth * 2);
      const ordered = /\d/.test(li[2]);
      const marker = ordered
        ? t.primary(li[2].replace(')', '.') + ' ')
        : t.primary(BULLETS[depth] + ' ');

      let body = li[3];
      let box = '';
      const cb = body.match(/^\[([ xX])\]\s+(.*)$/);
      if (cb) {
        box = cb[1] === ' ' ? t.muted(CHECK_OFF + ' ') : t.success(CHECK_ON + ' ');
        body = cb[2];
      }

      let cont = body;
      while (
        i + 1 < lines.length && lines[i + 1].trim() &&
        !/^(\s*)([-*+]|\d+[.)])\s+/.test(lines[i + 1]) &&
        !/^\s*(#{1,6}\s|```|~~~|>|\|)/.test(lines[i + 1]) &&
        lines[i + 1].search(/\S/) > li[1].length
      ) cont += ' ' + lines[++i].trim();

      const lead = pad + marker + box;
      const leadW = visLen(lead);
      const wrapped = wrap(cleanStray(inline(cont.replace(/\s+/g, ' '), t)), maxW - leadW, '').split('\n');
      res.push(lead + wrapped[0]);
      for (const r of wrapped.slice(1)) res.push(' '.repeat(leadW) + r);
      continue;
    }

    para.push(raw.trim());
  }
  flushPara();

  while (res.length && res[res.length - 1] === '') res.pop();
  while (res.length && res[0] === '') res.shift();
  return res.join('\n').replace(/\n{3,}/g, '\n\n');
}


export function diffLines(before, after) {
  const a = String(before ?? '').split('\n');
  const b = String(after ?? '').split('\n');

  if (a.length * b.length > 4_000_000) {
    return [
      { type: 'del', text: `[${a.length} строк]`, lineNo: 0 },
      { type: 'add', text: `[${b.length} строк]`, lineNo: 0 },
    ];
  }

  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { out.push({ type: 'ctx', text: a[i], lineNo: j + 1 }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: 'del', text: a[i], lineNo: i + 1 }); i++; }
    else { out.push({ type: 'add', text: b[j], lineNo: j + 1 }); j++; }
  }
  while (i < m) out.push({ type: 'del', text: a[i], lineNo: ++i });
  while (j < n) out.push({ type: 'add', text: b[j], lineNo: ++j });
  return out;
}

export function renderDiff(before, after, t, { context = 3, maxLines = 60, indent = '  ', width = termWidth() } = {}) {
  const diff = diffLines(before, after);
  const keep = new Set();
  diff.forEach((d, idx) => {
    if (d.type === 'ctx') return;
    for (let k = Math.max(0, idx - context); k <= Math.min(diff.length - 1, idx + context); k++) keep.add(k);
  });

  const room = width - visLen(indent) - 8;
  const lines = [];
  let skipped = 0;
  let shown = 0;

  diff.forEach((d, idx) => {
    if (!keep.has(idx)) { skipped++; return; }
    if (skipped) { lines.push(indent + t.muted(`  ${G('⋮', ':')} пропущено строк: ${skipped}`)); skipped = 0; }
    if (shown >= maxLines) return;
    shown++;
    const no = String(d.lineNo).padStart(4);
    const text = truncate(d.text, room);
    if (d.type === 'add') lines.push(indent + t.success(`+${no} ${text}`));
    else if (d.type === 'del') lines.push(indent + t.error(`-${no} ${text}`));
    else lines.push(indent + t.muted(` ${no} ${text}`));
  });

  if (shown >= maxLines) lines.push(indent + t.muted(`  ${ELL} дифф обрезан`));

  return {
    text: lines.join('\n'),
    adds: diff.filter((d) => d.type === 'add').length,
    dels: diff.filter((d) => d.type === 'del').length,
  };
}


export function box(content, t, { title = '', width = termWidth() - 4, padding = 1 } = {}) {
  const b = t.box ?? BOX;
  const inner = width - 2;
  const pad = ' '.repeat(padding);

  const top = title
    ? `${b.tl}${b.h} ${title} ${b.h.repeat(Math.max(0, inner - visLen(title) - 3))}${b.tr}`
    : `${b.tl}${b.h.repeat(inner)}${b.tr}`;

  const lines = String(content).split('\n').map((l) => {
    const cut = visLen(l) > inner - padding * 2 ? truncate(l, inner - padding * 2) : l;
    return `${b.v}${pad}${padEnd(cut, inner - padding * 2)}${pad}${b.v}`;
  });

  return [t.muted(top), ...lines, t.muted(`${b.bl}${b.h.repeat(inner)}${b.br}`)].join('\n');
}


const VERBS = [
  'думаю', 'разбираюсь', 'копаю', 'соображаю', 'прикидываю',
  'изучаю', 'собираю мысли', 'ковыряюсь', 'верчу', 'раскручиваю',
];

export class Spinner {
  constructor(t, stream = stdout) {
    this.t = t;
    this.stream = stream;
    this.frames = (t.spinner ?? ['|', '/', '-', '\\']).map((f) => glyphs(f));
    this.i = 0;
    this.timer = null;
    this.text = '';
    this.startedAt = 0;
    this.verb = VERBS[Math.floor(Math.random() * VERBS.length)];
    this.active = false;
  }

  start(text = '') {
    if (this.active || !this.stream.isTTY) { this.text = text; return; }
    this.active = true;
    this.text = text;
    this.startedAt = Date.now();
    this.verb = VERBS[Math.floor(Math.random() * VERBS.length)];
    cursor.hide();

    this.timer = setInterval(() => {
      const frame = this.frames[this.i++ % this.frames.length];
      const secs = Math.floor((Date.now() - this.startedAt) / 1000);
      const time = secs > 0 ? this.t.muted(` ${secs}с`) : '';
      const label = this.text || `${this.verb}${ELL}`;
      cursor.clearLine();
      ansiWrite(`  ${this.t.primary(frame)} ${this.t.muted(label)}${time}${this.t.muted(`  (esc ${G('—', '-')} прервать)`)}`, this.stream);
    }, 90);
  }

  update(text) { this.text = text; }

  stop() {
    if (!this.active) return;
    this.active = false;
    clearInterval(this.timer);
    this.timer = null;
    cursor.clearLine();
    cursor.show();
  }
}


export class StreamRenderer {
  constructor(t, stream = stdout, { indent = '  ' } = {}) {
    this.t = t;
    this.stream = stream;
    this.indent = indent;
    this.buffer = '';
    this.started = false;
    this.printed = false;
  }

  #fenceOpen(s) {
    return ((s.match(/^\s*(?:```+|~~~+)/gm) || []).length % 2) === 1;
  }

  #emit(block) {
    if (!block.trim()) return;
    if (!this.started) { this.started = true; this.stream.write('\n'); }
    if (this.printed) this.stream.write('\n');
    ansiWrite(renderMarkdown(block, this.t, { indent: this.indent }) + '\n', this.stream);
    this.printed = true;
  }

  write(delta) {
    this.buffer += delta;
    if (!/\n[ \t]*\n/.test(this.buffer)) return;
    for (;;) {
      const m = this.buffer.match(/\n[ \t]*\n/);
      if (!m) break;
      const block = this.buffer.slice(0, m.index);
      if (this.#fenceOpen(block)) break;
      this.buffer = this.buffer.slice(m.index + m[0].length);
      this.#emit(block);
    }
  }

  flush() {
    if (this.buffer.trim()) this.#emit(this.buffer);
    this.buffer = '';
    if (this.started) this.stream.write('\n');
    const was = this.started;
    this.started = false;
    this.printed = false;
    return was;
  }
}

export function fmtNum(n) {
  if (n == null) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
}
