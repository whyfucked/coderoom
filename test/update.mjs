/**
 * Проверка обновлений и «больше не спрашивать» — без шлюза и без сети.
 * Реестр npm поднимаем свой, дом уводим в temp: `node test/update.mjs`.
 */

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

process.env.NO_COLOR = '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coderoom-update-'));
process.env.CODEROOM_HOME = path.join(tmp, 'home');

let fails = 0;
const check = async (name, fn) => {
  try {
    const r = await fn();
    console.log(`  OK   ${name}${r ? '  ' + r : ''}`);
  } catch (e) {
    fails++;
    console.log(`  FAIL ${name}\n       ${e.message}`);
  }
};

const UP = await import('../src/update-checker.mjs');
const { PermissionEngine, ruleFor } = await import('../src/permissions.mjs');
const { loadConfig, saveConfig, CONFIG_FILE, VERSION } = await import('../src/config.mjs');
const { toolByName } = await import('../src/tools.mjs');

console.log('\n── версии ──');

await check('сравнение версий', () => {
  if (UP.compareVersions('1.2.3', '1.2.4') !== -1) throw new Error('1.2.3 < 1.2.4');
  if (UP.compareVersions('2.0.0', '1.9.9') !== 1) throw new Error('2.0.0 > 1.9.9');
  if (UP.compareVersions('1.0.0', '1.0.0') !== 0) throw new Error('равные');
  if (UP.compareVersions('1.0.0-beta.1', '1.0.0') !== -1) throw new Error('пререлиз старше релиза');
  return 'меньше / больше / равно / пререлиз';
});

await check('тип обновления', () => {
  const cases = [['1.0.0', '2.0.0', 'major'], ['1.0.0', '1.1.0', 'minor'], ['1.0.0', '1.0.1', 'patch'], ['1.0.1', '1.0.0', 'none']];
  for (const [a, b, want] of cases) {
    const got = UP.updateKind(a, b);
    if (got !== want) throw new Error(`${a}→${b}: ${got}, ждали ${want}`);
  }
  return 'major/minor/patch/none';
});

await check('команда установки под менеджер пакетов', () => {
  const g = UP.updateCommand({ manager: 'npm', global: true }, '2.0.0');
  if (g.cmd !== 'npm' || !g.args.includes('-g')) throw new Error('глобальная: ' + g.text);
  if (!g.text.includes('coderoom-cli@2.0.0')) throw new Error('нет версии: ' + g.text);
  if (UP.updateCommand({ manager: 'npm', local: true }).args.includes('-g')) throw new Error('локальной подсунули -g');
  if (UP.updateCommand({ manager: 'pnpm' }).cmd !== 'pnpm') throw new Error('pnpm');
  if (UP.updateCommand({ viaNpx: true }).cmd !== null) throw new Error('npx ставить нечего');
  if (UP.updateCommand({ fromSource: true }).cmd !== 'git') throw new Error('исходники — git pull');
  return g.text;
});

await check('detectInstall() понимает, откуда запущен', () => {
  const i = UP.detectInstall();
  if (typeof i.manager !== 'string') throw new Error('нет manager');
  return `${i.manager}${i.fromSource ? ' · из исходников' : i.global ? ' · глобально' : ' · локально'}`;
});

console.log('\n── проверка и решения ──');

const registry = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ version: '99.0.0' }));
});
await new Promise((r) => registry.listen(0, '127.0.0.1', r));
process.env.CODEROOM_REGISTRY = `http://127.0.0.1:${registry.address().port}`;

const cfg = loadConfig();

await check('видит новую версию в реестре', async () => {
  const res = await UP.checkForUpdates({ cfg, force: true });
  if (res.latestVersion !== '99.0.0') throw new Error('версия: ' + res.latestVersion);
  if (!res.updateAvailable || res.kind !== 'major') throw new Error(JSON.stringify(res));
  if (!UP.shouldPrompt(res, cfg)) throw new Error('не собирается спрашивать');
  return `${VERSION} → 99.0.0`;
});

