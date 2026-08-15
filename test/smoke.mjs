/**
 * Дымовой тест: грузим все модули, проверяем что экспорты на месте
 * и базовые функции работают. Конфиг уводим в temp, чтобы не трогать ~/.coderoom.
 *
 * Сеть не дёргаем: живые запросы к провайдеру — отдельная проверка (см. README).
 * Цвета глушим (NO_COLOR) до импортов, чтобы строковые проверки не спотыкались об ANSI.
 */

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.NO_COLOR = '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coderoom-test-'));
process.env.CODEROOM_HOME = path.join(tmp, 'home');
process.env.CODEROOM_GATEWAY_DATA = path.join(tmp, 'gwdata'); // изолируем данные шлюза от server/data
delete process.env.SEEKAI_API_KEY;
delete process.env.SEEKAI_API_KEYS;
delete process.env.BLUESMINDS_API_KEY;
delete process.env.BLUESMINDS_API_KEYS;
delete process.env.HCNSEC_API_KEY;
delete process.env.HCNSEC_API_KEYS;
delete process.env.NVIDIA_API_KEY;
delete process.env.NVIDIA_API_KEYS;


let fails = 0;
const ok = (name, extra = '') => console.log(`  OK   ${name}${extra ? '  ' + extra : ''}`);
const bad = (name, err) => { fails++; console.log(`  FAIL ${name}\n       ${err?.message ?? err}`); };

async function check(name, fn) {
  try {
    const r = await fn();
    ok(name, r ?? '');
  } catch (e) {
    bad(name, e);
  }
}

console.log('\n── импорты ──');

const mods = {};
for (const m of ['config', 'themes', 'ansi', 'render', 'keys', 'screen', 'select', 'input', 'permissions', 'tools', 'plugins', 'provider', 'session', 'agent', 'onboarding', 'repl', 'web', 'web-client', 'update-checker', 'ssh']) {
  await check(m + '.mjs', async () => {
    mods[m] = await import(`../src/${m}.mjs`);
    return Object.keys(mods[m]).join(', ').slice(0, 90);
  });
}
// шлюз — отдельный сервер в server/ (данные уже в temp через CODEROOM_GATEWAY_DATA)
const GW = await import('../server/gateway.mjs').catch((e) => { bad('server/gateway.mjs', e); return null; });
if (fails || !GW) { console.log('\nимпорты сломаны, дальше смысла нет\n'); process.exit(1); }

console.log('\n── ожидаемые экспорты ──');

const expect = {
  config: ['CONFIG_DIR', 'CONFIG_FILE', 'SESSIONS_DIR', 'GLOBAL_MEMORY', 'PROVIDER_PRESETS', 'loadConfig', 'saveConfig', 'resolveProvider', 'setProviderKey', 'maskKey'],
  themes: ['THEMES', 'WEB_THEMES', 'THEME_NAMES', 'createTheme'],
  ansi: ['visLen', 'truncate', 'glyphs', 'stripAnsi', 'cursor', 'width', 'unicodeOK', 'screenRows', 'progressBar'],
  render: ['Spinner', 'StreamRenderer', 'renderMarkdown', 'renderDiff', 'box', 'fmtNum', 'termWidth'],
  keys: ['onKey', 'release'],
  screen: ['claim', 'notify', 'hasOwner'],
  select: ['select', 'confirmSelect'],
  input: ['createInput'],
  permissions: ['MODES', 'PermissionEngine', 'safeResolve', 'redactSecrets', 'globToRegExp', 'checkDangerous', 'ruleFor'],
  'update-checker': ['checkForUpdates', 'shouldPrompt', 'runUpdate', 'updateCommand', 'updateSettings', 'compareVersions', 'updateKind', 'detectInstall', 'maybeNotifyUpdate', 'snoozeUpdate', 'skipVersion', 'setUpdateCheck', 'setAutoInstall', 'resetUpdateSnooze'],
  tools: ['ALL_TOOLS', 'toolSchemas', 'toolByName', 'describeCall', 'SkillTool'],
  plugins: ['loadPlugins', 'expandCommand', 'parseFrontmatter', 'skillsSummary', 'BUNDLED_PLUGINS_DIR'],
  provider: ['Provider', 'ProviderError', 'estimateTokens'],
  session: ['Session'],
  agent: ['Agent', 'buildSystemPrompt', 'loadMemory'],
  onboarding: ['runOnboarding', 'changeKey', 'VERSION'],
  repl: ['Repl'],
  web: ['startWebServer'],
  'web-client': ['clientHtml'],
  ssh: ['listHosts', 'getHost', 'addHost', 'removeHost', 'parseTarget', 'ensureKey', 'hasKey', 'publicKey', 'runRemote', 'interactive', 'checkKeyAuth', 'installKey', 'probe', 'markOk', 'KEY_FILE', 'KNOWN_HOSTS'],
};

await check('server/gateway.mjs: нужные экспорты', () => {
  for (const n of ['startGateway', 'createKey', 'listKeys', 'revokeKey', 'loadUpstreams', 'loadDotenv', 'GATEWAY_UPSTREAMS', 'DATA_DIR']) {
    if (!(n in GW)) throw new Error('нет ' + n);
  }
  return Object.keys(GW).length + ' экспортов';
});

for (const [m, names] of Object.entries(expect)) {
  const missing = names.filter((n) => !(n in mods[m]));
  if (missing.length) bad(`${m}: экспорты`, new Error('нет: ' + missing.join(', ')));
  else ok(`${m}: ${names.length} экспортов`);
}

console.log('\n── конфиг ──');

const { loadConfig, saveConfig, resolveProvider, setProviderKey, maskKey, PROVIDER_PRESETS, MODEL_TIERS, CONFIG_FILE } = mods.config;

let cfg;

await check('loadConfig() создаёт дефолт', () => {
  cfg = loadConfig();
  if (!cfg.provider || !cfg.model) throw new Error('нет provider/model');
  return `${cfg.provider} / ${cfg.model} / тема ${cfg.theme}`;
});

await check('клиент ходит только через свой шлюз (coderoom)', () => {
  const ids = Object.keys(PROVIDER_PRESETS);
  if (ids.length !== 1 || ids[0] !== 'coderoom') throw new Error('провайдеры: ' + ids.join(', '));
  const modelIds = PROVIDER_PRESETS.coderoom.models.map((m) => m.id);
  for (const need of ['claude-opus-4-7', 'auto', 'DeepSeek-V4-Pro', 'nemotron-3-ultra-550b']) {
    if (!modelIds.includes(need)) throw new Error('нет модели ' + need);
  }
  return `coderoom, моделей ${modelIds.length}`;
});

await check('в каталоге только чат: картинок/аудио и StepAudio нет', () => {
  const models = PROVIDER_PRESETS.coderoom.models;
  const nonChat = models.filter((m) => m.chat === false);
  if (nonChat.length) throw new Error('остались не-chat модели: ' + nonChat.map((m) => m.id).join(', '));
  const junk = models.filter((m) => /stepaudio|image-edit|-tts|-asr|realtime/i.test(m.id));
  if (junk.length) throw new Error('остались не-текстовые: ' + junk.map((m) => m.id).join(', '));
  return `${models.length} моделей, все чат`;
});

await check('каждая модель клиента лежит в своём разделе (Anthropic, Nvidia, Qwen…)', () => {
  const models = PROVIDER_PRESETS.coderoom.models;
  const noTier = models.filter((m) => !m.tier || !MODEL_TIERS[m.tier]);
  if (noTier.length) throw new Error('без раздела: ' + noTier.map((m) => m.id).slice(0, 5).join(', '));

  // разделы, обещанные в /model — должны быть непустыми
  for (const tier of ['anthropic', 'openai', 'nvidia', 'deepseek', 'google', 'qwen', 'zai']) {
    if (!MODEL_TIERS[tier]) throw new Error('нет раздела ' + tier);
    if (!models.some((m) => m.tier === tier)) throw new Error('раздел пуст: ' + tier);
  }
  // порядок разделов уникален — иначе в /model заголовки задвоятся
  const orders = Object.values(MODEL_TIERS).map((t) => t.order);
  if (new Set(orders).size !== orders.length) throw new Error('одинаковый order у разделов');

  const byTier = Object.keys(MODEL_TIERS).map((t) => `${t}:${models.filter((m) => m.tier === t).length}`);
  return byTier.join(' ');
});

await check('/model: сначала производитель, затем его модели', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'repl.mjs'), 'utf8');
  if (!source.includes("subtitle: 'Сначала выбери производителя'")) throw new Error('нет меню производителей');
  if (!source.includes('title: chosenGroup.label')) throw new Error('нет меню моделей выбранного производителя');
  return 'производитель → модель';
});

