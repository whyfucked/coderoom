import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const CONFIG_DIR = process.env.CODEROOM_HOME
  ? path.resolve(process.env.CODEROOM_HOME)
  : path.join(os.homedir(), '.coderoom');

export const VERSION = '1.1.8';

export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
export const SESSIONS_DIR = path.join(CONFIG_DIR, 'sessions');
export const GLOBAL_MEMORY = path.join(CONFIG_DIR, 'CODEROOM.md');

// Разделы моделей — по ним строятся группы в /model и подсказки в UI.
// Группируем по создателю модели (а не по «скорости»): так проще искать глазами,
// и не приходится придумывать, чем «мощная» отличается от «прочей».
// Порядок важен: так они и рисуются в селекторе.
export const MODEL_TIERS = {
  anthropic: { label: 'Anthropic', note: 'Claude — умеют инструменты',   order: 1 },
  openai:    { label: 'ChatGPT',   note: 'GPT и GPT-OSS',                order: 2 },
  nvidia:    { label: 'Nvidia',    note: 'Nemotron',                     order: 3 },
  deepseek:  { label: 'DeepSeek',  note: 'сильные под код',              order: 4 },
  google:    { label: 'Google',    note: 'Gemini, Gemma, CodeGemma',     order: 5 },
  qwen:      { label: 'Qwen',      note: '',                                      order: 6 },
  zai:       { label: 'Z-AI',      note: 'GLM',                                   order: 7 },
  other:     { label: 'Прочие',    note: 'Grok, NN, роутеры и всё остальное',      order: 8 },
};


