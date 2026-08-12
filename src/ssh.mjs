import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { loadConfig, saveConfig } from './config.mjs';

export const CONFIG_DIR = process.env.CODEROOM_HOME
  ? path.resolve(process.env.CODEROOM_HOME)
  : path.join(os.homedir(), '.coderoom');

const SSH_DIR = path.join(CONFIG_DIR, 'ssh');
export const KEY_FILE = path.join(SSH_DIR, 'id_ed25519');
export const KNOWN_HOSTS = path.join(SSH_DIR, 'known_hosts');
const PASSWORD_FILE = path.join(SSH_DIR, 'passwords.json');

function ensureSshDir() {
  fs.mkdirSync(SSH_DIR, { recursive: true });
}

function ensureKnownHosts() {
  ensureSshDir();
  if (!fs.existsSync(KNOWN_HOSTS)) fs.writeFileSync(KNOWN_HOSTS, '', 'utf8');
}

function ensurePasswordStore() {
  ensureSshDir();
  if (!fs.existsSync(PASSWORD_FILE)) fs.writeFileSync(PASSWORD_FILE, '{}', 'utf8');
  fs.chmodSync(PASSWORD_FILE, 0o600);
}

function loadPasswords() {
  try {
    ensurePasswordStore();
    return JSON.parse(fs.readFileSync(PASSWORD_FILE, 'utf8') || '{}');
  } catch {
    return {};
  }
}

function savePasswords(data) {
  ensurePasswordStore();
  fs.writeFileSync(PASSWORD_FILE, JSON.stringify(data, null, 2), 'utf8');
  fs.chmodSync(PASSWORD_FILE, 0o600);
}

function validateAuthMode(mode) {
  const allowed = ['auto', 'key', 'password'];
  if (!allowed.includes(mode)) throw new Error(`Недопустимый способ auth: ${mode}`);
  return mode;
}

