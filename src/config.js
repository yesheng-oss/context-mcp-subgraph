import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const DATA_DIR = process.env.CONTEXT_MCP_DIR || join(homedir(), '.context-mcp');
const CONFIG_PATH = join(DATA_DIR, 'contextconfig.json');
const KEYTAR_SERVICE = 'context-mcp';
const KEYTAR_ACCOUNT = 'client_secret';

const DEFAULTS = {
  client_id: 'context-mcp',
  client_secret: '',
  access_git: false,
  port: 3100,
  host: 'localhost',
};

function generateSecret() {
  return randomBytes(32).toString('hex');
}

async function _keytarGet() {
  try {
    const kt = await import('keytar');
    return kt.default.getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT);
  } catch { return null; }
}

async function _keytarSet(secret) {
  try {
    const kt = await import('keytar');
    await kt.default.setPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT, secret);
    return true;
  } catch { return false; }
}

export function getConfig() {
  let config = { ...DEFAULTS };

  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

  if (existsSync(CONFIG_PATH)) {
    try {
      const stored = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
      config = { ...config, ...stored };
    } catch (err) {
      console.error(`\x1b[91m⚠ Error reading config at ${CONFIG_PATH}: ${err.message}\x1b[0m`);
    }
  }

  // Auto-generate secret if missing
  let dirty = false;
  if (!config.client_secret) {
    config.client_secret = generateSecret();
    dirty = true;
  }

  // Save if new or updated
  if (dirty || !existsSync(CONFIG_PATH)) {
    saveConfig(config);
  }

  return config;
}

export async function getConfigWithKeytar() {
  const config = getConfig();
  const keytarSecret = await _keytarGet();
  if (keytarSecret) config.client_secret = keytarSecret;
  return config;
}

export function saveConfig(config) {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  } catch (err) {
    console.error(`\x1b[91m⚠ Error saving config at ${CONFIG_PATH}: ${err.message}\x1b[0m`);
  }
}

export async function saveSecretToKeytar(secret) {
  return _keytarSet(secret);
}

export function getConfigPath() {
  return CONFIG_PATH;
}
