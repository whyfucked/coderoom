import { stdout } from 'node:process';
import { execFileSync } from 'node:child_process';

function detectUnicode() {
  const on = (v) => v && v !== '0' && v !== 'false';
  if (on(process.env.CODEROOM_ASCII)) return false;
  if (on(process.env.CODEROOM_UNICODE)) return true;
  if (process.platform !== 'win32') return true;
  if (
    process.env.WT_SESSION ||
    process.env.TERM_PROGRAM ||
    process.env.ConEmuANSI ||
    process.env.WSL_DISTRO_NAME ||
    process.env.MSYSTEM ||
    (process.env.TERM && process.env.TERM !== 'dumb')
  ) return true;
  if (!stdout.isTTY) return true;
  try {
    const out = execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'chcp'], {
      encoding: 'latin1', timeout: 3000, windowsHide: true,
    });
    const m = out.match(/(\d{3,5})/);
    return m ? Number(m[1]) === 65001 : false;
  } catch {
    return false;
  }
}

export const unicodeOK = detectUnicode();

const FALLBACK = {
  '·': '-', '—': '-', '–': '-', '…': '...',
  '→': '->', '←': '<-', '↑': '^', '↓': 'v', '⟶': '->',
  '─': '-', '│': '|', '┌': '+', '┐': '+', '└': '+', '┘': '+',
  '├': '+', '┤': '+', '┬': '+', '┴': '+', '┼': '+',
  '╭': '+', '╮': '+', '╯': '+', '╰': '+',
  '═': '=', '║': '|', '╔': '+', '╗': '+', '╚': '+', '╝': '+', '╬': '+',
  '█': '#', '▉': '#', '▊': '#', '▋': '#', '▌': '#', '▍': '#', '▎': '#', '▏': '#',
  '░': '.', '▒': ':', '▓': '#', '▗': '#', '▄': '#',
  '✓': '+', '✔': '+', '✗': 'x', '✘': 'x', '×': 'x', '✕': 'x',
  '⚙': '*', '◉': '*', '◯': 'o', '●': '*', '○': 'o', '◐': '*', '◆': '*', '◇': '*',
  '❯': '>', '›': '>', '‹': '<', '»': '>', '«': '<', '▶': '>', '▸': '>',
  '•': '-', '◦': 'o', '‣': '-', '▪': '-', '∙': '-',
  '⏺': '*', '⎿': '`-', '⏹': '[]', '⊘': '(x)',
  '✻': '*', '✳': '*', '✽': '*', '✶': '*', '✦': '*', '✧': '*', '✿': '*', '❀': '*', '❁': '*', '✾': '*', '❖': '*', '✷': '*', '∴': '.',
  '⚠': '!', '△': '!', '⚡': '!',
  '⠋': '-', '⠙': '\\', '⠹': '|', '⠸': '/', '⠼': '-',
  '⠴': '\\', '⠦': '|', '⠧': '/', '⠇': '-', '⠏': '\\',
  '“': '"', '”': '"', '„': '"', '‘': "'", '’': "'",
  '≈': '~', '≤': '<=', '≥': '>=', '±': '+/-', '⋮': ':',
};
const FALLBACK_RE = new RegExp('[' + Object.keys(FALLBACK).join('') + ']', 'g');

export const glyphs = (s) =>
  unicodeOK ? String(s) : String(s).replace(FALLBACK_RE, (c) => FALLBACK[c]);

export const write = (s, stream = stdout) => stream.write(glyphs(s));

export const stripAnsi = (s) =>
  String(s)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b[()][0-9A-B]/g, '');

const ZERO_WIDTH = /[̀-ͯ҃-҉֑-ֽ​-‏⁠-⁤︀-️­⃐-⃰]/;
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︐-︙︰-﹯＀-｠￠-￦]/;
const WIDE_ASTRAL = /[\u{1F300}-\u{1F9FF}\u{1FA00}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u;

function charWidth(ch) {
  const cp = ch.codePointAt(0);
  if (cp === 0) return 0;
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (ZERO_WIDTH.test(ch)) return 0;
  if (WIDE.test(ch) || WIDE_ASTRAL.test(ch)) return 2;
  return 1;
}

export function visLen(s) {
  let n = 0;
  for (const ch of stripAnsi(s)) n += charWidth(ch);
  return n;
}

export function truncate(s, max) {
  const plain = stripAnsi(s);
  if (visLen(plain) <= max) return s;
  const ell = unicodeOK ? '…' : '...';
  const room = Math.max(0, max - visLen(ell));
  let out = '';
  let n = 0;
  for (const ch of plain) {
    const w = charWidth(ch);
    if (n + w > room) break;
    out += ch;
    n += w;
  }
  return out + ell;
}

export const padEnd = (s, w) => s + ' '.repeat(Math.max(0, w - visLen(s)));

export const cursor = {
  hide: () => stdout.write('\x1b[?25l'),
  show: () => stdout.write('\x1b[?25h'),
  up: (n = 1) => stdout.write(`\x1b[${n}A`),
  down: (n = 1) => stdout.write(`\x1b[${n}B`),
  right: (n = 1) => stdout.write(`\x1b[${n}C`),
  toCol0: () => stdout.write('\r'),
  clearDown: () => stdout.write('\x1b[0J'),
  clearLine: () => stdout.write('\r\x1b[2K'),
};

export const width = () => Math.max(40, stdout.columns || 80);

export function screenRows(text, w) {
  let n = 0;
  for (const line of String(text).split('\n')) n += Math.max(1, Math.ceil(visLen(line) / w));
  return n;
}

export function progressBar(value, max, size = 10, paint = (s) => s, paintDim = (s) => s) {
  const p = Math.min(Math.max(value / (max || 1), 0), 1);
  const filled = Math.round(p * size);
  const full = unicodeOK ? '█' : '#';
  const empty = unicodeOK ? '░' : '.';
  return `${paint(full.repeat(filled) + '')}${paintDim(empty.repeat(size - filled))} ${paintDim((p * 100).toFixed(0) + '%')}`;
}
