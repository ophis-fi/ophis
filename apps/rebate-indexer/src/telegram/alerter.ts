import { logger } from '../logger.js';

const log = logger.child({ module: 'telegram' });

const TELEGRAM_API = (token: string, method: string) =>
  `https://api.telegram.org/bot${token}/${method}`;

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;                          // '735726338' = Clement DM

export async function notify(text: string): Promise<void> {
  if (!TOKEN || !CHAT_ID) {
    log.debug({ text }, 'telegram disabled; would have sent');
    return;
  }
  try {
    const res = await fetch(TELEGRAM_API(TOKEN, 'sendMessage'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    if (!res.ok) {
      log.warn({ status: res.status, body: await res.text() }, 'telegram send failed');
    }
  } catch (err) {
    log.warn({ err }, 'telegram send threw');
  }
}

export const alerts = {
  nightlyComplete(stats: { newTrades: number; volumeUsd: number }) {
    return notify(`✅ <b>Nightly index complete</b>\n${stats.newTrades} new trades · $${stats.volumeUsd.toLocaleString()} volume`);
  },
  batchReady(args: { cycle: string; pool: string; count: number; safeQueueUrl: string; topRecipient: string }) {
    return notify(
      `💸 <b>Rebate batch ${args.cycle} ready to sign</b>\n` +
      `Pool: ${args.pool} WETH · ${args.count} recipients\n` +
      `Top: ${args.topRecipient}\n` +
      `<a href="${args.safeQueueUrl}">Open Safe queue →</a>`,
    );
  },
  batchUnsigned(days: number, cycle: string) {
    return notify(`⏰ <b>Batch ${cycle} unsigned for ${days} days</b> — please review the Safe queue.`);
  },
  batchExecuted(args: { cycle: string; pool: string; count: number; txHash: string }) {
    return notify(
      `🟢 <b>Batch ${args.cycle} executed</b>\n` +
      `${args.pool} WETH to ${args.count} wallets\n` +
      `<a href="https://gnosisscan.io/tx/${args.txHash}">Gnosisscan →</a>`,
    );
  },
  alert(scope: string, message: string) {
    return notify(`🚨 <b>ALERT:</b> ${scope}\n${message}`);
  },
};