await check('апстримы шлюза: seekai + bluesminds + nvidia (только Nemotron) + hcnsec', () => {
  const U = GW.GATEWAY_UPSTREAMS;
  for (const need of ['seekai', 'bluesminds', 'nvidia', 'hcnsec']) {
    if (!U[need]) throw new Error('нет апстрима: ' + need);
  }
  if (U.agentrouter) throw new Error('agentrouter должен быть удалён');

  if (U.seekai.keyEnv !== 'SEEKAI_API_KEY') throw new Error('seekai keyEnv: ' + U.seekai.keyEnv);
  if (!U.seekai.models.includes('claude-opus-4-7')) throw new Error('seekai без claude-opus-4-7');
  if (!U.seekai.models.includes('claude-opus-4-8')) throw new Error('seekai без claude-opus-4-8');
  if (!U.seekai.models.includes('claude-opus-5')) throw new Error('seekai без claude-opus-5');
  if (!U.seekai.models.includes('gpt-5.6-sol')) throw new Error('seekai без gpt-5.6-sol');

  if (U.bluesminds.keyEnv !== 'BLUESMINDS_API_KEY') throw new Error('bluesminds keyEnv: ' + U.bluesminds.keyEnv);
  if (!U.bluesminds.baseUrl.includes('api.bluesminds.com')) throw new Error('bluesminds baseUrl: ' + U.bluesminds.baseUrl);
  if (U.bluesminds.models.length !== 15) throw new Error('bluesminds моделей: ' + U.bluesminds.models.length + ' (ждём 15)');
  for (const need of ['z-ai/glm-5.2', 'qwen/qwen3-coder-480b-a35b-instruct', 'openai/gpt-oss-120b']) {
    if (!U.bluesminds.models.includes(need)) throw new Error('нет модели ' + need);
  }

  if (U.nvidia.keyEnv !== 'NVIDIA_API_KEY') throw new Error('nvidia keyEnv: ' + U.nvidia.keyEnv);
  if (!U.nvidia.baseUrl.includes('integrate.api.nvidia.com')) throw new Error('nvidia baseUrl: ' + U.nvidia.baseUrl);
  const notNemotron = U.nvidia.models.filter((m) => !/nemotron/i.test(m));
  if (notNemotron.length) throw new Error('у nvidia осталось лишнее: ' + notNemotron.join(', '));

  return `seekai ${U.seekai.models.length} + bluesminds ${U.bluesminds.models.length} + ` +
    `nvidia ${U.nvidia.models.length} + hcnsec ${U.hcnsec.models.length}`;
});


await check('nvidia: enable_thinking по умолчанию, env выключает', () => {
  const before = process.env.NVIDIA_ENABLE_THINKING;
  try {
    delete process.env.NVIDIA_ENABLE_THINKING;
    const on = GW.loadUpstreams().nvidia.defaultParams;
    if (on?.chat_template_kwargs?.enable_thinking !== true) {
      throw new Error('не подставился enable_thinking: ' + JSON.stringify(on));
    }
    process.env.NVIDIA_ENABLE_THINKING = '0';
    const off = GW.loadUpstreams().nvidia.defaultParams;
    if (off?.chat_template_kwargs) throw new Error('env не выключил: ' + JSON.stringify(off));
    // у других апстримов дефолтов нет — их тела не трогаем
    if (Object.keys(GW.loadUpstreams().hcnsec.defaultParams ?? {}).length) {
      throw new Error('hcnsec получил чужие дефолты');
    }
    return 'вкл по умолчанию · NVIDIA_ENABLE_THINKING=0 выключает';
  } finally {
    if (before === undefined) delete process.env.NVIDIA_ENABLE_THINKING;
    else process.env.NVIDIA_ENABLE_THINKING = before;
  }
});

await check('шлюз загружает пул API-ключей и старый одиночный формат', () => {
  const oldMany = process.env.SEEKAI_API_KEYS;
  const oldOne = process.env.HCNSEC_API_KEY;
  try {
    process.env.SEEKAI_API_KEYS = 'sk-one, sk-two\nsk-three;sk-two';
    process.env.HCNSEC_API_KEY = 'sk-legacy';
    const loaded = GW.loadUpstreams();
    if (loaded.seekai.apiKeys.join(',') !== 'sk-one,sk-two,sk-three') {
      throw new Error('пул разобран неверно: ' + loaded.seekai.apiKeys.join(','));
    }
    if (loaded.seekai.apiKey !== 'sk-one') throw new Error('нет совместимого apiKey');
    if (loaded.hcnsec.apiKeys.join(',') !== 'sk-legacy') throw new Error('старый API_KEY не загрузился');
    return `${loaded.seekai.apiKeys.length} ключа SeekAI + legacy`;
  } finally {
    if (oldMany === undefined) delete process.env.SEEKAI_API_KEYS;
    else process.env.SEEKAI_API_KEYS = oldMany;
    if (oldOne === undefined) delete process.env.HCNSEC_API_KEY;
    else process.env.HCNSEC_API_KEY = oldOne;
  }
});

await check('модели шлюза и клиента синхронны (через алиасы, без дублей)', () => {
  const U = GW.GATEWAY_UPSTREAMS;
  const aliases = GW.MODEL_ALIASES;
  const publicOf = Object.fromEntries(Object.entries(aliases).map(([pub, up]) => [up, pub]));

  const gwIds = Object.values(U).flatMap((u) => u.models);
  const dup = gwIds.filter((id, i) => gwIds.indexOf(id) !== i);
  if (dup.length) throw new Error('дубли между апстримами: ' + [...new Set(dup)].join(', '));

  // клиент знает только публичные имена — сверяем после перевода
  const client = new Set(PROVIDER_PRESETS.coderoom.models.map((m) => m.id));
  const missing = gwIds.map((id) => publicOf[id] ?? id).filter((id) => !client.has(id));
  if (missing.length) throw new Error('нет в /model: ' + missing.slice(0, 5).join(', '));

  // алиасы должны указывать на реально существующие модели апстримов
  const known = new Set(gwIds);
  const broken = Object.entries(aliases).filter(([, up]) => !known.has(up)).map(([p]) => p);
  if (broken.length) throw new Error('алиасы в никуда: ' + broken.join(', '));

  return `${gwIds.length} моделей, ${Object.keys(aliases).length} алиасов`;
});

await check('удалены неработающие модели', () => {
  const removed = ['nemotron-4-340b', 'yi-large', 'codegemma-1.1-7b', 'nemotron-3-nano-omni', 'nemotron-nano-3-30b', 'llama-nemotron-ultra-253b', 'sensenova-u1-fast'];
  const client = new Set(PROVIDER_PRESETS.coderoom.models.map((m) => m.id));
  const present = removed.filter((id) => client.has(id));
  if (present.length) throw new Error('остались в /model: ' + present.join(', '));

  const gwIds = new Set(Object.values(GW.GATEWAY_UPSTREAMS).flatMap((u) => u.models));
  const aliasHits = removed.filter((id) => GW.MODEL_ALIASES[id] && gwIds.has(GW.MODEL_ALIASES[id]));
  if (aliasHits.length) throw new Error('остались в алиасах/апстримах: ' + aliasHits.join(', '));

  return 'все сломанные модели удалены';
});

await check('в клиенте нет внутренних путей вендоров', () => {
  const bad = PROVIDER_PRESETS.coderoom.models.filter((m) => m.id.includes('/'));
  if (bad.length) throw new Error('утекли id: ' + bad.map((m) => m.id).slice(0, 3).join(', '));
  const text = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'config.mjs'), 'utf8');
  // имена разделов (Anthropic, Nvidia…) — это витрина, а вот апстримы клиенту знать незачем
  for (const word of ['agentrouter', 'hcnsec', 'seekai', 'bluesminds', 'integrate\\.api\\.nvidia']) {
    if (new RegExp(word, 'i').test(text)) throw new Error('упоминание в config.mjs: ' + word);
  }
  return 'публичные имена, без упоминаний апстримов';
});


await check('setProviderKey + saveConfig (права 0600)', () => {
  setProviderKey(cfg, 'coderoom', 'sk-test-1234567890abcdef');
  saveConfig(cfg);
  if (!fs.existsSync(CONFIG_FILE)) throw new Error('файл не создан');
  const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  if (!JSON.stringify(raw).includes('sk-test-1234567890abcdef')) throw new Error('ключ не записан');
  if (process.platform !== 'win32') {
    const mode = fs.statSync(CONFIG_FILE).mode & 0o777;
    if (mode !== 0o600) throw new Error('права ' + mode.toString(8));
  }
  return CONFIG_FILE;
});

await check('resolveProvider() отдаёт ключ и baseUrl', () => {
  const p = resolveProvider(cfg, 'coderoom');
  if (p.apiKey !== 'sk-test-1234567890abcdef') throw new Error('ключ не вернулся');
  if (!p.baseUrl.startsWith('http')) throw new Error('плохой baseUrl');
  return `${p.label} ${p.baseUrl} ${maskKey(p.apiKey)}`;
});

