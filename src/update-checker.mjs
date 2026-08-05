/**
 * Обновления: проверка npm-реестра, предложение обновиться и установка.
 *
 * Живёт по правилам проекта: без внешних зависимостей, ничего не делает
 * без ведома пользователя и не спамит — решение «позже/пропустить/никогда»
 * запоминается (config.update + кэш в ~/.coderoom/update-cache.json).
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CONFIG_DIR, VERSION, saveConfig } from './config.mjs';

export const PACKAGE_NAME = 'coderoom-cli';
/** Читаем лениво: так адрес реестра можно подменить в тестах. */
const registryUrl = () => (process.env.CODEROOM_REGISTRY || 'https://registry.npmjs.org').replace(/\/+$/, '');
const CACHE_FILE = path.join(CONFIG_DIR, 'update-cache.json');
const FETCH_TIMEOUT = 5000;

/** Настройки обновлений с подставленными умолчаниями. */
export function updateSettings(cfg = {}) {
  const u = cfg.update ?? {};
  return {
    check: u.check !== false,
    prompt: u.prompt !== false,
    autoInstall: u.autoInstall === true,
    intervalHours: Number.isFinite(u.intervalHours) ? Math.max(0, u.intervalHours) : 24,
    channel: u.channel || 'latest',
    skipVersion: u.skipVersion || null,
  };
}


/* ─── версии ─────────────────────────────────────────────────────────── */

function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v ?? '').trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ?? null };
}

/** -1 если a < b, 0 если равны, 1 если a > b. Мусор считаем равным. */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;

  for (const k of ['major', 'minor', 'patch']) {
    if (x[k] !== y[k]) return x[k] > y[k] ? 1 : -1;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;   // релиз новее своей предрелизной версии
  if (!y.pre) return -1;
  return x.pre > y.pre ? 1 : -1;
}

/** 'major' | 'minor' | 'patch' | 'none' — насколько велик прыжок. */
export function updateKind(current, latest) {
  if (compareVersions(latest, current) <= 0) return 'none';
  const c = parseVersion(current);
  const l = parseVersion(latest);
  if (!c || !l) return 'none';
  if (l.major !== c.major) return 'major';
  if (l.minor !== c.minor) return 'minor';
  return 'patch';
}


/* ─── кэш ────────────────────────────────────────────────────────────── */

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return { lastCheck: 0, latestVersion: null, snoozeUntil: 0, notifiedVersion: null };
  }
}

function saveCache(patch) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const next = { ...loadCache(), ...patch };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
    return next;
  } catch {
    return null;
  }
}

/** Забыть решения «позже/уже показывали» — для /update и --update. */
export function resetUpdateSnooze() {
  saveCache({ snoozeUntil: 0, notifiedVersion: null });
}


/* ─── npm-реестр ─────────────────────────────────────────────────────── */

async function fetchLatestVersion(channel = 'latest') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(`${registryUrl()}/${PACKAGE_NAME}/${encodeURIComponent(channel)}`, {
      signal: controller.signal,
      headers: { Accept: 'application/vnd.npm.install-v1+json, application/json' },
    });
    if (!res.ok) throw new Error(`реестр npm ответил ${res.status}`);
    const data = await res.json();
    if (!data?.version) throw new Error('реестр не вернул версию');
    return { version: data.version, publishedAt: data.time ?? null };
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'нет ответа от npm (таймаут)' : e.message);
  } finally {
    clearTimeout(timer);
  }
}


/* ─── как поставлен CodeRoom ─────────────────────────────────────────── */

