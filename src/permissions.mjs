import path from 'node:path';
import fs from 'node:fs';

export const MODES = {
  default: { label: 'обычный', hint: 'спрашивать перед изменениями' },
  acceptEdits: { label: 'авто-правки', hint: 'править файлы без вопросов, команды — спрашивать' },
  plan: { label: 'планирование', hint: 'только чтение, никаких изменений' },
  yolo: { label: 'без тормозов', hint: 'разрешать всё (кроме deny) — осторожно!' },
};


export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        re += '[^/\\\\]*';
      }
    } else if (c === '?') re += '[^/\\\\]';
    else if ('\\^$+.()|{}[]'.includes(c)) re += '\\' + c;
    else if (c === '/') re += '[/\\\\]';
    else re += c;
  }
  return new RegExp(`^${re}$`, 'i');
}

function parseRule(rule) {
  const m = /^([A-Za-z_]+)(?:\((.*)\))?$/.exec(rule.trim());
  if (!m) return null;
  return { tool: m[1], pattern: m[2] ?? '**' };
}


function subjectFor(toolName, args) {
  switch (toolName) {
    case 'Bash':
      return args?.command ?? '';
    case 'WebFetch':
      return args?.url ?? '';
    default:
      return args?.path ?? args?.pattern ?? args?.file ?? '**';
  }
}

/** Команды, где первое слово ничего не говорит: git push ≠ git status. */
const TWO_WORD_CLI = new Set([
  'git', 'npm', 'pnpm', 'yarn', 'bun', 'npx', 'docker', 'cargo', 'go', 'dotnet',
  'kubectl', 'pip', 'pip3', 'python', 'python3', 'node', 'make', 'gh', 'composer', 'gradle',
]);

/**
 * Правило, которым можно один раз и навсегда разрешить «такие же» вызовы.
 * Bash — по команде (`git *`), остальное — по инструменту (`Write(**)`),
 * WebFetch — по домену.
 */
export function ruleFor(toolName, args) {
  if (toolName === 'Bash') {
    const cmd = String(args?.command ?? '').trim();
    const parts = cmd.split(/\s+/).filter(Boolean);
    if (!parts.length) return 'Bash(**)';
    const base = parts[0];
    const prefix = TWO_WORD_CLI.has(base) && parts[1] && !parts[1].startsWith('-')
      ? `${base} ${parts[1]}`
      : base;
    return `Bash(${prefix} *)`;
  }

  if (toolName === 'WebFetch') {
    try {
      const u = new URL(String(args?.url ?? ''));
      return `WebFetch(${u.protocol}//${u.host}/**)`;
    } catch {
      return 'WebFetch(**)';
    }
  }

  return `${toolName}(**)`;
}

function ruleMatches(rule, toolName, args) {
  const parsed = parseRule(rule);
  if (!parsed) return false;
  if (parsed.tool.toLowerCase() !== toolName.toLowerCase()) return false;
  if (parsed.pattern === '**' || parsed.pattern === '*') return true;

  const subject = String(subjectFor(toolName, args) ?? '');

  if (toolName === 'Bash') {
    const pat = parsed.pattern.trim();
    if (pat.endsWith('*')) return subject.trim().startsWith(pat.slice(0, -1).trim());
    return subject.trim() === pat || globToRegExp(pat).test(subject.trim());
  }

  const norm = subject.replace(/\\/g, '/');
  return globToRegExp(parsed.pattern).test(norm) || globToRegExp(parsed.pattern).test(path.basename(norm));
}