await check('провайдер coderoom дефолтный, шлюзовой', () => {
  if (cfg.provider !== 'coderoom') throw new Error('дефолт не coderoom: ' + cfg.provider);
  const p = PROVIDER_PRESETS.coderoom;
  if (!p) throw new Error('нет пресета coderoom');
  if (!p.isGateway) throw new Error('coderoom не помечен isGateway');
  if (p.keyEnv !== 'CODEROOM_KEY') throw new Error('keyEnv не CODEROOM_KEY');
  if (!p.baseUrl.startsWith('http')) throw new Error('нет baseUrl');
  return `${p.label} · ${p.baseUrl} · моделей ${p.models.length}`;
});

await check('маскировка ключа не светит секрет', () => {
  const m = maskKey('sk-D2ciYklRnGUjMmwynCtRi7uXmpZ20WW1c4WYVC3YnKrca4Eu');
  if (m.includes('YklRnGUjMmwyn')) throw new Error('ключ виден: ' + m);
  return m;
});

console.log('\n── темы ──');

const { THEMES, WEB_THEMES, THEME_NAMES, createTheme } = mods.themes;

await check('темы терминала (вкл. codex)', () => {
  if (THEME_NAMES.length < 5) throw new Error('тем: ' + THEME_NAMES.length);
  if (!THEME_NAMES.includes('codex')) throw new Error('нет темы codex');
  return THEME_NAMES.join(', ');
});

await check('5 тем браузера с CSS-переменными', () => {
  const names = Object.keys(WEB_THEMES);
  if (names.length < 5) throw new Error('тем: ' + names.length);
  for (const [id, t] of Object.entries(WEB_THEMES)) {
    for (const v of ['--bg', '--text', '--primary', '--border', '--font', '--font-mono', '--radius']) {
      if (!(v in t.vars)) throw new Error(`${id}: нет ${v}`);
    }
  }
  return names.join(', ');
});

await check('createTheme(): все методы и символы', () => {
  for (const name of THEME_NAMES) {
    const t = createTheme(name);
    for (const fn of ['primary', 'accent', 'success', 'warn', 'error', 'muted', 'text', 'bold', 'underline', 'code', 'banner']) {
      if (typeof t[fn] !== 'function') throw new Error(`${name}.${fn} не функция`);
    }
    // символы должны быть определены (у minimal часть намеренно пустая — не украшаем)
    for (const s of ['prompt', 'assistant', 'tool', 'toolDone', 'check', 'cross', 'bullet']) {
      if (!(s in t.symbols)) throw new Error(`${name}: нет символа ${s}`);
    }
    if (!Array.isArray(t.banner('0.1.0'))) throw new Error(name + ': banner не массив');
  }
  return 'ок для всех ' + THEME_NAMES.length;
});

await check('createTheme() с мусором не падает', () => {
  const t = createTheme('нет-такой-темы');
  return t.primary('fallback работает').length > 0 ? 'fallback' : '';
});

console.log('\n── рендер ──');

const { renderDiff, renderMarkdown, box, fmtNum } = mods.render;
const plain = createTheme('claude'); // NO_COLOR активен — ANSI не подмешивается

await check('renderDiff считает +/-', () => {
  const d = renderDiff('a\nb\nc\n', 'a\nB\nc\nd\n', plain, { context: 1 });
  if (d.adds !== 2 || d.dels !== 1) throw new Error(`+${d.adds} -${d.dels}, ожидалось +2 -1`);
  return `+${d.adds} -${d.dels}`;
});

await check('renderDiff на одинаковых файлах', () => {
  const d = renderDiff('same\n', 'same\n', plain);
  if (d.adds || d.dels) throw new Error('нашёл изменения там, где их нет');
  return 'пусто';
});

await check('renderMarkdown: код, списки, заголовки', () => {
  const out = renderMarkdown('# Заголовок\n\n- пункт\n- ещё\n\n```js\nconst x = 1;\n```\n\n**жирный** и `код`', plain, { width: 70 });
  if (!out.includes('Заголовок')) throw new Error('нет заголовка');
  if (!out.includes('const x = 1;')) throw new Error('нет кода');
  return out.split('\n').length + ' строк';
});

await check('box() рисует рамку', () => {
  const b = box('привет', plain, { title: 'Тест' });
  const lines = b.split('\n');
  if (lines.length < 3) throw new Error('рамка не собралась');
  return lines.length + ' строк';
});

await check('fmtNum сокращает', () => `${fmtNum(999)} / ${fmtNum(1500)} / ${fmtNum(140000)}`);

await check('visLen: широкие символы и ANSI', () => {
  const { visLen, stripAnsi } = mods.ansi;
  if (visLen('abc') !== 3) throw new Error('ascii: ' + visLen('abc'));
  if (visLen('日本') !== 4) throw new Error('CJK должен быть 4: ' + visLen('日本'));
  if (visLen('\x1b[31mred\x1b[39m') !== 3) throw new Error('ANSI не снят: ' + visLen('\x1b[31mred\x1b[39m'));
  if (stripAnsi('\x1b[1mx\x1b[22m') !== 'x') throw new Error('stripAnsi');
  return 'ascii 3 · CJK 4 · ansi 3';
});

await check('truncate не превышает ширину', () => {
  const { truncate, visLen } = mods.ansi;
  const s = truncate('очень длинная строка для обрезки', 10);
  if (visLen(s) > 10) throw new Error(`${visLen(s)} > 10: ${s}`);
  if (truncate('коротко', 20) !== 'коротко') throw new Error('обрезал короткое');
  return `"${s}"`;
});

await check('glyphs даёт ASCII-фолбэк', () => {
  const { glyphs, unicodeOK } = mods.ansi;
  const out = glyphs('✓ → │');
  if (unicodeOK) { if (out !== '✓ → │') throw new Error('юникод изменён'); return 'юникод как есть'; }
  if (/[✓→│]/.test(out)) throw new Error('не заменил: ' + out);
  return 'ASCII: ' + out;
});

await check('renderMarkdown: таблица и чек-лист', () => {
  const table = renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |', plain, { width: 60 });
  if (!/a/.test(table) || !/1/.test(table)) throw new Error('таблица не отрисовалась');
  if (table.split('\n').length < 4) throw new Error('в таблице мало строк');
  const check1 = renderMarkdown('- [x] сделано\n- [ ] нет', plain, { width: 60 });
  if (!/сделано/.test(check1) || !/нет/.test(check1)) throw new Error('чек-лист потерян');
  return 'таблица ' + table.split('\n').length + ' строк, чек-лист ок';
});

await check('StreamRenderer собирает markdown по блокам', () => {
  const chunks = [];
  const fake = { write: (s) => chunks.push(s), isTTY: false };
  const sr = new mods.render.StreamRenderer(plain, fake);
  // разметку нельзя рвать по токенам — рендер должен дождаться блока
  for (const tok of ['**жир', 'ный** текст', '\n\n', 'второй абзац']) sr.write(tok);
  sr.flush();
  const all = chunks.join('');
  if (!/жирный/.test(all)) throw new Error('разметка порвалась: ' + all.slice(0, 60));
  if (/\*\*/.test(all)) throw new Error('сырые ** попали на экран');
  if (!/второй абзац/.test(all)) throw new Error('остаток не выведен');
  return 'блоки собраны, ** не протекли';
});

await check('createInput отдаёт рабочий контракт', () => {
  const inp = mods.input.createInput({ theme: plain, commands: [{ name: 'help', desc: 'x' }] });
  for (const m of ['ask', 'notify', 'refresh', 'setCommands', 'setTheme', 'setValue']) {
    if (typeof inp[m] !== 'function') throw new Error('нет метода ' + m);
  }
  if (inp.active) throw new Error('активен до ask()');
  return 'ask/notify/refresh/setCommands/setTheme/setValue';
});

await check('select в не-TTY отказывает, а не подтверждает', async () => {
  // Признак TTY подменяем принудительно: иначе в настоящем терминале тест
  // открыл бы живое меню и завис, ожидая нажатия клавиши.
  const realTTY = process.stdout.isTTY;
  process.stdout.isTTY = false;
  try {
    const one = await mods.select.select({ title: 'x', options: [{ label: 'Разрешить' }, { label: 'Отклонить' }], theme: plain });
    if (one !== -1) throw new Error('одиночный выбор вернул ' + one + ' (ждём -1)');
    const many = await mods.select.select({ title: 'x', multi: true, options: [{ label: 'a' }], theme: plain });
    if (many !== null) throw new Error('множественный вернул ' + JSON.stringify(many));
    const ok = await mods.select.confirmSelect({ title: 'удалить всё?', theme: plain });
    if (ok !== false) throw new Error('confirmSelect подтвердил без TTY');
    return 'отказ по умолчанию';
  } finally {
    process.stdout.isTTY = realTTY;
  }
});

await check('screen.claim передаёт и возвращает владение', () => {
  const { claim, notify, hasOwner } = mods.screen;
  const seen = [];
  const release1 = claim({ notify: (t) => seen.push('a:' + t) });
  const release2 = claim({ notify: (t) => seen.push('b:' + t) });
  notify('раз');
  release2();
  notify('два');
  release1();
  if (hasOwner()) throw new Error('владелец не освободился');
  if (seen.join(',') !== 'b:раз,a:два') throw new Error('порядок: ' + seen.join(','));
  return seen.join(' · ');
});

