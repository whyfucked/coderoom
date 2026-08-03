const SUPPORTS_TRUECOLOR =
  process.env.COLORTERM === 'truecolor' ||
  process.env.COLORTERM === '24bit' ||
  process.env.TERM_PROGRAM === 'vscode' ||
  process.env.WT_SESSION !== undefined ||
  process.platform === 'win32';

export const NO_COLOR = Boolean(process.env.NO_COLOR) || process.env.TERM === 'dumb';


function fg(hex, fallback = 37) {
  if (NO_COLOR) return '';
  if (!SUPPORTS_TRUECOLOR) return `\x1b[${fallback}m`;
  const [r, g, b] = hexToRgb(hex);
  return `\x1b[38;2;${r};${g};${b}m`;
}
function bg(hex, fallback = 40) {
  if (NO_COLOR) return '';
  if (!SUPPORTS_TRUECOLOR) return `\x1b[${fallback}m`;
  const [r, g, b] = hexToRgb(hex);
  return `\x1b[48;2;${r};${g};${b}m`;
}
function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export const RESET = NO_COLOR ? '' : '\x1b[0m';
export const BOLD = NO_COLOR ? '' : '\x1b[1m';
export const DIM = NO_COLOR ? '' : '\x1b[2m';
export const ITALIC = NO_COLOR ? '' : '\x1b[3m';
export const UNDERLINE = NO_COLOR ? '' : '\x1b[4m';