function sshCommand(host, keyFile, password, binary = 'ssh', extraOptions = []) {
  ensureKnownHosts();
  const args = [
    '-p', String(host.port || 22),
    '-o', 'StrictHostKeyChecking=no',
    '-o', `UserKnownHostsFile=${KNOWN_HOSTS}`,
    '-o', 'BatchMode=no',
    '-o', 'ConnectTimeout=15',
  ];
  if (keyFile) args.push('-i', keyFile);
  const sshArgs = args.concat(extraOptions, [`${host.user}@${host.host}`]);

  if (password) {
    const probe = spawnSync('sshpass', ['-V'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (probe.status === 0) {
      return { cmd: 'sshpass', args: ['-p', String(password), binary, ...sshArgs] };
    }
  }
  return { cmd: binary, args: sshArgs };
}

export function ensureKeyPair() {
  ensureSshDir();
  const pubFile = `${KEY_FILE}.pub`;
  if (fs.existsSync(KEY_FILE) && fs.existsSync(pubFile)) return KEY_FILE;

  const result = spawnSync('ssh-keygen', ['-t', 'ed25519', '-f', KEY_FILE, '-N', '', '-q'], {
    stdio: 'inherit',
  });
  if (result.error || result.status !== 0) {
    throw new Error('Не удалось создать SSH-ключ: ssh-keygen не доступен или завершился с ошибкой');
  }
  fs.chmodSync(KEY_FILE, 0o600);
  return KEY_FILE;
}

function validateName(name) {
  if (!name || typeof name !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(name)) {
    throw new Error('Неправильное имя сервера');
  }
}

function validateHost(host) {
  if (!host || typeof host !== 'string') {
    throw new Error('Неправильный хост');
  }
  if (net.isIP(host)) return;
  const ipv6 = host.match(/^\[(.*)]$/);
  if (ipv6 && net.isIP(ipv6[1])) return;
  if (!/^[a-zA-Z0-9.-]+$/.test(host) || !host.includes('.') || host.length < 3) {
    throw new Error('Неправильный хост');
  }
}

function validatePort(port) {
  if (port === undefined || port === null || port === '') return 22;
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error('Неправильный порт');
  }
  return n;
}

export function parseTarget(target) {
  if (!target || typeof target !== 'string') throw new Error('Неправильный target');

  let user;
  let host;
  let port = 22;

  if (target.startsWith('ssh://')) {
    const url = new URL(target);
    if (url.protocol !== 'ssh:') throw new Error('Неправильный target');
    user = url.username || undefined;
    host = stripBrackets(url.hostname);
    port = validatePort(url.port || 22);
  } else {
    const at = target.indexOf('@');
    let tail = target;
    if (at !== -1) {
      user = target.slice(0, at);
      tail = target.slice(at + 1);
    }

    if (tail.startsWith('[')) {
      const end = tail.indexOf(']');
      if (end === -1) throw new Error('Неправильный target');
      host = stripBrackets(tail.slice(0, end + 1));
      const rest = tail.slice(end + 1);
      if (rest.startsWith(':')) port = validatePort(rest.slice(1));
      else if (rest.length) throw new Error('Неправильный target');
    } else {
      const lastColon = tail.lastIndexOf(':');
      if (lastColon !== -1 && /^[0-9]+$/.test(tail.slice(lastColon + 1))) {
        host = tail.slice(0, lastColon);
        port = validatePort(tail.slice(lastColon + 1));
      } else {
        host = tail;
      }
    }
  }

  if (!host) throw new Error('Неправильный target');
  validateHost(host);
  return { user, host, port };
}

function stripBrackets(host) {
  return host.replace(/^\[(.*)]$/, '$1');
}

function hostEntry(cfg, name) {
  const entry = cfg.hosts?.[name];
  return entry ? { name, ...entry } : undefined;
}

export function listHosts(cfg) {
  return Object.entries(cfg.hosts ?? {}).map(([name, host]) => ({ name, ...host }));
}

export function getHost(cfg, name) {
  return hostEntry(cfg, name);
}

export function addHost(cfg, data) {
  if (!data || typeof data !== 'object') throw new Error('Неверные данные для сервера');
  validateName(data.name);
  validateHost(data.host);
  if (!data.user) throw new Error('Нужен пользователь');

  cfg.hosts ??= {};
  cfg.hosts[data.name] = {
    host: data.host,
    user: data.user,
    port: validatePort(data.port),
    keyInstalled: false,
    auth: 'auto',
    ...(data.keyFile ? { keyFile: data.keyFile } : {}),
  };

  saveConfig(cfg);
  return getHost(cfg, data.name);
}

export function removeHost(cfg, name) {
  if (!cfg.hosts || !cfg.hosts[name]) return false;
  delete cfg.hosts[name];
  saveConfig(cfg);
  return true;
}

export function markOk(cfg, name) {
  const host = cfg.hosts?.[name];
  if (!host) throw new Error('Сервер не найден');
  host.keyInstalled = true;
  saveConfig(cfg);
  return getHost(cfg, name);
}

export function useKey(cfg, name, keyFile) {
  if (!keyFile || typeof keyFile !== 'string') throw new Error('Нужен путь к ключу');
  if (path.extname(keyFile) === '.pub') throw new Error('Нужен приватный ключ, не .pub');
  if (!fs.existsSync(keyFile)) throw new Error('Файл ключа не найден');

  const host = cfg.hosts?.[name];
  if (!host) throw new Error('Сервер не найден');

  host.keyFile = keyFile;
  saveConfig(cfg);
  return getHost(cfg, name);
}

export function setHostPassword(cfg, name, password) {
  const host = cfg.hosts?.[name];
  if (!host) throw new Error('Сервер не найден');
  if (typeof password !== 'string' || !password) throw new Error('Пароль не может быть пустым');
  const passwords = loadPasswords();
  passwords[name] = { password };
  savePasswords(passwords);
  return true;
}

export function getHostPassword(name) {
  return loadPasswords()[name]?.password;
}

export function removeHostPassword(cfg, name) {
  if (!cfg.hosts?.[name]) throw new Error('Сервер не найден');
  const passwords = loadPasswords();
  delete passwords[name];
  savePasswords(passwords);
  return true;
}

export function setAuthMode(cfg, name, mode) {
  const host = cfg.hosts?.[name];
  if (!host) throw new Error('Сервер не найден');
  host.auth = validateAuthMode(mode);
  saveConfig(cfg);
  return getHost(cfg, name);
}

export function ensureKey() {
  ensureSshDir();
  return KEY_FILE;
}

export function hasKey() {
  return fs.existsSync(KEY_FILE);
}

export function publicKey() {
  const pub = `${KEY_FILE}.pub`;
  if (!fs.existsSync(pub)) throw new Error('Публичный ключ не найден');
  return fs.readFileSync(pub, 'utf8');
}

export function runRemote(host, command, { keyFile, password } = {}) {
  const { cmd, args } = sshCommand(host, keyFile ?? host.keyFile ?? KEY_FILE, password);
  const fullArgs = args.concat(['bash', '-s']);
  const proc = spawnSync(cmd, fullArgs, {
    encoding: 'utf8',
    input: command,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  return {
    code: proc.status ?? 1,
    stdout: proc.stdout ?? '',
    stderr: proc.stderr ?? '',
    error: proc.error,
  };
}

export function connectRemote(host, { keyFile, password } = {}) {
  const { cmd, args } = sshCommand(host, keyFile ?? host.keyFile ?? KEY_FILE, password, 'ssh', ['-t']);
  const proc = spawnSync(cmd, args, {
    stdio: 'inherit',
  });
  if (proc.error) throw proc.error;
  return proc.status ?? 1;
}

export function connectSftp(host, { keyFile, password } = {}) {
  const { cmd, args } = sshCommand(host, keyFile ?? host.keyFile ?? KEY_FILE, password, 'sftp');
  const proc = spawnSync(cmd, args, {
    stdio: 'inherit',
  });
  if (proc.error) throw proc.error;
  return proc.status ?? 1;
}

export function copyPublicKey(host, keyFile = KEY_FILE, password) {
  ensureKeyPair();
  const pubFile = `${keyFile}.pub`;
  if (!fs.existsSync(pubFile)) throw new Error('Публичный ключ не найден');
  const pubKey = fs.readFileSync(pubFile, 'utf8');
  const script = `mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`;
  const result = runRemote(host, `${script}\n${pubKey}`, { keyFile: host.keyFile ?? keyFile, password });
  if (result.error) throw result.error;
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || `ssh exited with code ${result.code}`);
  }
  return true;
}

export function configureSshd(host, allowPassword = true, { keyFile, password } = {}) {
  const passwordValue = allowPassword ? 'yes' : 'no';
  const script = `set -e
cp /etc/ssh/sshd_config /etc/ssh/sshd_config.coderoom.bak 2>/dev/null || true
sed -i 's/^#\\?\\s*PasswordAuthentication.*/PasswordAuthentication ${passwordValue}/' /etc/ssh/sshd_config
sed -i 's/^#\\?\\s*PubkeyAuthentication.*/PubkeyAuthentication yes/' /etc/ssh/sshd_config
systemctl restart sshd || service ssh restart`;
  const result = runRemote(host, script, { keyFile: keyFile ?? host.keyFile ?? KEY_FILE, password });
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || `ssh exited with code ${result.code}`);
  }
  return result;
}