console.log('\n── права доступа ──');

const work = path.join(tmp, 'work');
fs.mkdirSync(work, { recursive: true });

const { MODES, PermissionEngine, safeResolve, checkDangerous } = mods.permissions;
const { toolByName, toolSchemas, ALL_TOOLS } = mods.tools;

/** Решение движка прав для (режим, инструмент, аргументы). */
function decide(mode, name, args) {
  const eng = new PermissionEngine({ ...cfg, permissions: { ...cfg.permissions, mode } });
  return eng.check(name, args, toolByName(name));
}

await check('режимы: default/acceptEdits/plan/yolo', () => {
  for (const m of ['default', 'acceptEdits', 'plan', 'yolo']) {
    if (!MODES[m]) throw new Error('нет режима ' + m);
    if (!MODES[m].hint) throw new Error(m + ': нет описания');
  }
  return Object.keys(MODES).join(', ');
});

await check('plan запрещает запись', () => {
  const d = decide('plan', 'Write', { path: 'a.txt', content: 'x' });
  if (d.decision !== 'deny') throw new Error('решение: ' + d.decision);
  return 'запрещено: ' + (d.reason ?? '').slice(0, 50);
});

await check('plan разрешает чтение', () => {
  const d = decide('plan', 'Read', { path: 'a.txt' });
  if (d.decision !== 'allow') throw new Error('запретил чтение: ' + d.reason);
  return 'разрешено';
});

await check('опасные команды требуют подтверждения даже в acceptEdits', () => {
  const d = decide('acceptEdits', 'Bash', { command: 'rm -rf /' });
  if (d.decision !== 'ask') throw new Error('пропустил rm -rf: ' + d.decision);
  if (!checkDangerous('rm -rf /')) throw new Error('checkDangerous не распознал rm -rf');
  return 'ловится: ' + d.danger;
});

await check('«больше не спрашивать» превращается в правило и работает после', () => {
  const { PermissionEngine, ruleFor } = mods.permissions;
  const local = structuredClone(cfg);
  local.permissions.mode = 'default';
  const eng = new PermissionEngine(local);

  const args = { command: 'npm run build' };
  if (eng.check('Bash', args, toolByName('Bash')).decision !== 'ask') throw new Error('сразу разрешил');

  const rule = eng.allowForever('Bash', args);
  if (rule !== 'Bash(npm run *)') throw new Error('правило: ' + rule);
  if (!local.permissions.allow.includes(rule)) throw new Error('правило не сохранилось в конфиг');

  // новый движок = новый запуск: правило должно продолжать действовать
  const fresh = new PermissionEngine(local);
  if (fresh.check('Bash', { command: 'npm run test' }, toolByName('Bash')).decision !== 'allow') {
    throw new Error('после перезапуска снова спрашивает');
  }
  if (fresh.check('Bash', { command: 'git push --force' }, toolByName('Bash')).decision !== 'ask') {
    throw new Error('правило разрешило лишнее');
  }
  if (ruleFor('Write', { path: 'src/a.js' }) !== 'Write(**)') throw new Error('правило для Write');
  return rule;
});

await check('выход за пределы рабочей папки блокируется', () => {
  try {
    safeResolve(work, '../../../../etc/passwd', cfg);
    throw new Error('дал путь вне песочницы');
  } catch (e) {
    if (!/вне рабочей|песочниц/i.test(e.message)) throw new Error('невнятно: ' + e.message);
    return 'блокируется';
  }
});

console.log('\n── инструменты ──');

/** Единый вызов инструмента: нормализуем результат/ошибку к { output, error }. */
async function runTool(name, args, ctx) {
  const tool = toolByName(name);
  if (!tool) return { error: true, output: `инструмента «${name}» нет` };
  try {
    const r = await tool.run(args, ctx);
    return { output: r.output ?? '', meta: r.meta };
  } catch (e) {
    return { error: true, output: e.message };
  }
}

await check('схемы инструментов валидны', () => {
  const schemas = toolSchemas(ALL_TOOLS);
  if (!schemas.length) throw new Error('пусто');
  for (const s of schemas) {
    if (!s.name || !s.description) throw new Error('нет name/description: ' + JSON.stringify(s).slice(0, 60));
    if (!s.schema || s.schema.type !== 'object') throw new Error(s.name + ': нет schema.type=object');
  }
  return schemas.map((s) => s.name).join(', ');
});

const ctx = { cwd: work, cfg, session: new mods.session.Session({ cwd: work, model: cfg.model }) };

await check('Write создаёт файл', async () => {
  const r = await runTool('Write', { path: 'hello.js', content: 'export const hi = 1;\n' }, ctx);
  if (r.error) throw new Error(r.output);
  const onDisk = fs.readFileSync(path.join(work, 'hello.js'), 'utf8');
  if (!onDisk.includes('hi = 1')) throw new Error('файл пустой');
  return r.output.slice(0, 60);
});

await check('Read читает с номерами строк', async () => {
  const r = await runTool('Read', { path: 'hello.js' }, ctx);
  if (r.error) throw new Error(r.output);
  if (!r.output.includes('hi = 1')) throw new Error('не прочитал');
  if (!/\d+\s*\|/.test(r.output)) throw new Error('нет номеров строк');
  return r.output.split('\n')[0].slice(0, 60);
});

await check('Read несуществующего файла даёт понятную ошибку', async () => {
  const r = await runTool('Read', { path: 'нет-такого.txt' }, ctx);
  if (!r.error) throw new Error('не сообщил об ошибке');
  return r.output.split('\n')[0].slice(0, 70);
});

await check('Edit заменяет строку', async () => {
  const r = await runTool('Edit', { path: 'hello.js', old_string: 'hi = 1', new_string: 'hi = 42' }, ctx);
  if (r.error) throw new Error(r.output);
  if (!fs.readFileSync(path.join(work, 'hello.js'), 'utf8').includes('hi = 42')) throw new Error('не заменил');
  return 'ок';
});

await check('Edit с неуникальным совпадением не портит файл', async () => {
  fs.writeFileSync(path.join(work, 'dup.txt'), 'x\nx\n');
  const r = await runTool('Edit', { path: 'dup.txt', old_string: 'x', new_string: 'y' }, ctx);
  if (!r.error) throw new Error('заменил вслепую при 2 совпадениях');
  if (fs.readFileSync(path.join(work, 'dup.txt'), 'utf8') !== 'x\nx\n') throw new Error('файл всё-таки изменён');
  return r.output.split('\n')[0].slice(0, 70);
});

await check('Glob находит файлы', async () => {
  const r = await runTool('Glob', { pattern: '**/*.js' }, ctx);
  if (r.error) throw new Error(r.output);
  if (!r.output.includes('hello.js')) throw new Error('не нашёл hello.js');
  return r.output.split('\n').slice(0, 2).join(' | ').slice(0, 70);
});

await check('Grep ищет по содержимому', async () => {
  const r = await runTool('Grep', { pattern: 'hi = 42' }, ctx);
  if (r.error) throw new Error(r.output);
  if (!r.output.includes('hello.js')) throw new Error('не нашёл совпадение');
  return r.output.split('\n')[0].slice(0, 70);
});

await check('List показывает содержимое папки', async () => {
  const r = await runTool('List', { path: '.' }, ctx);
  if (r.error) throw new Error(r.output);
  return r.output.split('\n').length + ' строк';
});

await check('Bash выполняет команду', async () => {
  const r = await runTool('Bash', { command: 'node -e "console.log(2+2)"', description: 'арифметика' }, ctx);
  if (r.error) throw new Error(r.output);
  if (!r.output.includes('4')) throw new Error('нет вывода: ' + r.output.slice(0, 80));
  return '2+2=4';
});

await check('Bash сообщает о ненулевом коде возврата', async () => {
  // PowerShell -Command не пробрасывает точный код дочернего процесса, поэтому
  // проверяем сам факт ненулевого кода (кросс-платформенно), а не конкретное число.
  const r = await runTool('Bash', { command: 'node -e "process.exit(3)"' }, ctx);
  if (!/Код возврата:\s*[1-9]\d*/.test(r.output)) throw new Error('не показал ненулевой код: ' + r.output.slice(0, 80));
  return r.output.split('\n')[0];
});

await check('Todo сохраняет план в сессию', async () => {
  const r = await runTool('Todo', { todos: [{ content: 'первый шаг', status: 'in_progress' }, { content: 'второй', status: 'pending' }] }, ctx);
  if (r.error) throw new Error(r.output);
  if (ctx.session.todos?.length !== 2) throw new Error('план не записался');
  return '2 пункта';
});

await check('неизвестный инструмент не роняет процесс', async () => {
  const r = await runTool('НетТакого', {}, ctx);
  if (!r.error) throw new Error('должен быть error');
  return r.output.slice(0, 60);
});

