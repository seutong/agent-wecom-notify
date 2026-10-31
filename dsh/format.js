// Keep group messages bounded and deliberately omit links, credentials and rich content.
const SHANGHAI_TIME = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

// Treat any text mentioning a credential field or a URL as unsafe to summarize.
// This conservative gate also catches JSON-quoted keys and prefixed env vars.
const SENSITIVE = /\b[a-z][a-z0-9+.-]*:\/\/|\bmailto:|\bwww\.|[?&](?:key|token|password|secret)=|[A-Za-z]:[\\/]|(?:^|[\s('"])(?:\/[A-Za-z0-9_.-]+){2,}|\.env\b|(?:密码|密钥|令牌|凭据|私钥|验证码|身份证)|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|-----BEGIN|\bBearer\b|\b(?:[A-Za-z0-9_-]*(?:api[_-]?key|token|password|passphrase|secret|webhook|authorization|private[_-]?key)|sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{16,})\b/i;

function redact(text) {
  return text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/gi, '[私钥已隐藏]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, '[令牌已隐藏]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{16,})\b/g, '[令牌已隐藏]')
    .replace(/https?:\/\/[^\s<>"'`]+/gi, '[链接已隐藏]')
    .replace(/\b(?:api[_-]?key|access[_-]?token|password|secret|webhook)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '[凭据已隐藏]');
}

export function textExcerpt(content, limit) {
  if (!Array.isArray(content) || !Number.isSafeInteger(limit) || limit < 1) return '';
  const scanLimit = Math.min(16384, Math.max(4096, limit * 16));
  let raw = '';
  let omitted = false;
  for (const block of content) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue;
    const remaining = scanLimit - raw.length;
    if (remaining < 1) { omitted = true; break; }
    const chunk = block.text.slice(0, remaining);
    raw += `${raw ? ' ' : ''}${chunk}`;
    if (chunk.length < block.text.length) { omitted = true; break; }
  }
  if (SENSITIVE.test(raw)) return '[内容可能含敏感信息，摘要已省略]';
  const normalized = redact(raw).replace(/\s+/g, ' ').trim();
  const characters = Array.from(normalized);
  const clipped = omitted || characters.length > limit;
  const excerpt = clipped ? characters.slice(0, limit - 1).join('').trimEnd() + '…' : normalized;
  // HTML and mention syntax must not be interpreted by WeCom markdown.
  return excerpt.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/@/g, '＠');
}

function label(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const safe = value.normalize('NFC').replace(/[^\p{L}\p{N}._ -]/gu, '').trim();
  return safe ? Array.from(safe).slice(0, 64).join('') : fallback;
}

function projectName(cwd) {
  if (typeof cwd !== 'string') return '未提供目录';
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return label(parts.at(-1), '未提供目录');
}

function shortSessionId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{4,128}$/.test(value)) return '未知会话';
  return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

function dateLabel(time) {
  const date = new Date(Number.isFinite(time) ? time : Date.now());
  const pieces = Object.fromEntries(SHANGHAI_TIME.formatToParts(date).map(({ type, value }) => [type, value]));
  return `${pieces.year}-${pieces.month}-${pieces.day} ${pieces.hour}:${pieces.minute}:${pieces.second} UTC+08`;
}

export function formatCompletion({ time, cwd, sessionId, turn, prompt, response }) {
  const project = projectName(cwd);
  const task = prompt || '（本回合未捕获文字任务）';
  const answer = response || '（本回合未捕获文字回复）';
  const turnLabel = Number.isSafeInteger(turn) && turn >= 0 ? String(turn) : '未知轮次';
  const header = `✅ DSH 本轮已结束 · ${project}\n时间：${dateLabel(time)}\n目录：${project}\n会话 / 轮次：${shortSessionId(sessionId)} / ${turnLabel}\n`;
  const footer = '\n\n摘要仅用于提醒；请回到 DSH 查看完整内容。';
  const message = `${header}📝 任务摘要\n${task}\n🤖 最终回复摘要\n${answer}${footer}`;
  // WeCom markdown has a 4096-byte cap; escaping can expand short excerpts.
  if (Buffer.byteLength(message, 'utf8') <= 3900) return message;
  return `${header}📝 任务摘要\n[摘要过长已省略]\n🤖 最终回复摘要\n[摘要过长已省略]${footer}`;
}