export const PROVIDER_PRESETS = {
  // Единственный провайдер клиента — наш шлюз. Всё, что раньше ходило напрямую
  // к чужим API, теперь идёт через него: клиент видит один ключ cr-… и публичные
  // имена моделей, а какой апстрим отвечает — забота сервера (см. server/gateway.mjs).
  //
  // Пометка tools — из реальных замеров (/v1/chat/completions с tool_choice=required):
  // tool_calls отдают только claude-opus-*/claude-sonnet-5, остальные молча игнорируют
  // tools, поэтому для агента (правки файлов, bash) годятся не все — только чат/smallModel.
  coderoom: {
    id: 'coderoom',
    label: 'CodeRoom',
    baseUrl: 'https://api.as201823.run',
    api: 'openai',
    keyEnv: 'CODEROOM_KEY',
    keyPrefix: 'cr-',
    isGateway: true,
    defaultModel: 'nemotron-3-ultra-550b',
    smallModel: 'nemotron-3-nano-30b',
    site: '',
    models: [
      { id: 'claude-fable-5', label: 'Claude Fable 5', tier: 'anthropic' },
      { id: 'claude-opus-4-7', label: 'Claude Opus 4.7', tier: 'anthropic', tools: true, recommended: true },
      { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', tier: 'anthropic', tools: true },
      { id: 'claude-opus-5', label: 'Claude Opus 5', tier: 'anthropic', tools: true },
      { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', tier: 'anthropic', tools: true },
      { id: 'gpt-5-5', label: 'GPT-5.5', tier: 'openai' },
      { id: 'gpt-5.6', label: 'GPT-5.6', tier: 'openai' },
      { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', tier: 'openai' },
      { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', tier: 'openai' },
      { id: 'gemini-3-1-pro', label: 'Gemini 3.1 Pro', tier: 'google' },
      { id: 'gemini-3-flash', label: 'Gemini 3 Flash', tier: 'google' },
      { id: 'gemini-3-pro', label: 'Gemini 3 Pro', tier: 'google' },
      { id: 'qwen-3-max', label: 'Qwen 3 Max', tier: 'qwen' },
      { id: 'glm-5-2', label: 'GLM 5.2', tier: 'zai' },
      { id: 'grok-4.5', label: 'Grok 4.5', tier: 'other' },
      { id: 'grok-4.6', label: 'Grok 4.6', tier: 'other' },
      { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', tier: 'deepseek' },
      { id: 'DeepSeek-V4-Flash-0731', label: 'DeepSeek V4 Flash (0731)', tier: 'deepseek' },
      { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', tier: 'deepseek' },
      { id: 'deepseek-v4-pro-0813', label: 'DeepSeek V4 Pro (0813)', tier: 'deepseek' },
      { id: 'DeepSeek-V4-Flash', label: 'DeepSeek V4 Flash (classic)', tier: 'deepseek' },
      { id: 'DeepSeek-V4-Pro', label: 'DeepSeek V4 Pro (classic)', tier: 'deepseek' },
      { id: 'gpt-oss-120b', label: 'GPT-OSS 120B', tier: 'openai' },
      { id: 'gpt-oss-20b', label: 'GPT-OSS 20B', tier: 'openai' },
      { id: 'nemotron-3-ultra-550b', label: 'Nemotron 3 Ultra 550B', tier: 'nvidia', recommended: true },
      { id: 'nemotron-3-super-120b', label: 'Nemotron 3 Super 120B', tier: 'nvidia' },
      { id: 'nemotron-3-nano-30b', label: 'Nemotron 3 Nano 30B', tier: 'nvidia' },
      { id: 'nemotron-nano-9b-v2', label: 'Nemotron Nano 9B v2', tier: 'nvidia' },
      { id: 'llama-nemotron-super-49b-v1.5', label: 'Llama Nemotron Super 49B v1.5', tier: 'nvidia' },
      { id: 'llama-nemotron-super-49b', label: 'Llama Nemotron Super 49B', tier: 'nvidia' },
      { id: 'llama-nemotron-70b', label: 'Llama Nemotron 70B', tier: 'nvidia' },
      { id: 'gemma-4', label: 'Gemma 4', tier: 'google' },
      { id: 'gemma-4-26b', label: 'Gemma 4 26B', tier: 'google' },
      { id: 'gemma-3-12b', label: 'Gemma 3 12B', tier: 'google' },
      { id: 'gemma-2-2b', label: 'Gemma 2 2B', tier: 'google' },
      { id: 'codegemma-7b', label: 'CodeGemma 7B', tier: 'google' },
      { id: 'diffusiongemma-26b', label: 'DiffusionGemma 26B A4B', tier: 'google' },
      { id: 'qwen3-coder-480b', label: 'Qwen3 Coder 480B-A35B', tier: 'qwen' },
      { id: 'qwen3-next-80b', label: 'Qwen3 Next 80B-A3B', tier: 'qwen' },
      { id: 'qwen3.5-122b', label: 'Qwen3.5 122B-A10B', tier: 'qwen' },
      { id: 'Qwen3.5-397B-A17B', label: 'Qwen3.5 397B-A17B', tier: 'qwen' },
      { id: 'qwen3.5-397b-alt', label: 'Qwen3.5 397B-A17B alt', tier: 'qwen' },
      { id: 'Qwen3.6-35B-A3B', label: 'Qwen3.6 35B-A3B', tier: 'qwen' },
      { id: 'qwen2.5', label: 'Qwen2.5', tier: 'qwen' },
      { id: 'glm-5.2', label: 'GLM 5.2', tier: 'zai' },
      { id: 'glm-5.2-alt', label: 'GLM 5.2 alt', tier: 'zai' },
      { id: 'glm-5.1', label: 'GLM 5.1', tier: 'zai' },
      { id: 'glm-5.1-alt', label: 'GLM 5.1 alt', tier: 'zai' },
      { id: 'auto', label: 'Auto', tier: 'other', recommended: true },
      { id: 'step-router-v1', label: 'Step Router v1', tier: 'other' },
      { id: 'kat-coder-pro-v2.5', label: 'KAT Coder Pro v2.5', tier: 'other' },
      { id: 'Kimi-K2.6', label: 'Kimi K2.6', tier: 'other' },
      { id: 'MiniMax-M3', label: 'MiniMax M3', tier: 'other' },
      { id: 'sensenova-6.7-flash-lite', label: 'SenseNova 6.7 Flash Lite', tier: 'other' },
      { id: 'step-3.7-flash', label: 'Step 3.7 Flash', tier: 'other' },
      { id: 'step-3.5-flash', label: 'Step 3.5 Flash', tier: 'other' },
      { id: 'step-3.5-flash-2603', label: 'Step 3.5 Flash (2603)', tier: 'other' },
    ],
  },
};


export const DEFAULT_CONFIG = {
  version: 1,
  provider: 'coderoom',
  model: 'auto',
  smallModel: 'nemotron-3-nano-30b',
  theme: 'claude',
  webTheme: 'aurora',
  lang: 'ru',
  providers: {},
  hosts: {},          // серверы для SSH: имя → { host, user, port, keyFile }
  customPrompts: {},  // пользовательские промты: имя → { name, prompt, description }
  activeCustomPrompt: null,
  permissions: {
    mode: 'yolo',
    allow: ['Read(**)', 'Glob(**)', 'Grep(**)', 'List(**)', 'Todo(**)'],
    ask: ['Write(**)', 'Edit(**)', 'Bash(**)', 'WebFetch(**)', 'Ssh(**)'],
    deny: [],
  },
  security: {
    restrictToWorkspace: true,
    confirmDangerousCommands: true,
    redactSecrets: true,
    blockedPaths: ['.env', '.env.*', 'id_rsa', 'id_ed25519', '*.pem', '*.key', 'credentials.json'],
  },
  agent: {
    maxSteps: 40,
    maxTokens: 8192,
    temperature: 0.2,
    autoCompactAt: 140000,
    streamReasoning: true,
  },
  ui: {
    showTokenUsage: true,
    showCost: true,
    compactToolOutput: true,
    maxToolOutputLines: 24,
    banner: true,
  },
  web: {
    port: 4517,
    host: '127.0.0.1',
    autoOpen: true,
  },
  update: {
    check: true,          // смотреть, не вышла ли новая версия в npm
    prompt: true,         // спрашивать «обновить?» при запуске
    autoInstall: false,   // ставить сразу, без вопросов
    intervalHours: 24,    // как часто ходить в реестр
    channel: 'latest',    // dist-tag: latest | next | …
    skipVersion: null,    // версия, про которую больше не напоминать
  },
  telemetry: false,
  onboarded: false,
};

function deepMerge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over ?? base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function ensureConfigDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

export function loadConfig({ cwd = process.cwd() } = {}) {
  let cfg = structuredClone(DEFAULT_CONFIG);

  if (fs.existsSync(CONFIG_FILE)) {
    try {
      cfg = deepMerge(cfg, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
    } catch (e) {
      cfg._loadError = `Не смог прочитать ${CONFIG_FILE}: ${e.message}`;
    }
  }

  const projectFile = path.join(cwd, '.coderoom', 'settings.json');
  if (fs.existsSync(projectFile)) {
    try {
      const proj = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
      delete proj.providers;
      cfg = deepMerge(cfg, proj);
      cfg._projectSettings = projectFile;
    } catch (e) {
      cfg._loadError = `Не смог прочитать ${projectFile}: ${e.message}`;
    }
  }

  if (process.env.CODEROOM_MODEL) cfg.model = process.env.CODEROOM_MODEL;
  if (process.env.CODEROOM_THEME) cfg.theme = process.env.CODEROOM_THEME;

  if (!PROVIDER_PRESETS[cfg.provider]) {
    cfg.provider = DEFAULT_CONFIG.provider;
  }

  if (/^\d+$/.test(String(cfg.model ?? ''))) {
    cfg.model = PROVIDER_PRESETS[cfg.provider]?.defaultModel || 'auto';
  }

  return cfg;
}

export function saveConfig(cfg) {
  ensureConfigDir();
  const clean = { ...cfg };
  for (const k of Object.keys(clean)) if (k.startsWith('_')) delete clean[k];

  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_FILE);
  try {
    fs.chmodSync(CONFIG_FILE, 0o600);
  } catch {
  }
  return CONFIG_FILE;
}

export function resolveProvider(cfg, providerId = cfg.provider) {
  const preset = PROVIDER_PRESETS[providerId];
  if (!preset) throw new Error(`Неизвестный провайдер: ${providerId}`);

  const saved = cfg.providers?.[providerId] ?? {};
  const envKey = preset.keyEnv ? process.env[preset.keyEnv] : undefined;

  return {
    ...preset,
    ...saved,
    apiKey: envKey || saved.apiKey || '',
    baseUrl: (process.env.CODEROOM_BASE_URL || saved.baseUrl || preset.baseUrl || '')
      .replace(/\/+$/, '').replace(/\/v1$/, ''),
    userAgent: saved.userAgent || preset.userAgent || `coderoom/${VERSION} (cli)`,
    keySource: envKey ? `env:${preset.keyEnv}` : saved.apiKey ? 'config' : 'none',
  };
}

export function setProviderKey(cfg, providerId, apiKey, extra = {}) {
  cfg.providers ??= {};
  cfg.providers[providerId] = { ...(cfg.providers[providerId] ?? {}), apiKey, ...extra };
  return cfg;
}

export function projectId(cwd = process.cwd()) {
  const hash = crypto.createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 12);
  const base = path.basename(path.resolve(cwd)).replace(/[^\w.-]+/g, '_').slice(0, 32) || 'project';
  return `${base}-${hash}`;
}


const HISTORY_FILE = path.join(CONFIG_DIR, 'history.json');
const HISTORY_MAX = 500;

export function loadHistory() {
  try {
    const arr = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    return Array.isArray(arr) ? arr.filter((s) => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

export function saveHistory(list) {
  try {
    ensureConfigDir();
    const tail = list.slice(-HISTORY_MAX);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(tail), { mode: 0o600 });
  } catch {
  }
}

export function maskKey(key) {
  if (!key) return '(не задан)';
  if (key.length <= 12) return key.slice(0, 3) + '***';
  return `${key.slice(0, 7)}…${key.slice(-4)}`;
}