console.log('\n── SSH ──');

const SSH = mods.ssh;

await check('parseTarget разбирает user@host:port', () => {
  const a = SSH.parseTarget('root@10.0.0.5');
  if (a.user !== 'root' || a.host !== '10.0.0.5' || a.port !== 22) throw new Error(JSON.stringify(a));
  const b = SSH.parseTarget('deploy@example.com:2222');
  if (b.user !== 'deploy' || b.port !== 2222) throw new Error(JSON.stringify(b));
  const c = SSH.parseTarget('ssh://[::1]:2200');
  if (c.host !== '::1' || c.port !== 2200) throw new Error('IPv6: ' + JSON.stringify(c));
  for (const bad of ['', 'host:99999']) {
    let threw = false;
    try { SSH.parseTarget(bad); } catch { threw = true; }
    if (!threw) throw new Error('принял мусор: ' + JSON.stringify(bad));
  }
  return 'user@host, порт, IPv6, отказ на мусоре';
});

await check('addHost/listHosts/removeHost сохраняются в конфиг', () => {
  const c = loadConfig();
  const h = SSH.addHost(c, { name: 'prod', host: '10.0.0.5', user: 'deploy', port: 2222 });
  if (h.port !== 2222 || h.keyInstalled !== false) throw new Error('поля: ' + JSON.stringify(h));

  const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  if (!saved.hosts?.prod) throw new Error('в конфиг не записался');

  // перечитали с диска — сервер должен быть на месте
  if (!SSH.getHost(loadConfig(), 'prod')) throw new Error('после перезагрузки пропал');

  let threw = false;
  try { SSH.addHost(c, { name: 'плохое имя!', host: 'x' }); } catch { threw = true; }
  if (!threw) throw new Error('принял недопустимое имя');

  SSH.markOk(c, 'prod');
  if (!SSH.getHost(c, 'prod').keyInstalled) throw new Error('markOk не сработал');

  if (!SSH.removeHost(c, 'prod')) throw new Error('не удалился');
  if (SSH.removeHost(c, 'prod')) throw new Error('удалил дважды');
  if (SSH.listHosts(loadConfig()).length) throw new Error('остался в конфиге');
  return 'добавление, сохранение, markOk, удаление';
});

await check('ключ CodeRoom отдельный от ~/.ssh и внутри CODEROOM_HOME', () => {
  const home = process.env.CODEROOM_HOME;
  if (!SSH.KEY_FILE.startsWith(home)) throw new Error('ключ вне CODEROOM_HOME: ' + SSH.KEY_FILE);
  if (!SSH.KNOWN_HOSTS.startsWith(home)) throw new Error('known_hosts вне CODEROOM_HOME');
  if (/[\\/]\.ssh[\\/]id_(rsa|ed25519)$/.test(SSH.KEY_FILE.replace(home, ''))) throw new Error('лезет в личный ~/.ssh');
  return path.relative(home, SSH.KEY_FILE).replace(/\\/g, '/');
});

const SSH_SRC = path.join(import.meta.dirname, '..', 'src', 'ssh.mjs');

await check('probe: скрипт валиден для sh (цикл for не склеен через «;»)', () => {
  // ловим регресс: строки, склеенные через «; », давали «do; printf» — ошибка синтаксиса bash
  const src = fs.readFileSync(SSH_SRC, 'utf8');
  const body = src.slice(src.indexOf('export async function probe'));
  const join = /\]\.join\((['"])(.*?)\1\)/.exec(body);
  if (!join) throw new Error('не нашёл склейку строк скрипта probe');
  if (join[2] !== '\\n') throw new Error('строки скрипта склеены через «' + join[2] + '», нужен перевод строки');
  if (/\bdo\s*;/.test(body)) throw new Error('в скрипте есть «do;» — sh такое не примет');
  return 'join("\\n"), «do;» нет';
});

await check('useKey привязывает свой ключ и отсекает .pub', () => {
  const c = loadConfig();
  SSH.addHost(c, { name: 'own', host: '10.0.0.7', user: 'deploy' });

  const keyFile = path.join(process.env.CODEROOM_HOME, 'my_key');
  fs.writeFileSync(keyFile, 'PRIVATE', 'utf8');
  fs.writeFileSync(keyFile + '.pub', 'ssh-ed25519 AAAA test', 'utf8');

  const h = SSH.useKey(c, 'own', keyFile);
  if (h.keyFile !== keyFile) throw new Error('ключ не сохранился: ' + h.keyFile);
  if (loadConfig().hosts.own.keyFile !== keyFile) throw new Error('ключ не попал в конфиг');

  let pubRejected = false;
  try { SSH.useKey(c, 'own', keyFile + '.pub'); } catch { pubRejected = true; }
  if (!pubRejected) throw new Error('.pub принят, а нужен приватный ключ');

  let missingRejected = false;
  try { SSH.useKey(c, 'own', keyFile + '-нет'); } catch { missingRejected = true; }
  if (!missingRejected) throw new Error('несуществующий файл принят');

  SSH.removeHost(c, 'own');
  return 'привязка, отказ на .pub и на отсутствующий файл';
});

await check('checkKeyAuth проверяет только наш ключ (не чужой из агента)', () => {
  // без keyOnly вход мог пройти по постороннему ключу — и «настроено» было бы ложью
  const src = fs.readFileSync(SSH_SRC, 'utf8');
  const fn = src.slice(src.indexOf('export async function checkKeyAuth'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  if (!/keyOnly:\s*true/.test(body)) throw new Error('checkKeyAuth ходит без keyOnly');

  const install = src.slice(src.indexOf('export async function installKey'));
  if (!/chmod go-w ~/.test(install)) throw new Error('installKey не правит права на ~ (StrictModes)');
  return 'keyOnly + chmod go-w ~';
});

await check('Ssh: список серверов и понятная ошибка на неизвестный', async () => {
  const c = loadConfig();
  const empty = await runTool('Ssh', { action: 'list' }, { ...ctx, cfg: c });
  if (empty.error) throw new Error(empty.output);
  if (!/Серверов нет/.test(empty.output)) throw new Error('пустой список: ' + empty.output.slice(0, 60));

  SSH.addHost(c, { name: 'srv1', host: '10.0.0.9', user: 'root' });
  const list = await runTool('Ssh', { action: 'list' }, { ...ctx, cfg: c });
  if (!/srv1.*root@10\.0\.0\.9/s.test(list.output)) throw new Error('нет сервера: ' + list.output);

  const miss = await runTool('Ssh', { host: 'нетtakого', command: 'ls' }, { ...ctx, cfg: c });
  if (!miss.error || !/нет/i.test(miss.output)) throw new Error('невнятно: ' + miss.output);

  SSH.removeHost(c, 'srv1');
  return 'list + ошибка на неизвестный сервер';
});

await check('Ssh требует подтверждения и описывается в UI', () => {
  const tool = toolByName('Ssh');
  if (!tool.requiresExplicitApproval) throw new Error('выполняется без спроса');
  if (!tool.mutating) throw new Error('не помечен mutating');
  if (!mods.config.DEFAULT_CONFIG.permissions.ask.includes('Ssh(**)')) {
    throw new Error('Ssh(**) нет в permissions.ask по умолчанию');
  }
  const d = mods.tools.describeCall('Ssh', { host: 'prod', command: 'systemctl restart api' });
  if (!/prod/.test(d)) throw new Error('describeCall без сервера: ' + d);
  return d;
});

console.log('\n── плагины и скилы ──');

const { loadPlugins, expandCommand, skillsSummary } = mods.plugins;

await check('плагины: команды и скилы грузятся', () => {
  const { commands, skills, plugins } = loadPlugins({ cwd: work, reload: true });
  if (plugins.size < 5) throw new Error('плагинов мало: ' + plugins.size);
  if (!commands.has('commit')) throw new Error('нет команды commit');
  if (!skills.has('frontend-design')) throw new Error('нет скила frontend-design');
  return `плагинов ${plugins.size}, команд ${commands.size}, скилов ${skills.size}`;
});

await check('доменные скилы на месте (frontend/backend/…)', () => {
  const { skills } = loadPlugins({ cwd: work });
  for (const need of ['frontend-design', 'backend', 'testing', 'debugging', 'security', 'database', 'refactoring', 'performance', 'devops']) {
    if (!skills.has(need)) throw new Error('нет скила ' + need);
    if (!skills.get(need).description) throw new Error(need + ' без описания');
  }
  return '9 доменных скилов';
});

await check('инструмент Skill возвращает тело навыка', async () => {
  const r = await runTool('Skill', { name: 'frontend-design' }, ctx);
  if (r.error) throw new Error(r.output);
  if (!/frontend|дизайн|design/i.test(r.output)) throw new Error('пусто: ' + r.output.slice(0, 60));
  return r.output.length + ' символов';
});

await check('expandCommand подставляет $ARGUMENTS и $1', () => {
  const out = expandCommand({ body: 'Задача: $ARGUMENTS. Первый: $1', plugin: 'x', name: 'y' }, 'привет мир', { cwd: work });
  if (!out.includes('привет мир')) throw new Error('нет $ARGUMENTS: ' + out);
  if (!/Первый: привет/.test(out)) throw new Error('нет $1: ' + out);
  return 'ок';
});

await check('системный промпт содержит навыки и Skill', () => {
  const sp = mods.agent.buildSystemPrompt({ cwd: work, mode: 'default' });
  if (!/frontend-design/.test(sp)) throw new Error('нет frontend-design в промпте');
  if (!/Skill\(/.test(sp)) throw new Error('нет упоминания Skill()');
  return skillsSummary({ cwd: work }).split('\n').length + ' навыков в промпте';
});

console.log('\n── обновления ──');

const UP = mods['update-checker'];

await check('сравнение версий и тип обновления', () => {
  if (UP.compareVersions('1.2.3', '1.2.4') !== -1) throw new Error('1.2.3 < 1.2.4');
  if (UP.compareVersions('2.0.0', '1.9.9') !== 1) throw new Error('2.0.0 > 1.9.9');
  if (UP.compareVersions('1.0.0', '1.0.0') !== 0) throw new Error('равные');
  if (UP.compareVersions('1.0.0-beta.1', '1.0.0') !== -1) throw new Error('пререлиз старше релиза');
  if (UP.updateKind('1.0.0', '2.0.0') !== 'major') throw new Error('major');
  if (UP.updateKind('1.0.0', '1.1.0') !== 'minor') throw new Error('minor');
  if (UP.updateKind('1.0.0', '1.0.1') !== 'patch') throw new Error('patch');
  if (UP.updateKind('1.0.1', '1.0.0') !== 'none') throw new Error('откат не обновление');
  return 'major/minor/patch/none';
});

await check('команда обновления зависит от способа установки', () => {
  const g = UP.updateCommand({ manager: 'npm', global: true }, '2.0.0');
  if (g.cmd !== 'npm' || !g.args.includes('-g')) throw new Error('глобальная: ' + g.text);
  if (!g.text.includes('coderoom-cli@2.0.0')) throw new Error('нет версии: ' + g.text);
  const l = UP.updateCommand({ manager: 'npm', local: true }, 'latest');
  if (l.args.includes('-g')) throw new Error('локальной подсунули -g');
  const p = UP.updateCommand({ manager: 'pnpm' }, 'latest');
  if (p.cmd !== 'pnpm') throw new Error('pnpm: ' + p.text);
  const npx = UP.updateCommand({ viaNpx: true }, 'latest');
  if (npx.cmd !== null) throw new Error('для npx ставить нечего');
  return `${g.text} · ${p.text}`;
});

await check('проверка обновлений ходит в реестр и уважает решения', async () => {
  const http = await import('node:http');
  const registry = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ version: '99.0.0' }));
  });
  await new Promise((r) => registry.listen(0, '127.0.0.1', r));
  process.env.CODEROOM_REGISTRY = `http://127.0.0.1:${registry.address().port}`;

  try {
    const c = { ...cfg, update: { check: true, intervalHours: 24 } };
    const res = await UP.checkForUpdates({ cfg: c, force: true });
    if (!res.updateAvailable || res.latestVersion !== '99.0.0') throw new Error('не увидел версию: ' + JSON.stringify(res));
    if (!UP.shouldPrompt(res, c)) throw new Error('не предложил обновиться');

    // «позже» — сутки молчим
    UP.snoozeUpdate(24);
    if (UP.shouldPrompt(res, c)) throw new Error('спрашивает после «позже»');
    UP.resetUpdateSnooze();

    // «пропустить версию» — про неё больше ни слова
    const skipped = await UP.checkForUpdates({ cfg: { ...c, update: { ...c.update, skipVersion: '99.0.0' } }, force: true });
    if (UP.shouldPrompt(skipped, { update: { skipVersion: '99.0.0' } })) throw new Error('спрашивает про пропущенную');

    // проверка выключена — в сеть не ходим
    const off = await UP.checkForUpdates({ cfg: { ...c, update: { check: false } } });
    if (UP.shouldPrompt(off, { update: { check: false } })) throw new Error('спрашивает при выключенной проверке');

    // кэш: второй заход без force не должен дёргать сеть
    registry.close();
    const cached = await UP.checkForUpdates({ cfg: c });
    if (cached.latestVersion !== '99.0.0' || !cached.fromCache) throw new Error('кэш не сработал');
    return `${res.currentVersion} → 99.0.0 (${res.kind}), кэш и «позже» работают`;
  } finally {
    delete process.env.CODEROOM_REGISTRY;
    try { registry.close(); } catch { /* уже закрыт */ }
  }
});

