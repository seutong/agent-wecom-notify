import { constants, promises as fs } from 'node:fs';

// A webhook URL is a bearer secret. Keep it out of thrown errors, logs and patch YAML.
export async function readWebhook(filename) {
  if (typeof filename !== 'string' || !filename.startsWith('/')) throw new Error('invalid secret path');
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
        stat.size > 2048) throw new Error('unsafe secret file');
    const raw = (await handle.readFile({ encoding: 'utf8' })).trim();
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.hostname !== 'qyapi.weixin.qq.com' ||
        url.port || url.username || url.password || url.hash ||
        url.pathname !== '/cgi-bin/webhook/send' ||
        [...url.searchParams.keys()].join(',') !== 'key' ||
        !/^[A-Za-z0-9-]{16,128}$/.test(url.searchParams.get('key') ?? '')) {
      throw new Error('invalid webhook URL');
    }
    return url.toString();
  } finally {
    await handle.close();
  }
}

export function createDelivery({ webhookFile, timeoutMs = 3000 }, {
  fetchImpl = globalThis.fetch,
  readSecret = readWebhook,
  warn = () => {},
} = {}) {
  let chain = Promise.resolve();
  let queued = 0;
  let stopped = false;
  let warned = false;
  const controllers = new Set();
  async function post(content, relevant) {
    if (stopped || !relevant()) return;
    let url;
    try {
      url = await readSecret(webhookFile);
      warned = false;
    } catch {
      if (!warned && !stopped) warn('WeCom webhook missing or unsafe; notifications disabled until corrected');
      warned = true;
      return;
    }
    if (stopped || !relevant()) return;
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ msgtype: 'markdown', markdown: { content } }),
        signal: controller.signal,
        redirect: 'error',
      });
      if (!response.ok || (await response.json()).errcode !== 0) throw new Error('delivery rejected');
    } catch {
      if (!stopped) warn('WeCom delivery failed'); // Never log URL, body, or upstream response.
    } finally {
      clearTimeout(timer);
      controllers.delete(controller);
    }
  }
  return {
    enqueue(content, relevant = () => true) {
      if (stopped || queued >= 32) return false;
      queued += 1;
      chain = chain.then(() => post(content, relevant)).catch(() => {
        if (!stopped) warn('WeCom delivery failed');
      }).finally(() => { queued -= 1; });
      return true;
    },
    stop() {
      stopped = true;
      for (const controller of controllers) controller.abort();
    },
    async drained() { await chain; },
  };
}