/** Определяем менеджер пакетов и способ установки, чтобы дать верную команду. */
export function detectInstall() {
  const here = fileURLToPath(import.meta.url);
  const norm = here.replace(/\\/g, '/');
  const inNodeModules = norm.includes('/node_modules/');

  let manager = 'npm';
  if (/\/(\.pnpm|pnpm)\//i.test(norm) || process.env.npm_config_user_agent?.startsWith('pnpm')) manager = 'pnpm';
  else if (/\/\.bun\//i.test(norm) || process.env.npm_config_user_agent?.startsWith('bun')) manager = 'bun';
  else if (/\/yarn\//i.test(norm) || process.env.npm_config_user_agent?.startsWith('yarn')) manager = 'yarn';

  const viaNpx = /\/_npx\//.test(norm) || /\/\.npm\/_npx\//.test(norm);
  const local = inNodeModules && norm.startsWith(process.cwd().replace(/\\/g, '/') + '/');
  const fromSource = !inNodeModules;

  return {
    manager,
    viaNpx,
    global: inNodeModules && !local && !viaNpx,
    local,
    fromSource,
    canAutoUpdate: inNodeModules && !viaNpx,
    dir: path.dirname(path.dirname(here)),
  };
}

/** Команда установки для текущего способа установки. */
export function updateCommand(install = detectInstall(), version = 'latest') {
  const pkg = `${PACKAGE_NAME}@${version}`;
  if (install.fromSource) return { cmd: 'git', args: ['pull'], text: 'git pull  (запущен из исходников)' };
  if (install.viaNpx) return { cmd: null, args: [], text: `npx ${PACKAGE_NAME}@latest  (npx всегда берёт свежую)` };

  const g = install.local ? '' : '-g ';
  switch (install.manager) {
    case 'pnpm': return { cmd: 'pnpm', args: [install.local ? 'add' : 'add', ...(install.local ? [] : ['-g']), pkg], text: `pnpm add ${g}${pkg}` };
    case 'yarn': return { cmd: 'yarn', args: install.local ? ['add', pkg] : ['global', 'add', pkg], text: install.local ? `yarn add ${pkg}` : `yarn global add ${pkg}` };
    case 'bun': return { cmd: 'bun', args: ['add', ...(install.local ? [] : ['-g']), pkg], text: `bun add ${g}${pkg}` };
    default: return { cmd: 'npm', args: ['install', ...(install.local ? [] : ['-g']), pkg], text: `npm install ${g}${pkg}` };
  }
}


/* ─── проверка ───────────────────────────────────────────────────────── */

/**
 * Проверить наличие новой версии.
 * @returns {{updateAvailable:boolean, currentVersion:string, latestVersion:string|null,
 *            kind:string, fromCache:boolean, skipped?:boolean, error?:string}}
 */
export async function checkForUpdates({ cfg = {}, force = false, silent = true } = {}) {
  const s = updateSettings(cfg);
  const cache = loadCache();
  const now = Date.now();

  const shape = (latestVersion, fromCache, extra = {}) => {
    const kind = latestVersion ? updateKind(VERSION, latestVersion) : 'none';
    return {
      updateAvailable: kind !== 'none',
      currentVersion: VERSION,
      latestVersion: latestVersion ?? null,
      kind,
      fromCache,
      skipped: !!(s.skipVersion && latestVersion && compareVersions(latestVersion, s.skipVersion) <= 0),
      ...extra,
    };
  };

  if (!force && !s.check) return shape(cache.latestVersion, true, { disabled: true });

  const fresh = cache.latestVersion && now - (cache.lastCheck ?? 0) < s.intervalHours * 3600_000;
  if (!force && fresh) return shape(cache.latestVersion, true);

  try {
    const { version } = await fetchLatestVersion(s.channel);
    saveCache({ lastCheck: now, latestVersion: version, checkedAt: new Date().toISOString() });
    return shape(version, false);
  } catch (e) {
    if (cache.latestVersion) return shape(cache.latestVersion, true, { error: e.message });
    if (!silent) console.warn(`  Не удалось проверить обновления: ${e.message}`);
    return shape(null, false, { error: e.message });
  }
}

/** Стоит ли вообще беспокоить пользователя этой версией. */
export function shouldPrompt(result, cfg = {}) {
  const s = updateSettings(cfg);
  if (!result?.updateAvailable || !s.check) return false;
  if (result.skipped) return false;
  const cache = loadCache();
  if (cache.snoozeUntil && Date.now() < cache.snoozeUntil) return false;
  return true;
}


/* ─── установка ──────────────────────────────────────────────────────── */

/**
 * Поставить новую версию. Вывод npm отдаём построчно через onOutput.
 * @returns {Promise<{ok:boolean, code:number|null, command:string, output:string, hint?:string}>}
 */
export function runUpdate({ version = 'latest', onOutput, install = detectInstall(), timeout = 180_000 } = {}) {
  const plan = updateCommand(install, version);

  if (!plan.cmd) {
    return Promise.resolve({ ok: false, code: null, command: plan.text, output: '', hint: 'Установить автоматически нельзя — команда выше.' });
  }

  return new Promise((resolve) => {
    let out = '';
    const push = (chunk) => {
      const text = chunk.toString();
      out += text;
      for (const line of text.split(/\r?\n/)) if (line.trim()) onOutput?.(line.trim());
    };

    let child;
    try {
      child = spawn(plan.cmd, plan.args, {
        shell: process.platform === 'win32', // npm/pnpm на Windows — .cmd
        windowsHide: true,
        env: { ...process.env, npm_config_yes: 'true' },
      });
    } catch (e) {
      return resolve({ ok: false, code: null, command: plan.text, output: e.message, hint: `Поставь вручную: ${plan.text}` });
    }

    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, timeout);

    child.stdout?.on('data', push);
    child.stderr?.on('data', push);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, command: plan.text, output: e.message, hint: `Поставь вручную: ${plan.text}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const ok = code === 0;
      let hint;
      if (!ok) {
        if (/EACCES|EPERM|permission denied/i.test(out)) {
          hint = process.platform === 'win32'
            ? 'Нет прав: запусти терминал от администратора.'
            : `Нет прав: sudo ${plan.text}`;
        } else {
          hint = `Не вышло автоматически — поставь вручную: ${plan.text}`;
        }
      }
      resolve({ ok, code, command: plan.text, output: out, hint });
    });
  });
}


/* ─── вывод ──────────────────────────────────────────────────────────── */

const KIND_LABEL = { major: 'мажорное', minor: 'минорное', patch: 'патч' };

/** Короткая строка-уведомление (для --print, веба, неинтерактивных мест). */
export function formatUpdateMessage(result, t) {
  if (!result?.updateAvailable) return null;
  const plan = updateCommand();
  const kind = KIND_LABEL[result.kind] ?? '';
  return [
    '',
    `  ${t.bold(t.primary('Доступно обновление'))} ${t.muted(`${result.currentVersion} → `)}${t.bold(t.primary(result.latestVersion))} ${t.muted(kind ? `(${kind})` : '')}`,
    `  ${t.muted('Обновить:')} ${t.code(plan.text)}   ${t.muted('или /update в диалоге')}`,
    '',
  ].join('\n');
}

/** Не спрашивая ничего, просто сообщить о новой версии (одно напоминание на версию). */
export async function maybeNotifyUpdate(cfg, t, { write = (s) => console.log(s) } = {}) {
  const s = updateSettings(cfg);
  if (!s.check) return null;

  const result = await checkForUpdates({ cfg, silent: true });
  if (!result.updateAvailable || result.skipped) return result;

  const cache = loadCache();
  if (cache.notifiedVersion === result.latestVersion) return result;
  saveCache({ notifiedVersion: result.latestVersion });

  const msg = formatUpdateMessage(result, t);
  if (msg) write(msg);
  return result;
}


/* ─── решения пользователя ───────────────────────────────────────────── */

/** «Позже» — не напоминать сутки. */
export function snoozeUpdate(hours = 24) {
  saveCache({ snoozeUntil: Date.now() + hours * 3600_000 });
}

/** «Пропустить эту версию» — больше про неё не вспоминаем. */
export function skipVersion(cfg, version) {
  cfg.update ??= {};
  cfg.update.skipVersion = version;
  try { saveConfig(cfg); } catch { /* ignore */ }
}

/** Включить/выключить проверку обновлений. */
export function setUpdateCheck(cfg, on) {
  cfg.update ??= {};
  cfg.update.check = !!on;
  try { saveConfig(cfg); } catch { /* ignore */ }
  return cfg.update.check;
}

/** Ставить обновления молча, без вопросов. */
export function setAutoInstall(cfg, on) {
  cfg.update ??= {};
  cfg.update.autoInstall = !!on;
  if (on) cfg.update.check = true;
  try { saveConfig(cfg); } catch { /* ignore */ }
  return cfg.update.autoInstall;
}