await check('недоступный реестр не роняет проверку', async () => {
  process.env.CODEROOM_REGISTRY = 'http://127.0.0.1:1';
  try {
    const res = await UP.checkForUpdates({ cfg: { update: { check: true, intervalHours: 0 } }, force: true });
    if (res.updateAvailable && !res.fromCache) throw new Error('придумал обновление');
    return res.error ? 'ошибка обработана' : 'ответ из кэша';
  } finally {
    delete process.env.CODEROOM_REGISTRY;
  }
});

await check('настройки обновлений сохраняются в конфиг', () => {
  const c = loadConfig();
  UP.setAutoInstall(c, true);
  UP.skipVersion(c, '9.9.9');
  const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  if (saved.update?.autoInstall !== true) throw new Error('autoInstall не записан');
  if (saved.update?.skipVersion !== '9.9.9') throw new Error('skipVersion не записан');
  UP.setUpdateCheck(c, true);
  c.update.autoInstall = false;
  c.update.skipVersion = null;
  saveConfig(c);
  return 'autoInstall / skipVersion / check';
});

console.log('\n── сессии ──');

const { Session } = mods.session;

await check('сессия сохраняется и читается', () => {
  const s = new Session({ cwd: work, model: cfg.model, provider: 'coderoom' });

  s.messages.push({ role: 'user', content: 'проверка записи' });
  s.messages.push({ role: 'assistant', content: 'ответ' });
  const file = s.save();
  const loaded = Session.load(file);
  if (loaded.messages.length !== 2) throw new Error('сообщения потерялись');
  if (loaded.id !== s.id) throw new Error('id не совпал');
  return `${loaded.id} · ${loaded.messages.length} сообщений`;
});

await check('Session.list и Session.latest находят сессию', () => {
  const list = Session.list(work, 5);
  if (!list.length) throw new Error('список пуст');
  const latest = Session.latest(work);
  if (!latest) throw new Error('latest не нашёл');
  return `${list.length} в списке, последняя ${latest.id}`;
});

await check('заголовок сессии берётся из первого сообщения', () => {
  const s = new Session({ cwd: work, model: cfg.model });
  s.addUser('проверка заголовка из первого сообщения');
  if (!s.title || !s.title.includes('проверка')) throw new Error('заголовок: ' + s.title);
  return s.title.slice(0, 40);
});

console.log('\n── провайдер ──');

const { Provider, estimateTokens } = mods.provider;

await check('estimateTokens растёт с длиной', () => {
  const a = estimateTokens([{ role: 'user', content: 'коротко' }]);
  const b = estimateTokens([{ role: 'user', content: 'слово '.repeat(500) }]);
  if (!(b > a && a > 0)) throw new Error(`${a} vs ${b}`);
  return `${a} → ${b}`;
});

await check('estimateTokens переживает tool_calls и пустой content', () => {
  const n = estimateTokens([
    { role: 'assistant', content: null, tool_calls: [{ function: { name: 'Read', arguments: '{"path":"a"}' } }] },
    { role: 'tool', content: 'результат' },
  ]);
  if (!(n > 0)) throw new Error('вернул ' + n);
  return String(n);
});

await check('Provider ставит обязательный User-Agent и Authorization', () => {
  const p = new Provider(cfg, 'coderoom');
  const h = p.headers();
  const ua = h['User-Agent'] ?? h['user-agent'];
  if (!ua) throw new Error('нет User-Agent');
  if (!String(h.Authorization ?? h.authorization).includes('sk-test')) throw new Error('нет Authorization');
  return ua;
});

await check('Provider без ключа падает с понятным текстом (без сети)', async () => {
  const empty = structuredClone(cfg);
  empty.providers.coderoom.apiKey = '';
  const p = new Provider(empty, 'coderoom');
  try {
    for await (const _ev of p.stream({ model: 'claude-opus-4-7', messages: [{ role: 'user', content: 'привет' }], maxTokens: 8 })) {

      throw new Error('запрос ушёл без ключа');
    }
    throw new Error('поток завершился без ошибки');
  } catch (e) {
    if (/ключ|key/i.test(e.message)) return e.message.slice(0, 60);
    throw new Error('невнятная ошибка: ' + e.message);
  }
});

console.log('\n── веб-клиент ──');

