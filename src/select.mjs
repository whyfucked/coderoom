import { stdout } from 'node:process';
import { onKey } from './keys.mjs';
import { claim } from './screen.mjs';
import { cursor, width, visLen, truncate, glyphs, unicodeOK } from './ansi.mjs';
import { createTheme } from './themes.mjs';

const PAGE = 10;

export function select({
  title, subtitle, options, initial = 0,
  multi = false, filterable = false, detail = false, footer,
  theme: t = createTheme('claude'),
}) {
  const I = t.symbols;
  const ICON_ON = unicodeOK ? '◉' : '*';
  const ICON_OFF = unicodeOK ? '◯' : 'o';
  const HL = unicodeOK ? '─' : '-';
  const VB = unicodeOK ? '│' : '|';
  const SEP = unicodeOK ? '·' : '-';
  const UP = unicodeOK ? '↑' : '^';
  const DOWN = unicodeOK ? '↓' : 'v';

  return new Promise((resolve) => {
    if (!stdout.isTTY) return resolve(multi ? null : -1);

    let idx = Math.max(0, Math.min(initial, options.length - 1));
    let filter = '';
    let lines = 0;
    let notice = '';
    let noticeTimer = null;
    const chosen = new Set(options.map((o, i) => (o.selected ? i : -1)).filter((i) => i >= 0));

    const visible = () => {
      const q = filter.toLowerCase();
      return options
        .map((o, i) => ({ ...o, i }))
        .filter((o) => (q ? (o.label + ' ' + (o.hint || '')).toLowerCase().includes(q) : true));
    };

    const draw = (first = false) => {
      if (!first) {
        if (lines) cursor.up(lines);
        cursor.toCol0();
        cursor.clearDown();
      }
      const w = width();
      const rows = [''];
      rows.push('  ' + t.bold(t.primary(title)));
      if (subtitle) rows.push('  ' + t.muted(subtitle));
      if (filterable) {
        rows.push('  ' + t.muted('поиск: ') +
          (filter ? t.bold(filter) : t.muted('(печатай, чтобы отфильтровать)')));
      }
      rows.push('');

      const list = visible();
      if (idx >= list.length) idx = Math.max(0, list.length - 1);
      if (!list.length) rows.push('   ' + t.muted('ничего не найдено'));

      const start = Math.max(0, Math.min(idx - Math.floor(PAGE / 2), list.length - PAGE));
      const slice = list.slice(start, start + PAGE);
      const nameCol = Math.min(30, Math.max(10, ...slice.map((o) => visLen(o.label) + 1)));

      let lastGroup = null;
      for (let vi = 0; vi < slice.length; vi++) {
        const o = slice[vi];
        if (o.group && o.group !== lastGroup) {
          if (vi > 0) rows.push('');
          rows.push('   ' + t.muted(HL.repeat(2) + ' ' + o.group));
          lastGroup = o.group;
        }
        const sel = start + vi === idx;
        const mark = multi ? (chosen.has(o.i) ? t.success(ICON_ON + ' ') : t.muted(ICON_OFF + ' ')) : '';
        const label = o.disabled ? t.muted(o.label) : sel ? t.bold(o.label) : t.text(o.label);
        const cur = sel ? t.primary(' ' + I.prompt + ' ') : '   ';
        let row = cur + mark + label;
        if (o.hint) {
          const pad = ' '.repeat(Math.max(1, nameCol - visLen(o.label) + (multi ? 0 : 2)));
          const room = w - visLen(row) - pad.length - 4;
          if (room > 12) row += pad + t.muted(truncate(String(o.hint), room));
        }
        rows.push(row);
      }

      if (list.length > PAGE) {
        rows.push('   ' + t.muted(`${idx + 1}/${list.length}  ${SEP}  ещё ${list.length - slice.length}`));
      }

      if (detail) {
        const text = list[idx]?.detail;
        rows.push('');
        if (text) {
          for (const l of String(text).split('\n').slice(0, 5)) {
            rows.push('   ' + t.muted(VB + ' ') + t.muted(truncate(l, w - 8)));
          }
        } else {
          rows.push('   ' + t.muted(VB + ' ') + t.muted('нет описания'));
        }
      }

      rows.push('');
      if (notice) rows.push('  ' + truncate(notice, w - 4));
      const s = ` ${SEP} `;
      rows.push('  ' + t.muted(footer || (multi
        ? [`${UP}${DOWN}`, 'Space отметить', 'Ctrl+A все', 'Enter применить', 'Esc отмена'].join(s)
        : [`${UP}${DOWN} выбрать`, 'Enter', 'Esc отмена'].join(s))));
      rows.push('');

      stdout.write(glyphs(rows.map((r) => truncate(r, w - 1)).join('\n')));
      lines = rows.length - 1;
    };

    cursor.hide();
    draw(true);

    const unclaim = claim({
      notify: (text, ttl = 2500) => {
        clearTimeout(noticeTimer);
        notice = text || '';
        draw();
        if (notice && ttl > 0) {
          noticeTimer = setTimeout(() => { notice = ''; draw(); }, ttl);
        }
      },
    });

    const off = onKey((str, key) => {
      const list = visible();
      const n = key.name;
      const done = (val) => {
        off();
        clearTimeout(noticeTimer);
        unclaim();
        cursor.show();
        stdout.write('\n');
        resolve(val);
      };

      if (n === 'up') idx = (idx - 1 + list.length) % Math.max(1, list.length);
      else if (n === 'down') idx = (idx + 1) % Math.max(1, list.length);
      else if (n === 'pageup' || (key.ctrl && n === 'b')) idx = Math.max(0, idx - PAGE);
      else if (n === 'pagedown' || (key.ctrl && n === 'f')) idx = Math.min(list.length - 1, idx + PAGE);
      else if (n === 'home') idx = 0;
      else if (n === 'end') idx = Math.max(0, list.length - 1);
      else if (n === 'return') {
        if (multi) return done([...chosen]);
        const pick = list[idx];
        if (pick?.disabled) return;
        return done(pick ? pick.i : -1);
      } else if (n === 'escape' || (key.ctrl && n === 'c')) return done(multi ? null : -1);
      else if (multi && n === 'space') {
        const o = list[idx];
        if (o && !o.disabled) chosen.has(o.i) ? chosen.delete(o.i) : chosen.add(o.i);
      } else if (multi && key.ctrl && n === 'a') {
        const all = list.length && list.every((o) => chosen.has(o.i));
        for (const o of list) if (!o.disabled) all ? chosen.delete(o.i) : chosen.add(o.i);
      } else if (filterable && n === 'backspace') { filter = filter.slice(0, -1); idx = 0; }
      else if (filterable && str && str >= ' ' && !key.ctrl && !key.meta) { filter += str; idx = 0; }
      else return;
      draw();
    });
  });
}

export async function confirmSelect({ title, subtitle, yes = 'Да', no = 'Нет', theme } = {}) {
  const i = await select({
    title, subtitle, theme,
    options: [{ label: yes }, { label: no }],
    footer: 'Enter выбрать · Esc отмена',
  });
  return i === 0;
}
