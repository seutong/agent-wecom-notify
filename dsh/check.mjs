import { homedir } from 'node:os';
import { join } from 'node:path';
import { readWebhook } from './transport.js';

// Offline readiness check: never print the webhook and never send a request.
const secret = process.env.DSH_WECOM_WEBHOOK_FILE || join(homedir(), '.dsh/secrets/wecom_webhook');
try {
  await readWebhook(secret);
  console.log('私有 Webhook 文件格式、所有者和权限检查通过（未发送消息）。');
} catch {
  console.error('私有 Webhook 文件缺失、权限不安全或 URL 格式错误；未发送消息。');
  process.exitCode = 1;
}
console.log('安装及是否已生效仍须在 DSH 插件管理器查看，离线检查无法证明已启用。');