await check('clientHtml() собирает страницу со всеми темами', () => {
  const html = mods['web-client'].clientHtml({
    token: 'тест-токен', cfg, cwd: work, themes: WEB_THEMES, modes: MODES,
  });
  if (!html.startsWith('<!DOCTYPE html>')) throw new Error('не html');
  for (const id of Object.keys(WEB_THEMES)) {
    if (!html.includes(`[data-theme="${id}"]`)) throw new Error('нет темы ' + id);
  }
  for (const need of ['EventSource', '/api/message', '/api/confirm', 'id="feed"', 'id="input"']) {
    if (!html.includes(need)) throw new Error('нет ' + need);
  }
  const openTags = (html.match(/<script/g) || []).length;
  const closeTags = (html.match(/<\/script>/g) || []).length;
  if (openTags !== closeTags) throw new Error('script-теги не сбалансированы');
  return Math.round(html.length / 1024) + ' КБ, тем: ' + Object.keys(WEB_THEMES).length;
});

console.log('\n── веб-сервер ──');

await check('поднимается на 127.0.0.1 и требует токен', async () => {
  const { startWebServer } = mods.web;
  const srv = await startWebServer({ cfg: { ...cfg, web: { ...cfg.web, autoOpen: false } }, cwd: work, port: 0 });
  try {
    const u = new URL(srv.url);
    if (u.hostname !== '127.0.0.1') throw new Error('слушает не локалхост: ' + u.hostname);
    if (!u.searchParams.get('token')) throw new Error('нет токена в ссылке');

    const denied = await fetch(`http://127.0.0.1:${u.port}/api/state`);
    if (denied.status !== 403) throw new Error('без токена отдал ' + denied.status);

    const allowed = await fetch(`http://127.0.0.1:${u.port}/api/state?token=${srv.token}`);
    const state = await allowed.json();
    if (state.model !== cfg.model) throw new Error('состояние не то: ' + JSON.stringify(state).slice(0, 80));
    if (!Array.isArray(state.themes) || state.themes.length < 5) throw new Error('темы не отдались');

    const page = await fetch(srv.url);
    if (page.status !== 200) throw new Error('страница: ' + page.status);

    return `порт ${u.port}, без токена 403, с токеном 200`;
  } finally {
    srv.close();
  }
});

console.log('\n── шлюз (server/) ──');

const { startGateway, createKey, listKeys, revokeKey, loadDotenv } = GW;

await check('loadDotenv читает .env и не перезатирает окружение', () => {
  const envPath = path.join(tmp, 'test.env');
  process.env.CR_KEEP = 'original';
  fs.writeFileSync(envPath, '# коммент\nCR_TEST_TOKEN = "sk-from-env"\nCR_KEEP=должно-остаться\nмусор без равно\n');
  if (!loadDotenv(envPath)) throw new Error('не прочитал .env');
  if (process.env.CR_TEST_TOKEN !== 'sk-from-env') throw new Error('не распарсил: ' + process.env.CR_TEST_TOKEN);
  if (process.env.CR_KEEP !== 'original') throw new Error('перезатёр существующую переменную');
  delete process.env.CR_TEST_TOKEN; delete process.env.CR_KEEP;
  return 'CR_TEST_TOKEN=sk-from-env, окружение не тронуто';
});

await check('хранилище — файл БД, а не json', () => {
  const st = GW.store();
  if (!/\.db$/.test(st.file)) throw new Error('не файл БД: ' + st.file);
  if (GW.sqliteAvailable && st.kind !== 'sqlite') throw new Error('sqlite есть, но тип: ' + st.kind);
  if (!fs.existsSync(st.file)) throw new Error('файл не создан: ' + st.file);
  return `${path.basename(st.file)} (${st.kind})`;
});

await check('миграция старого keys.json в БД', async () => {
  const dir = path.join(tmp, 'migr');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'keys.json'), JSON.stringify({
    keys: [{
      id: 'ab12', key: 'cr-legacy-key', label: 'старый', limitTokens: 500, disabled: false,
      createdAt: '2026-01-01T00:00:00.000Z', used: { requests: 3, input: 40, output: 60 },
    }],
  }));
  const { openStore } = await import('../server/db.mjs');
  const s = openStore(dir);
  try {
    const k = s.listKeys().find((x) => x.id === 'ab12');
    if (!k) throw new Error('ключ не перенёсся');
    if (k.label !== 'старый' || k.limitTokens !== 500) throw new Error('поля потеряны: ' + JSON.stringify(k));
    if (k.used.requests !== 3 || k.used.input !== 40) throw new Error('расход потерян: ' + JSON.stringify(k.used));
    if (!fs.existsSync(path.join(dir, 'keys.json.migrated'))) throw new Error('старый файл не помечен');
    return 'ключ + расход перенесены, keys.json → .migrated';
  } finally { s.close(); }
});

await check('БД считает статистику по моделям и переживает переоткрытие', async () => {
  const dir = path.join(tmp, 'stats');
  const { openStore } = await import('../server/db.mjs');
  let s = openStore(dir);
  const k = s.createKey({ label: 'st' });
  s.recordUsage(k.id, { input: 10, output: 20 }, { model: 'nvidia/x', upstream: 'nvidia' });
  s.recordUsage(k.id, { input: 5, output: 5 }, { model: 'nvidia/x', upstream: 'nvidia' });
  s.recordUsage(k.id, { input: 1, output: 1 }, { model: 'auto', upstream: 'hcnsec' });
  s.close();

  s = openStore(dir); // переоткрытие: данные должны быть на диске
  try {
    const rec = s.listKeys().find((x) => x.id === k.id);
    if (rec.used.requests !== 3 || rec.used.input !== 16) throw new Error('учёт: ' + JSON.stringify(rec.used));
    const st = s.stats({ top: 5 });
    const top = st.byModel[0];
    if (top.model !== 'nvidia/x' || top.requests !== 2) throw new Error('топ моделей: ' + JSON.stringify(st.byModel));
    if (st.requests !== 3) throw new Error('всего запросов: ' + st.requests);
    return `3 запроса, топ ${top.model} (${top.requests})`;
  } finally { s.close(); }
});

await check('createKey/listKeys/revokeKey — жизненный цикл', () => {
  const before = listKeys().length;
  const rec = createKey({ label: 'тест', limitTokens: 1000 });
  if (!rec.key.startsWith('cr-')) throw new Error('ключ не cr-…: ' + rec.key);
  if (rec.limitTokens !== 1000) throw new Error('лимит не записался');
  if (listKeys().length !== before + 1) throw new Error('ключ не добавился');
  const removed = revokeKey(rec.id);
  if (removed !== 1) throw new Error('не удалился');
  if (listKeys().length !== before) throw new Error('счётчик не вернулся');
  return 'cr-…' + rec.key.slice(-6) + ' создан и удалён';
});

await check('шлюз: /health, 401 без ключа, 200 с ключом', async () => {
  const srv = await startGateway({ port: 0, host: '127.0.0.1' });
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    const health = await (await fetch(base + '/health')).json();
    if (!health.ok) throw new Error('health не ok');

    const noKey = await fetch(base + '/v1/models');
    if (noKey.status !== 401) throw new Error('без ключа отдал ' + noKey.status);

    const rec = createKey({ label: 'srvtest' });
    const withKey = await fetch(base + '/v1/models', { headers: { Authorization: 'Bearer ' + rec.key } });
    if (withKey.status !== 200) throw new Error('с ключом отдал ' + withKey.status);
    const data = await withKey.json();
    if (!Array.isArray(data.data)) throw new Error('нет data[]');

    const bad = await fetch(base + '/v1/models', { headers: { Authorization: 'Bearer cr-invalid-key-xyz' } });
    if (bad.status !== 401) throw new Error('неверный ключ отдал ' + bad.status);

    revokeKey(rec.id);
    return `порт ${srv.port}, health ok, 401/200/401`;
  } finally {
    srv.close();
  }
});

console.log('\n── логи чатов ──');

await check('шлюз пишет переписку в лог и умеет искать', () => {
  const rec = createKey({ label: 'логи' });
  const st = GW.store();
  st.logChat({
    keyId: rec.id, keyLabel: 'логи', model: 'claude-opus-5', upstream: 'agentrouter',
    status: 200, ms: 1200, tokens: { input: 100, output: 250 }, ip: '127.0.0.1',
    prompt: 'почини сборку', reply: 'готово, поправил пути',
    messages: [{ role: 'user', content: 'почини сборку' }, { role: 'assistant', content: 'готово' }],
  });

  const list = GW.listChats({ limit: 5 });
  if (!list.length) throw new Error('чат не записался');
  const one = GW.getChat(list[0].id);
  if (one.prompt !== 'почини сборку') throw new Error('запрос потерян: ' + one.prompt);
  if (one.reply !== 'готово, поправил пути') throw new Error('ответ потерян');
  if (!Array.isArray(one.messages) || one.messages.length !== 2) throw new Error('переписка не сохранилась');
  if (!GW.listChats({ q: 'сборку' }).length) throw new Error('поиск не находит');
  if (GW.listChats({ q: 'такого-точно-нет' }).length) throw new Error('поиск находит лишнее');

  const n = GW.deleteChats({ id: one.id });
  if (n !== 1) throw new Error('не удалился');
  GW.revokeKey(rec.id);
  return 'запись, чтение, поиск, удаление';
});