export const THEMES = {

  claude: {
    name: 'claude',
    label: 'Claude',
    description: 'Тёплая палитра, скруглённые рамки — как в оригинальном Claude Code',
    palette: {
      primary: '#d97757',
      accent2: '#c15f3c',
      text: '#e8e6e3',
      muted: '#8b8681',
      success: '#7fb069',
      warn: '#e0a458',
      error: '#d95757',
      code: '#a8c7d8',
      userLabel: '#d97757',
    },
    box: { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│', cross: '┼' },
    symbols: {
      prompt: '❯',
      user: '›',
      assistant: '⏺',
      tool: '⏺',
      toolDone: '⎿',
      bullet: '•',
      arrow: '→',
      check: '✓',
      cross: '✗',
      warn: '⚠',
      thinking: '✻',
    },
    spinner: ['✻', '✳', '✽', '✶', '✻', '✳'],
    banner: (v) => [
      '',
      `  ${'▗▄▄▖'} CodeRoom ${DIM}v${v}${RESET}`,
      `  ${DIM}локальный агент для кода${RESET}`,
      '',
    ],
  },


  neon: {
    name: 'neon',
    label: 'Neon',
    description: 'Киберпанк: розово-циановый неон, двойные рамки',
    palette: {
      primary: '#ff2e88',
      accent2: '#00e5ff',
      text: '#f0f0ff',
      muted: '#6b6b8f',
      success: '#00ff9f',
      warn: '#ffcc00',
      error: '#ff3355',
      code: '#00e5ff',
      userLabel: '#00e5ff',
    },
    box: { tl: '╔', tr: '╗', bl: '╚', br: '╝', h: '═', v: '║', cross: '╬' },
    symbols: {
      prompt: '▶',
      user: '◆',
      assistant: '◇',
      tool: '▪',
      toolDone: '└',
      bullet: '▸',
      arrow: '⟶',
      check: '✔',
      cross: '✘',
      warn: '⚡',
      thinking: '◈',
    },
    spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
    banner: (v) => [
      '',
      `  ╔═══════════════════════════════╗`,
      `  ║  C O D E R O O M   ${DIM}v${v}${RESET}       ║`,
      `  ╚═══════════════════════════════╝`,
      '',
    ],
  },


  minimal: {
    name: 'minimal',
    label: 'Minimal',
    description: 'Строго и тихо: минимум украшений, серо-синяя гамма',
    palette: {
      primary: '#5f87af',
      accent2: '#87afd7',
      text: '#d0d0d0',
      muted: '#6c6c6c',
      success: '#87af87',
      warn: '#d7af5f',
      error: '#af5f5f',
      code: '#afafaf',
      userLabel: '#5f87af',
    },
    box: { tl: ' ', tr: ' ', bl: ' ', br: ' ', h: ' ', v: ' ', cross: ' ' },
    symbols: {
      prompt: '>',
      user: '',
      assistant: '',
      tool: '-',
      toolDone: ' ',
      bullet: '*',
      arrow: '->',
      check: 'ok',
      cross: 'x',
      warn: '!',
      thinking: '...',
    },
    spinner: ['.  ', '.. ', '...', ' ..', '  .', '   '],
    banner: (v) => ['', `  coderoom ${v}`, ''],
  },


  matrix: {
    name: 'matrix',
    label: 'Matrix',
    description: 'Зелёный фосфор, ASCII-рамки, ретро-хакер',
    palette: {
      primary: '#00ff41',
      accent2: '#00b32d',
      text: '#c8ffc8',
      muted: '#3f7f3f',
      success: '#00ff41',
      warn: '#adff2f',
      error: '#ff4141',
      code: '#7fff7f',
      userLabel: '#00ff41',
    },
    box: { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|', cross: '+' },
    symbols: {
      prompt: '$',
      user: '>',
      assistant: '#',
      tool: '*',
      toolDone: '`-',
      bullet: '-',
      arrow: '=>',
      check: '[ok]',
      cross: '[!!]',
      warn: '[!]',
      thinking: '#',
    },
    spinner: ['|', '/', '-', '\\'],
    banner: (v) => [
      '',
      `  +--------------------------------+`,
      `  |  C0D3R00M  ${DIM}v${v}${RESET}   [ONLINE]  |`,
      `  +--------------------------------+`,
      '',
    ],
  },


  pastel: {
    name: 'pastel',
    label: 'Pastel',
    description: 'Мягкие пастельные тона, подходит для светлого терминала',
    palette: {
      primary: '#9d7cd8',
      accent2: '#7aa2f7',
      text: '#4c4f69',
      muted: '#9ca0b0',
      success: '#40a02b',
      warn: '#df8e1d',
      error: '#d20f39',
      code: '#8839ef',
      userLabel: '#9d7cd8',
    },
    box: { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│', cross: '┼' },
    symbols: {
      prompt: '❯',
      user: '❖',
      assistant: '✦',
      tool: '◦',
      toolDone: '╰',
      bullet: '·',
      arrow: '→',
      check: '✓',
      cross: '✕',
      warn: '△',
      thinking: '✿',
    },
    spinner: ['✿', '❀', '✾', '❁', '✿', '❀'],
    banner: (v) => [
      '',
      `  ✦ CodeRoom ${DIM}v${v}${RESET}`,
      `  ${DIM}твой помощник по коду${RESET}`,
      '',
    ],
  },


  codex: {
    name: 'codex',
    label: 'Codex',
    description: 'Как OpenAI Codex CLI: строгий тёмный, зелёно-бирюзовый акцент',
    palette: {
      primary: '#10a37f',
      accent2: '#2dd4bf',
      text: '#ececf1',
      muted: '#8e8ea0',
      success: '#19c37d',
      warn: '#e0a458',
      error: '#ef4146',
      code: '#2dd4bf',
      userLabel: '#10a37f',
    },
    box: { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│', cross: '┼' },
    symbols: {
      prompt: '›',
      user: '∙',
      assistant: '●',
      tool: '▪',
      toolDone: '└',
      bullet: '·',
      arrow: '→',
      check: '✓',
      cross: '✗',
      warn: '!',
      thinking: '∴',
    },
    spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
    banner: (v) => [
      '',
      `  ${'◇'} CodeRoom ${DIM}v${v}${RESET}  ${DIM}· codex${RESET}`,
      `  ${DIM}openai-style терминал${RESET}`,
      '',
    ],
  },


  lime: {
    name: 'lime',
    label: 'Lime',
    description: 'Графитовый фон, кислотный лайм — контрастно и current',
    palette: {
      primary: '#c8f04d',
      accent2: '#a3e635',
      text: '#f4f1ea',
      muted: '#989aa4',
      success: '#a3e635',
      warn: '#f5bb65',
      error: '#ff6b6b',
      code: '#d7e6aa',
      userLabel: '#c8f04d',
    },
    box: { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│', cross: '┼' },
    symbols: {
      prompt: '▍',
      user: '▪',
      assistant: '◆',
      tool: '▸',
      toolDone: '└',
      bullet: '•',
      arrow: '→',
      check: '✓',
      cross: '✗',
      warn: '!',
      thinking: '▍',
    },
    spinner: ['▖', '▘', '▝', '▗'],
    banner: (v) => [
      '',
      `  ▍ CodeRoom ${DIM}v${v}${RESET}`,
      `  ${DIM}агент для кода${RESET}`,
      '',
    ],
  },


  dracula: {
    name: 'dracula',
    label: 'Dracula',
    description: 'Классическая Dracula: фиолет и розовый на тёмном',
    palette: {
      primary: '#bd93f9',
      accent2: '#8be9fd',
      text: '#f8f8f2',
      muted: '#6272a4',
      success: '#50fa7b',
      warn: '#f1fa8c',
      error: '#ff5555',
      code: '#ff79c6',
      userLabel: '#bd93f9',
    },
    box: { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│', cross: '┼' },
    symbols: {
      prompt: '❯',
      user: '▸',
      assistant: '✦',
      tool: '◆',
      toolDone: '╰',
      bullet: '•',
      arrow: '→',
      check: '✓',
      cross: '✗',
      warn: '⚠',
      thinking: '✷',
    },
    spinner: ['✦', '✧', '✶', '✷', '✦', '✧'],
    banner: (v) => [
      '',
      `  ✦ CodeRoom ${DIM}v${v}${RESET}  ${DIM}· dracula${RESET}`,
      '',
    ],
  },


  github: {
    name: 'github',
    label: 'GitHub Dark',
    description: 'Спокойная тёмная гамма GitHub',
    palette: {
      primary: '#58a6ff',
      accent2: '#79c0ff',
      text: '#c9d1d9',
      muted: '#8b949e',
      success: '#3fb950',
      warn: '#d29922',
      error: '#f85149',
      code: '#a5d6ff',
      userLabel: '#58a6ff',
    },
    box: { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│', cross: '┼' },
    symbols: {
      prompt: '❯',
      user: '▸',
      assistant: '●',
      tool: '▪',
      toolDone: '└',
      bullet: '·',
      arrow: '→',
      check: '✓',
      cross: '✗',
      warn: '!',
      thinking: '∴',
    },
    spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
    banner: (v) => [
      '',
      `  ◆ CodeRoom ${DIM}v${v}${RESET}  ${DIM}· github${RESET}`,
      '',
    ],
  },
};

export const THEME_NAMES = Object.keys(THEMES);


export function createTheme(name = 'claude') {
  const theme = THEMES[name] ?? THEMES.claude;
  const p = theme.palette;

  const paint = (hex, fallback) => (s) => `${fg(hex, fallback)}${s}${RESET}`;

  return {
    ...theme,
    primary: paint(p.primary, 33),
    accent: paint(p.accent2, 36),
    text: paint(p.text, 37),
    muted: paint(p.muted, 90),
    success: paint(p.success, 32),
    warn: paint(p.warn, 33),
    error: paint(p.error, 31),
    code: paint(p.code, 36),
    userLabel: paint(p.userLabel, 33),
    bold: (s) => `${BOLD}${s}${RESET}`,
    dim: (s) => `${DIM}${s}${RESET}`,
    italic: (s) => `${ITALIC}${s}${RESET}`,
    underline: (s) => `${UNDERLINE}${s}${RESET}`,
    bgPrimary: (s) => `${bg(p.primary)}${fg('#ffffff')}${s}${RESET}`,
    raw: { fg, bg, hexToRgb },
  };
}




export const WEB_THEMES = {
  aurora: {
    label: 'Aurora',
    description: 'Тёмное стекло с градиентным свечением',
    vars: {
      '--bg': '#0a0b14',
      '--bg-elev': 'rgba(255,255,255,0.04)',
      '--bg-glass': 'rgba(20,22,40,0.72)',
      '--border': 'rgba(255,255,255,0.09)',
      '--text': '#e8eaf6',
      '--muted': '#8b90b0',
      '--primary': '#7c5cff',
      '--primary-soft': 'rgba(124,92,255,0.16)',
      '--accent': '#00d4ff',
      '--success': '#3ddc97',
      '--warn': '#ffb454',
      '--error': '#ff5c7c',
      '--code-bg': 'rgba(0,0,0,0.42)',
      '--radius': '16px',
      '--font': "'Inter', -apple-system, 'Segoe UI', system-ui, sans-serif",
      '--font-mono': "'JetBrains Mono', 'Cascadia Code', ui-monospace, monospace",
      '--glow': '0 0 60px rgba(124,92,255,0.28)',
      '--body-bg':
        'radial-gradient(1200px 600px at 12% -10%, rgba(124,92,255,0.22), transparent 60%),' +
        'radial-gradient(900px 500px at 105% 15%, rgba(0,212,255,0.15), transparent 55%), #0a0b14',
    },
  },

  terminal: {
    label: 'Terminal',
    description: 'Моноширинный «настоящий терминал», зелёный фосфор',
    vars: {
      '--bg': '#0c0f0c',
      '--bg-elev': '#121712',
      '--bg-glass': '#0e120e',
      '--border': '#1f3a1f',
      '--text': '#c8ffc8',
      '--muted': '#4f8f4f',
      '--primary': '#00ff41',
      '--primary-soft': 'rgba(0,255,65,0.12)',
      '--accent': '#adff2f',
      '--success': '#00ff41',
      '--warn': '#e8d44d',
      '--error': '#ff5555',
      '--code-bg': '#060806',
      '--radius': '2px',
      '--font': "'JetBrains Mono', 'Cascadia Code', ui-monospace, monospace",
      '--font-mono': "'JetBrains Mono', 'Cascadia Code', ui-monospace, monospace",
      '--glow': '0 0 24px rgba(0,255,65,0.16)',
      '--body-bg': '#0c0f0c',
      '--scanlines': '1',
    },
  },

  paper: {
    label: 'Paper',
    description: 'Светлая тема, высокая читаемость, как документ',
    vars: {
      '--bg': '#ffffff',
      '--bg-elev': '#f7f7f5',
      '--bg-glass': 'rgba(255,255,255,0.9)',
      '--border': '#e3e3e0',
      '--text': '#1f2328',
      '--muted': '#6e7781',
      '--primary': '#d97757',
      '--primary-soft': 'rgba(217,119,87,0.12)',
      '--accent': '#0969da',
      '--success': '#1a7f37',
      '--warn': '#9a6700',
      '--error': '#cf222e',
      '--code-bg': '#f2f1ef',
      '--radius': '12px',
      '--font': "-apple-system, 'Segoe UI', system-ui, sans-serif",
      '--font-mono': "'SF Mono', 'Cascadia Code', ui-monospace, monospace",
      '--glow': 'none',
      '--body-bg': '#fbfbfa',
    },
  },

  midnight: {
    label: 'Midnight',
    description: 'Глубокий синий, спокойный контраст для долгой работы',
    vars: {
      '--bg': '#11151c',
      '--bg-elev': '#161b24',
      '--bg-glass': 'rgba(22,27,36,0.85)',
      '--border': '#232b38',
      '--text': '#d6deeb',
      '--muted': '#7b88a1',
      '--primary': '#82aaff',
      '--primary-soft': 'rgba(130,170,255,0.14)',
      '--accent': '#c792ea',
      '--success': '#addb67',
      '--warn': '#ffcb6b',
      '--error': '#ef5350',
      '--code-bg': '#0d1117',
      '--radius': '10px',
      '--font': "'Inter', -apple-system, 'Segoe UI', system-ui, sans-serif",
      '--font-mono': "'Fira Code', 'Cascadia Code', ui-monospace, monospace",
      '--glow': 'none',
      '--body-bg': '#11151c',
    },
  },

  sunset: {
    label: 'Sunset',
    description: 'Тёплые закатные градиенты, мягкие тени',
    vars: {
      '--bg': '#1a1220',
      '--bg-elev': 'rgba(255,255,255,0.05)',
      '--bg-glass': 'rgba(38,22,44,0.75)',
      '--border': 'rgba(255,180,140,0.16)',
      '--text': '#f5e6e0',
      '--muted': '#b08f95',
      '--primary': '#ff7e5f',
      '--primary-soft': 'rgba(255,126,95,0.16)',
      '--accent': '#feb47b',
      '--success': '#7ddf94',
      '--warn': '#ffd166',
      '--error': '#ef476f',
      '--code-bg': 'rgba(0,0,0,0.38)',
      '--radius': '18px',
      '--font': "'Inter', -apple-system, 'Segoe UI', system-ui, sans-serif",
      '--font-mono': "'JetBrains Mono', ui-monospace, monospace",
      '--glow': '0 0 60px rgba(255,126,95,0.25)',
      '--body-bg':
        'radial-gradient(1000px 520px at 0% 0%, rgba(255,126,95,0.25), transparent 58%),' +
        'radial-gradient(800px 460px at 100% 10%, rgba(254,180,123,0.18), transparent 55%), #1a1220',
    },
  },

  lime: {
    label: 'Lime',
    description: 'Графит с кислотным лаймом, крупная типографика',
    vars: {
      '--bg': '#101113',
      '--bg-elev': '#18191d',
      '--bg-glass': 'rgba(24,25,29,0.86)',
      '--border': '#2c2e35',
      '--text': '#f4f1ea',
      '--muted': '#989aa4',
      '--primary': '#c8f04d',
      '--primary-soft': 'rgba(200,240,77,0.13)',
      '--accent': '#a3e635',
      '--success': '#a3e635',
      '--warn': '#f5bb65',
      '--error': '#ff6b6b',
      '--code-bg': '#141519',
      '--radius': '11px',
      '--font': "'Manrope', -apple-system, 'Segoe UI', system-ui, sans-serif",
      '--font-mono': "'DM Mono', 'JetBrains Mono', ui-monospace, monospace",
      '--glow': '0 10px 38px rgba(0,0,0,0.35)',
      '--body-bg': '#101113',
    },
  },

  codex: {
    label: 'Codex',
    description: 'Строгий тёмный, зелёно-бирюзовый акцент',
    vars: {
      '--bg': '#0d0d0d',
      '--bg-elev': '#161616',
      '--bg-glass': 'rgba(20,20,20,0.82)',
      '--border': '#2a2a2a',
      '--text': '#ececf1',
      '--muted': '#8e8ea0',
      '--primary': '#10a37f',
      '--primary-soft': 'rgba(16,163,127,0.15)',
      '--accent': '#2dd4bf',
      '--success': '#19c37d',
      '--warn': '#e0a458',
      '--error': '#ef4146',
      '--code-bg': '#000000',
      '--radius': '8px',
      '--font': "-apple-system, 'Segoe UI', system-ui, sans-serif",
      '--font-mono': "'JetBrains Mono', 'Cascadia Code', ui-monospace, monospace",
      '--glow': 'none',
      '--body-bg': '#0d0d0d',
    },
  },
};

export const WEB_THEME_NAMES = Object.keys(WEB_THEMES);
