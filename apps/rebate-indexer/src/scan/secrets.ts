import { execFile } from 'node:child_process';

export type SecretReader = (service: string) => Promise<string | null>;

// Reads a generic password from the macOS Keychain. Never logs the value.
export const keychainReader: SecretReader = (service) =>
  new Promise((resolve) => {
    execFile('security', ['find-generic-password', '-s', service, '-w'], (err, stdout) =>
      resolve(err ? null : stdout.trim() || null));
  });

const CLEMENT_CHAT_ID = '735726338';

export async function loadAlchemyEnv(read: SecretReader = keychainReader): Promise<string> {
  const fromEnv = process.env.ALCHEMY_API_KEY;
  if (fromEnv) return fromEnv;
  const k = await read('alchemy-api-key');
  if (!k) throw new Error('no Alchemy key: set ALCHEMY_API_KEY or add keychain item "alchemy-api-key"');
  process.env.ALCHEMY_API_KEY = k;
  return k;
}

export async function loadTelegramEnv(read: SecretReader = keychainReader): Promise<boolean> {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    const t = await read('ophis-telegram-bot');
    if (!t) return false;
    process.env.TELEGRAM_BOT_TOKEN = t;
  }
  if (!process.env.TELEGRAM_CHAT_ID) process.env.TELEGRAM_CHAT_ID = CLEMENT_CHAT_ID;
  return true;
}