await check('«позже» молчит сутки, /update возвращает вопрос', async () => {
  const res = await UP.checkForUpdates({ cfg, force: true });
  UP.snoozeUpdate(24);
  if (UP.shouldPrompt(res, cfg)) throw new Error('спрашивает после «позже»');
  UP.resetUpdateSnooze();
  if (!UP.shouldPrompt(res, cfg)) throw new Error('после сброса молчит');
  return 'позже → тишина, /update → снова спрашиваем';
});

await check('«пропустить версию» и «не проверять» запоминаются', async () => {
  UP.skipVersion(cfg, '99.0.0');
  const skipped = await UP.checkForUpdates({ cfg, force: true });
  if (!skipped.skipped || UP.shouldPrompt(skipped, cfg)) throw new Error('всё ещё пристаёт');

  UP.setUpdateCheck(cfg, false);
  const off = await UP.checkForUpdates({ cfg });
  if (UP.shouldPrompt(off, cfg)) throw new Error('спрашивает при выключенной проверке');

  const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  if (saved.update.skipVersion !== '99.0.0' || saved.update.check !== false) {
    throw new Error('в конфиг не записалось: ' + JSON.stringify(saved.update));
  }

  UP.setUpdateCheck(cfg, true);
  cfg.update.skipVersion = null;
  saveConfig(cfg);
  return 'skipVersion + check в config.json';
});

await check('автообновление включается одним переключателем', () => {
  UP.setAutoInstall(cfg, true);
  if (!UP.updateSettings(cfg).autoInstall) throw new Error('не включилось');
  if (!UP.updateSettings(cfg).check) throw new Error('автоустановка без проверки бессмысленна');
  UP.setAutoInstall(cfg, false);
  return 'update.autoInstall';
});

await check('кэш бережёт сеть, а упавший реестр не ломает запуск', async () => {
  await UP.checkForUpdates({ cfg, force: true });   // прогреваем кэш
  registry.close();
  const cached = await UP.checkForUpdates({ cfg });
  if (!cached.fromCache || cached.latestVersion !== '99.0.0') throw new Error('кэш не сработал');

  process.env.CODEROOM_REGISTRY = 'http://127.0.0.1:1';
  const broken = await UP.checkForUpdates({ cfg: { update: { intervalHours: 0 } }, force: true });
  if (broken.updateAvailable && !broken.fromCache) throw new Error('придумал обновление');
  return 'кэш ок, недоступный реестр обработан';
});

console.log('\n── «больше не спрашивать» ──');

await check('правило запоминается и переживает перезапуск', () => {
  const local = loadConfig();
  local.permissions.mode = 'default';
  const eng = new PermissionEngine(local);
  const args = { command: 'npm run build' };

  if (eng.check('Bash', args, toolByName('Bash')).decision !== 'ask') throw new Error('сразу разрешил');

  const rule = eng.allowForever('Bash', args);
  if (rule !== 'Bash(npm run *)') throw new Error('правило: ' + rule);

  const fresh = new PermissionEngine(local); // новый запуск
  if (fresh.check('Bash', { command: 'npm run test' }, toolByName('Bash')).decision !== 'allow') {
    throw new Error('снова спрашивает');
  }
  if (fresh.check('Bash', { command: 'git push --force' }, toolByName('Bash')).decision !== 'ask') {
    throw new Error('правило разрешило чужое');
  }
  return rule;
});

await check('правила для файлов и сети выглядят разумно', () => {
  if (ruleFor('Write', { path: 'src/a.js' }) !== 'Write(**)') throw new Error('Write');
  if (ruleFor('Bash', { command: 'ls -la' }) !== 'Bash(ls *)') throw new Error('Bash: ' + ruleFor('Bash', { command: 'ls -la' }));
  const web = ruleFor('WebFetch', { url: 'https://example.com/a/b?x=1' });
  if (web !== 'WebFetch(https://example.com/**)') throw new Error('WebFetch: ' + web);
  return 'Write(**) · Bash(ls *) · WebFetch(домен)';
});

try { registry.close(); } catch { /* уже закрыт */ }
fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

console.log(fails ? `\n✗ провалено: ${fails}\n` : '\n✓ обновления и права работают\n');
process.exit(fails ? 1 : 0);
