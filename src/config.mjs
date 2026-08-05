import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const CONFIG_DIR = process.env.CODEROOM_HOME
  ? path.resolve(process.env.CODEROOM_HOME)
  : path.join(os.homedir(), '.coderoom');

export const VERSION = '1.1.1';

export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
export const SESSIONS_DIR = path.join(CONFIG_DIR, 'sessions');
export const GLOBAL_MEMORY = path.join(CONFIG_DIR, 'CODEROOM.md');

export const PROVIDER_PRESETS = {
  coderoom: {
    id: 'coderoom',
    label: 'CodeRoom',
    baseUrl: 'https://api.as201823.run',
    api: 'openai',
    keyEnv: 'CODEROOM_KEY',
    keyPrefix: 'cr-',
    isGateway: true,
    defaultModel: 'claude-opus-5',
    site: '',
    models: [
      { id: 'claude-opus-5', label: 'Claude Opus 5', note: 'Флагман, для сложного кода', recommended: true },
      { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', note: 'Предыдущий флагман' },
      { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', note: 'Быстрая, для правок' },
      { id: 'auto', label: 'Auto', note: 'Роутер: сам выбирает модель' },
      { id: 'DeepSeek-V4-Flash', label: 'DeepSeek V4 Flash', note: 'Быстрая MoE' },
      { id: 'DeepSeek-V4-Pro', label: 'DeepSeek V4 Pro', note: 'Сильная, для кода' },
      { id: 'glm-5.1', label: 'GLM 5.1', note: 'Длинные задачи' },
      { id: 'glm-5.2', label: 'GLM 5.2', note: 'Топ, но медленная' },
      { id: 'kat-coder-pro-v2.5', label: 'KAT Coder Pro v2.5', note: 'Заточена под код' },
      { id: 'Kimi-K2.6', label: 'Kimi K2.6' },
      { id: 'MiniMax-M3', label: 'MiniMax M3', note: 'Мультимодальная' },
      { id: 'Qwen3.5-397B-A17B', label: 'Qwen3.5 397B-A17B', note: 'Крупная MoE' },
      { id: 'Qwen3.6-35B-A3B', label: 'Qwen3.6 35B-A3B', note: 'Лёгкая MoE' },
      { id: 'sensenova-6.7-flash-lite', label: 'SenseNova 6.7 Flash Lite' },
      { id: 'sensenova-u1-fast', label: 'SenseNova U1 Fast', note: 'Очень быстрая' },
      { id: 'step-3.5-flash', label: 'Step 3.5 Flash' },
      { id: 'step-3.5-flash-2603', label: 'Step 3.5 Flash (2603)' },
      { id: 'step-3.7-flash', label: 'Step 3.7 Flash' },
      { id: 'step-image-edit-2', label: 'Step Image Edit 2', note: 'Генерация картинок', chat: false },
      { id: 'step-router-v1', label: 'Step Router v1', note: 'Роутер step/deepseek' },
      { id: 'stepaudio-2.5-asr', label: 'StepAudio 2.5 ASR', note: 'Речь → текст', chat: false },
      { id: 'stepaudio-2.5-chat', label: 'StepAudio 2.5 Chat', note: 'Голосовой чат' },
      { id: 'stepaudio-2.5-realtime', label: 'StepAudio 2.5 Realtime', note: 'Аудио realtime', chat: false },
      { id: 'stepaudio-2.5-tts', label: 'StepAudio 2.5 TTS', note: 'Текст → речь', chat: false },
      { id: 'nemotron-3-ultra-550b', label: 'Nemotron 3 Ultra 550B', note: 'Флагман с рассуждением' },
      { id: 'nemotron-3-super-120b', label: 'Nemotron 3 Super 120B', note: 'С рассуждением' },
      { id: 'nemotron-3-nano-30b', label: 'Nemotron 3 Nano 30B', note: 'Быстрая' },
      { id: 'nemotron-nano-3-30b', label: 'Nemotron Nano 3 30B' },
      { id: 'nemotron-3-nano-omni', label: 'Nemotron 3 Nano Omni', note: 'Мультимодальная' },
      { id: 'llama-nemotron-ultra-253b', label: 'Llama Nemotron Ultra 253B' },
      { id: 'llama-nemotron-super-49b-v1.5', label: 'Llama Nemotron Super 49B v1.5' },
      { id: 'llama-nemotron-super-49b', label: 'Llama Nemotron Super 49B' },
      { id: 'llama-nemotron-70b', label: 'Llama Nemotron 70B' },
      { id: 'nemotron-nano-9b-v2', label: 'Nemotron Nano 9B v2', note: 'Лёгкая' },
      { id: 'nemotron-4-340b', label: 'Nemotron 4 340B' },
      { id: 'gpt-oss-120b', label: 'GPT-OSS 120B' },
      { id: 'gpt-oss-20b', label: 'GPT-OSS 20B', note: 'Лёгкая' },
      { id: 'deepseek-v4-pro-alt', label: 'DeepSeek V4 Pro · alt', note: 'Сильная, для кода' },
      { id: 'deepseek-v4-flash-alt', label: 'DeepSeek V4 Flash · alt', note: 'Быстрая' },
      { id: 'deepseek-coder-6.7b', label: 'DeepSeek Coder 6.7B', note: 'Под код' },
      { id: 'kimi-k2.6-alt', label: 'Kimi K2.6 · alt' },
      { id: 'glm-5.2-alt', label: 'GLM 5.2 · alt' },
      { id: 'minimax-m3-alt', label: 'MiniMax M3 · alt', note: 'Мультимодальная' },
      { id: 'step-3.7-flash-alt', label: 'Step 3.7 Flash · alt' },
      { id: 'llama-3.3-70b', label: 'Llama 3.3 70B' },
      { id: 'llama-3.1-70b', label: 'Llama 3.1 70B' },
      { id: 'mistral-large-2', label: 'Mistral Large 2' },
      { id: 'mistral-medium-3.5', label: 'Mistral Medium 3.5' },
      { id: 'codestral-22b', label: 'Codestral 22B', note: 'Под код' },
      { id: 'mistral-nemotron', label: 'Mistral Nemotron' },
      { id: 'gemma-4-31b', label: 'Gemma 4 31B' },
      { id: 'gemma-3-12b', label: 'Gemma 3 12B' },
      { id: 'palmyra-creative-122b', label: 'Palmyra Creative 122B', note: 'Тексты' },
      { id: 'laguna-xs-2.1', label: 'Laguna XS 2.1' },
      { id: 'inkling', label: 'Inkling' },
      { id: 'starcoder2-15b', label: 'StarCoder2 15B', note: 'Под код' },
      { id: 'jamba-1.5-large', label: 'Jamba 1.5 Large' },
      { id: 'dbrx-instruct', label: 'DBRX Instruct' },
    ],
  },
};

export const DEFAULT_CONFIG = {
  version: 1,
  provider: 'coderoom',
  model: 'claude-opus-5',
  smallModel: 'gpt-5.6-sol',
  theme: 'claude',
  webTheme: 'aurora',
  lang: 'ru',
  providers: {},
  permissions: {
    mode: 'yolo',
    allow: ['Read(**)', 'Glob(**)', 'Grep(**)', 'List(**)', 'Todo(**)'],
    ask: ['Write(**)', 'Edit(**)', 'Bash(**)', 'WebFetch(**)'],
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
    cfg.model = PROVIDER_PRESETS[cfg.provider]?.defaultModel || 'claude-opus-5';
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