export async function interactive() {
  throw new Error('Интерактивный SSH пока не реализован');
}

export async function probe() {
  return [
    'set -e',
    'for item in "$@"; do',
    '  echo "$item"',
    'done',
  ].join('\n');
}

export async function checkKeyAuth() {
  return {
    keyOnly: true,
    description: 'Проверка аутентификации по ключу',
  };
}

export async function installKey() {
  return [
    'mkdir -p ~/.ssh',
    'chmod go-w ~/',
    'cat >> ~/.ssh/authorized_keys <<\'EOF\'',
    '# ключ сюда',
    'EOF',
  ].join('\n');
}

export const SshTool = {
  name: 'Ssh',
  description: 'Инструмент для управления SSH-серверами и удалёнными командами.',
  mutating: true,
  requiresExplicitApproval: true,
  schema: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'Действие, например list' },
      host: { type: 'string', description: 'Имя сервера из конфига' },
      command: { type: 'string', description: 'Команда для выполнения на сервере' },
    },
  },
  async run(args, { cfg }) {
    const action = String(args?.action ?? '').trim().toLowerCase();
    if (action === 'list' || (!args?.host && !args?.command)) {
      const hosts = listHosts(cfg);
      if (!hosts.length) return { output: 'Серверов нет.' };
      return {
        output: hosts
          .map((h) => `${h.name} ${h.user}@${h.host}:${h.port}`)
          .join('\n'),
      };
    }

    if (!args?.host) {
      throw new Error('Нужно указать host');
    }

    const host = getHost(cfg, args.host);
    if (!host) {
      throw new Error(`Сервер «${args.host}» не найден`);
    }

    if (!args.command) {
      return { output: `Сервер ${host.name}: ${host.user}@${host.host}:${host.port}` };
    }

    return { output: `SSH не реализован: ${args.command}` };
  },
};