const DANGEROUS = [
  { re: /\brm\s+(-[a-z]*\s+)*-[a-z]*[rf]/i, why: 'рекурсивное удаление файлов' },
  { re: /\brmdir\s+\/s/i, why: 'рекурсивное удаление каталога' },
  { re: /\bdel\s+\/[sq]/i, why: 'массовое удаление файлов' },
  { re: /\bformat\s+[a-z]:/i, why: 'форматирование диска' },
  { re: /\bmkfs\b/i, why: 'создание файловой системы' },
  { re: /\bdd\s+.*of=\/dev\//i, why: 'прямая запись на устройство' },
  { re: /:\(\)\{.*\};:/, why: 'fork-бомба' },
  { re: /\bgit\s+push\b.*(--force|-f)\b/i, why: 'force-push перезапишет историю' },
  { re: /\bgit\s+reset\s+--hard\b/i, why: 'потеря несохранённых изменений' },
  { re: /\bgit\s+clean\s+-[a-z]*[fd]/i, why: 'удаление неотслеживаемых файлов' },
  { re: /\bshutdown\b|\breboot\b/i, why: 'выключение/перезагрузка системы' },
  { re: /\bchmod\s+(-R\s+)?777\b/i, why: 'небезопасные права доступа' },
  { re: /\bcurl\b[^|]*\|\s*(ba)?sh/i, why: 'исполнение скрипта из интернета' },
  { re: /\bwget\b[^|]*\|\s*(ba)?sh/i, why: 'исполнение скрипта из интернета' },
  { re: /\biwr\b.*\|\s*iex/i, why: 'исполнение скрипта из интернета' },
  { re: /\bnpm\s+publish\b/i, why: 'публикация пакета' },
  { re: /\bdocker\s+.*\s+prune\s+.*-a/i, why: 'массовая очистка docker' },
  { re: />\s*\/dev\/sd[a-z]/i, why: 'запись на диск' },
];

export function checkDangerous(command) {
  for (const d of DANGEROUS) if (d.re.test(command)) return d.why;
  return null;
}


const READ_ONLY = new Set(['Read', 'Glob', 'Grep', 'List', 'Todo']);

export class PermissionEngine {
  constructor(cfg) {
    this.cfg = cfg;
    this.sessionAllow = new Set();
  }

  get mode() {
    return this.cfg.permissions.mode ?? 'default';
  }

  setMode(mode) {
    if (!MODES[mode]) throw new Error(`Неизвестный режим: ${mode}. Доступны: ${Object.keys(MODES).join(', ')}`);
    this.cfg.permissions.mode = mode;
  }

  allowForSession(toolName, args) {
    this.sessionAllow.add(`${toolName}:${subjectFor(toolName, args)}`);
  }

  /**
   * Разрешить навсегда: правило уходит в allow и переживает перезапуск
   * (сохранение конфига — на вызывающей стороне). Возвращает правило.
   */
  allowForever(toolName, args) {
    const rule = ruleFor(toolName, args);
    this.addRule('allow', rule);
    this.cfg.permissions.ask = (this.cfg.permissions.ask ?? []).filter((r) => r !== rule);
    this.allowForSession(toolName, args);
    return rule;
  }


  check(toolName, args, tool) {
    const p = this.cfg.permissions;

    for (const rule of p.deny ?? []) {
      if (ruleMatches(rule, toolName, args)) {
        return { decision: 'deny', reason: `запрещено правилом ${rule}` };
      }
    }

    if (this.mode === 'plan' && tool?.mutating) {
      return {
        decision: 'deny',
        reason: 'режим планирования: изменения запрещены. Переключись: /mode default',
      };
    }

    const danger = toolName === 'Bash' && this.cfg.security?.confirmDangerousCommands && this.mode !== 'yolo'
      ? checkDangerous(args?.command ?? '')
      : null;
    if (danger) return { decision: 'ask', danger, reason: `потенциально опасно: ${danger}` };

    if (this.sessionAllow.has(`${toolName}:${subjectFor(toolName, args)}`)) {
      return { decision: 'allow', reason: 'разрешено на эту сессию' };
    }

    if (this.mode === 'yolo') return { decision: 'allow', reason: 'режим yolo' };
    if (this.mode === 'acceptEdits' && tool && !tool.requiresExplicitApproval) {
      return { decision: 'allow', reason: 'режим авто-правок' };
    }

    for (const rule of p.allow ?? []) {
      if (ruleMatches(rule, toolName, args)) return { decision: 'allow', reason: `правило ${rule}` };
    }

    for (const rule of p.ask ?? []) {
      if (ruleMatches(rule, toolName, args)) return { decision: 'ask', reason: `правило ${rule}` };
    }

    if (READ_ONLY.has(toolName)) return { decision: 'allow', reason: 'read-only инструмент' };
    return { decision: 'ask', reason: 'по умолчанию' };
  }


  addRule(kind, rule) {
    if (!['allow', 'ask', 'deny'].includes(kind)) throw new Error('kind: allow|ask|deny');
    this.cfg.permissions[kind] ??= [];
    if (!this.cfg.permissions[kind].includes(rule)) this.cfg.permissions[kind].push(rule);
  }
}



export class PathAccessError extends Error {}


export function safeResolve(cwd, target, cfg, { forWrite = false } = {}) {
  if (typeof target !== 'string' || !target.trim()) {
    throw new PathAccessError('Путь не указан');
  }

  const abs = path.resolve(cwd, target);
  const root = path.resolve(cwd);

  if (cfg?.security?.restrictToWorkspace) {
    const rel = path.relative(root, abs);
    const outside = rel.startsWith('..') || path.isAbsolute(rel);
    if (outside) {
      throw new PathAccessError(
        `Путь вне рабочей папки: ${target}\n` +
          `Рабочая папка: ${root}\n` +
          `Отключить ограничение: security.restrictToWorkspace = false в ~/.coderoom/config.json`,
      );
    }
  }

  try {
    const real = fs.realpathSync(abs);
    if (cfg?.security?.restrictToWorkspace) {
      const realRoot = fs.realpathSync(root);
      const rel = path.relative(realRoot, real);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new PathAccessError(`Симлинк ведёт за пределы рабочей папки: ${target}`);
      }
    }
  } catch (e) {
    if (e instanceof PathAccessError) throw e;
  }

  const base = path.basename(abs);
  for (const pattern of cfg?.security?.blockedPaths ?? []) {
    if (globToRegExp(pattern).test(base)) {
      throw new PathAccessError(
        `Доступ к «${base}» заблокирован (похоже на секрет).\n` +
          `Если файл нужен — убери шаблон из security.blockedPaths`,
      );
    }
  }

  return abs;
}


export function redactSecrets(text, cfg) {
  if (!cfg?.security?.redactSecrets || typeof text !== 'string') return text;
  return text
    .replace(/\b(sk-[A-Za-z0-9_-]{16,})/g, (m) => m.slice(0, 6) + '…REDACTED')
    .replace(/\b(ghp_|gho_|github_pat_)[A-Za-z0-9_]{16,}/g, '…REDACTED')
    .replace(/\b(AKIA[0-9A-Z]{16})\b/g, '…REDACTED')
    .replace(/(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g, '$1…REDACTED$2')
    .replace(/((?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*)(['"]?)([^\s'"]{8,})\2/gi, '$1$2…REDACTED$2');
}