await check('длинные тексты обрезаются, база не пухнет', () => {
  const rec = createKey({ label: 'обрезка' });
  GW.store().logChat({
    keyId: rec.id, model: 'auto', upstream: 'hcnsec', status: 200,
    prompt: 'п'.repeat(50_000), reply: 'о'.repeat(50_000),
    messages: [{ role: 'user', content: 'м'.repeat(50_000) }],
  });
  const c = GW.listChats({ limit: 1 })[0];
  const full = GW.getChat(c.id);
  if (full.prompt.length > 4200) throw new Error('запрос не обрезан: ' + full.prompt.length);
  if (full.reply.length > 8200) throw new Error('ответ не обрезан: ' + full.reply.length);
  if (full.messages[0].content.length > 1600) throw new Error('сообщение не обрезано');
  GW.deleteChats({ id: c.id });
  GW.revokeKey(rec.id);
  return `запрос ${full.prompt.length}, ответ ${full.reply.length} символов`;
});

await check('сквозь шлюз: запрос и ответ попадают в лог', async () => {
  const http = await import('node:http');

  /* фальшивый апстрим: отдаёт SSE-поток как настоящий */
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
    chunk({ choices: [{ delta: { content: 'Привет' } }] });
    chunk({ choices: [{ delta: { content: ', это ответ' } }] });
    chunk({ choices: [{ delta: {} }], usage: { prompt_tokens: 33, completion_tokens: 7 } });
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));

  const upFile = path.join(process.env.CODEROOM_GATEWAY_DATA, 'upstreams.json');
  fs.writeFileSync(upFile, JSON.stringify({
    hcnsec: { baseUrl: `http://127.0.0.1:${upstream.address().port}`, apiKey: 'up-key' },
  }));

  const srv = await startGateway({ port: 0, host: '127.0.0.1' });
  const rec = createKey({ label: 'сквозной' });
  try {
    const r = await fetch(`http://127.0.0.1:${srv.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + rec.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'auto', stream: true, messages: [{ role: 'user', content: 'скажи привет' }] }),
    });
    const body = await r.text();
    if (!body.includes('это ответ')) throw new Error('ответ апстрима не дошёл до клиента');

    const chat = GW.listChats({ limit: 1 })[0];
    if (!chat) throw new Error('лог не записался');
    if (chat.prompt !== 'скажи привет') throw new Error('запрос в логе: ' + chat.prompt);
    if (chat.reply !== 'Привет, это ответ') throw new Error('ответ в логе: ' + chat.reply);
    if (chat.tokens.input !== 33 || chat.tokens.output !== 7) throw new Error('токены: ' + JSON.stringify(chat.tokens));
    if (chat.upstream !== 'hcnsec') throw new Error('апстрим: ' + chat.upstream);

    const key = listKeys().find((k) => k.id === rec.id);
    if (key.used.input !== 33) throw new Error('расход не записался на ключ');

    GW.deleteChats({ id: chat.id });
    return `«${chat.reply}» · ${chat.tokens.input}↑ ${chat.tokens.output}↓ · ${chat.ms} мс`;
  } finally {
    revokeKey(rec.id);
    srv.close();
    upstream.close();
    fs.rmSync(upFile, { force: true });
  }
});

console.log('\n── телеграм-бот ──');

await check('bot.mjs грузится и отдаёт createBot/startBotFromEnv', async () => {
  const bot = await import('../server/bot.mjs');
  for (const n of ['createBot', 'startBotFromEnv']) {
    if (typeof bot[n] !== 'function') throw new Error('нет ' + n);
  }
  return Object.keys(bot).join(', ');
});

await check('бот отвечает на команды и не пускает чужих', async () => {
  const { createBot } = await import('../server/bot.mjs');

  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, init) => {
    const method = String(u).split('/').pop();
    const body = JSON.parse(init?.body ?? '{}');
    sent.push({ method, body });
    return { json: async () => ({ ok: true, result: method === 'getUpdates' ? [] : { message_id: 1 } }) };
  };

  try {
    const bot = createBot({ token: 'test:token', admins: ['42'], onLog: () => {} });
    const msg = (text, from = 42) => ({ message: { chat: { id: 1 }, from: { id: from }, text } });
    const last = () => sent[sent.length - 1].body.text;

    await bot.handle(msg('/help'));
    if (!last().includes('/keys')) throw new Error('help без команд');

    await bot.handle(msg('/new телефон 100k'));
    if (!/cr-/.test(last())) throw new Error('ключ не показан: ' + last().slice(0, 60));
    const id = /id <code>([a-f0-9]+)<\/code>/.exec(last())?.[1];
    if (!id) throw new Error('в ответе нет id ключа');

    await bot.handle(msg('/keys'));
    if (!last().includes('телефон')) throw new Error('ключа нет в списке');

    await bot.handle({ callback_query: { id: 'cb1', data: 'key:' + id, from: { id: 42 }, message: { chat: { id: 1 }, message_id: 7 } } });
    const card = sent[sent.length - 1].body.text;
    if (!card.includes('лимит')) throw new Error('карточка ключа без лимита');

    await bot.handle(msg('/stats'));
    if (!last().includes('Расход')) throw new Error('нет статистики');

    await bot.handle(msg('/chats'));
    if (!/Чаты|чат/i.test(last())) throw new Error('нет экрана чатов');

    await bot.handle(msg('/rm ' + id));
    if (!last().includes('Удалено')) throw new Error('ключ не удалён: ' + last());

    const before = sent.length;
    await bot.handle(msg('/keys', 999));
    const reply = sent[sent.length - 1].body.text;
    if (sent.length === before) throw new Error('чужому вообще не ответили');
    if (!reply.includes('999') || reply.includes('cr-')) throw new Error('чужому показали лишнее');

    return `${sent.length} вызовов API, чужой отсечён`;
  } finally {
    globalThis.fetch = realFetch;
  }
});

console.log('\n── CLI ──');

await check('версия в package.json и config.mjs совпадает', async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'));
  const { VERSION } = mods.config;
  if (pkg.version !== VERSION) throw new Error(`package.json ${pkg.version} ≠ VERSION ${VERSION}`);
  const { execFileSync } = await import('node:child_process');
  const bin = path.join(import.meta.dirname, '..', 'bin', 'coderoom.mjs');
  const shown = execFileSync(process.execPath, [bin, '--version'], { encoding: 'utf8' }).trim();
  if (shown !== VERSION) throw new Error(`--version выводит ${shown}`);
  return 'v' + VERSION;
});

await check('--help и --version работают', async () => {
  const { execFileSync } = await import('node:child_process');
  const bin = path.join(import.meta.dirname, '..', 'bin', 'coderoom.mjs');
  const v = execFileSync(process.execPath, [bin, '--version'], { encoding: 'utf8' }).trim();
  const h = execFileSync(process.execPath, [bin, '--help'], { encoding: 'utf8' });
  if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error('версия: ' + v);
  if (!h.includes('--web') || !h.includes('--model')) throw new Error('справка неполная');
  if (!h.includes('--update')) throw new Error('в справке нет обновлений');
  return 'v' + v;
});

await check('coderoom update сообщает о состоянии версии', async () => {
  const { execFileSync } = await import('node:child_process');
  const bin = path.join(import.meta.dirname, '..', 'bin', 'coderoom.mjs');
  // кэш от предыдущей проверки подсунул бы «новую версию 99.0.0» — начинаем с чистого
  fs.rmSync(path.join(process.env.CODEROOM_HOME, 'update-cache.json'), { force: true });
  const run = (...args) => {
    // недоступный реестр — законный повод для кода 1, нам важен текст
    try {
      return execFileSync(process.execPath, [bin, ...args], {
        encoding: 'utf8',
        env: { ...process.env, CODEROOM_REGISTRY: 'http://127.0.0.1:1', NO_COLOR: '1' },
      });
    } catch (e) {
      return String(e.stdout ?? '');
    }
  };
  const out = run('update');
  if (!/обновлен|версия|Не смог/i.test(out)) throw new Error('невнятный вывод: ' + out.slice(0, 80));
  if (!/выключена/i.test(run('update', 'off'))) throw new Error('update off не отработал');
  run('update', 'on');
  return out.trim().slice(0, 60);
});

// БД надо закрыть до удаления: Windows не даёт снять открытый файл
try { GW.closeStore(); } catch { /* ignore */ }
try {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
} catch (e) {
  console.log(`  (временную папку не удалось убрать: ${e.code})`);
}

console.log(fails ? `\n✗ провалено проверок: ${fails}\n` : '\n✓ все проверки прошли\n');
process.exit(fails ? 1 : 0);
