import test from 'node:test';
import assert from 'node:assert/strict';
import { textExcerpt, formatCompletion } from '../format.js';
import { apply } from '../index.js';

function simulate(config = {}) {
  const handlers = new Map();
  const sent = [];
  const ctx = {
    on: (name, fn) => handlers.set(name, fn),
    sessionProjections: { stateOf: () => ({ questions: { active: [] } }) },
    workingDirectory: { get: () => '/home/example/projects/研究&试验' },
  };
  const stop = apply(ctx, config, { delivery: { enqueue: (message) => { sent.push(message); return true; }, stop() {} } });
  return { sent, stop, event: (session, type, data, time = Date.UTC(2026, 9, 31, 7, 0, 0)) =>
    handlers.get('session/event')(session, { type, data, time }) };
}

test('summary removes links and common credentials, bounds unicode excerpts', () => {
  const content = [{ type: 'text', text: '密钥 password="secret-value"；链接 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=hidden-key；Bearer abc.def; 😄😄😄' }, { type: 'image', url: 'never sent' }];
  const preview = textExcerpt(content, 180);
  assert.equal(preview, '[内容可能含敏感信息，摘要已省略]');
  assert.doesNotMatch(preview, /secret-value|hidden-key|abc\.def|never sent/);
  for (const candidate of [
    '{"api_key":"FAKE_PRIVATE_KEY_VALUE","password":"FAKE_PASSWORD_VALUE"}',
    'OPENAI_API_KEY=FAKE_PRIVATE_KEY_VALUE', 'token: FAKE_TOKEN_VALUE',
    'ftp://alice:FAKEPASS@example.org/private', 'mailto:alice@example.org?subject=private',
    'file:///home/example/private-plan', '/home/example/private-plan',
    'C:\\Users\\example\\Documents\\private-plan', 'www.example.org/private?key=FAKEVALUE',
    '我的密码是 FAKE_PASSWORD', 'alice@example.org',
  ]) {
    assert.equal(textExcerpt([{ type: 'text', text: candidate }], 200), '[内容可能含敏感信息，摘要已省略]');
  }
  assert.equal(textExcerpt([{ type: 'text', text: '😄'.repeat(700) }], 200).endsWith('…'), true);
  assert.equal(textExcerpt([{ type: 'image', url: 'hidden' }], 200), '');
  const msg = formatCompletion({ time: Date.UTC(2026, 9, 31, 7, 0, 0), cwd: '/home/example/projects/研究&试验', sessionId: '01a18ade-e5e5-4444-aaaa-789a1ea0', turn: 12, prompt: '解释问题', response: '简短回答' });
  assert.match(msg, /2026-10-31 15:00:00 UTC\+08/);
  assert.match(msg, /会话 \/ 轮次：01a18ade…1ea0 \/ 12/);
  assert.doesNotMatch(msg, /\/home\/example/);
  const huge = formatCompletion({ time: 0, cwd: `/root/${'学'.repeat(64)}`, sessionId: '01a18ade-e5e5-4444-aaaa-789a1ea0', turn: Number.MAX_SAFE_INTEGER, prompt: '&amp;'.repeat(200), response: '&amp;'.repeat(500) });
  assert.ok(Buffer.byteLength(huge, 'utf8') <= 3900);
  assert.match(huge, /摘要过长已省略/);
});

test('explicit opt-in sends recent real task and final text, not tool/system messages', () => {
  const h = simulate({ includeExcerpts: true });
  const session = { id: '01a18ade-e5e5-4444-aaaa-789a1ea0', header: { cwd: '/old/path' } };
  h.event(session, 'turn/start', { turn: 7 });
  h.event(session, 'user/message', { source: { kind: 'system' }, content: [{ type: 'text', text: 'System secret' }] });
  h.event(session, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '老师问 40T 是什么？' }] });
  h.event(session, 'assistant/message', { turn: 7, message: { content: [{ type: 'text', text: '中间推理提示' }] } });
  h.event(session, 'assistant/message', { turn: 7, message: { content: [{ type: 'tool-call', name: 'bash' }] } });
  h.event(session, 'assistant/message', { turn: 7, message: { content: [{ type: 'text', text: '最终回复：需区分 40 TOPS 与 TFLOPS。' }] } });
  h.event(session, 'turn/end', { turn: 7, reason: { kind: 'completed' } });
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /老师问 40T 是什么/);
  assert.match(h.sent[0], /最终回复：需区分/);
  assert.match(h.sent[0], /目录：研究试验/);
  assert.doesNotMatch(h.sent[0], /System secret|中间推理提示|\/old\/path|\/home\/example/);
  h.stop();
});

test('no preview without opt-in; interrupted and stale turn data never appear', () => {
  const h = simulate();
  const session = { id: 'safe-session', header: {} };
  h.event(session, 'turn/start', { turn: 1 });
  h.event(session, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'private old task' }] });
  h.event(session, 'turn/end', { turn: 1, reason: { kind: 'aborted' } });
  h.event(session, 'turn/start', { turn: 2 });
  h.event(session, 'turn/end', { turn: 2, reason: { kind: 'completed' } });
  assert.deepEqual(h.sent, ['【DSH】本轮任务已完成\n请返回 DSH 查看结果。']);
  h.stop();
  const opted = simulate({ includeExcerpts: true });
  opted.event(session, 'turn/end', { turn: 3, reason: { kind: 'completed' } });
  assert.match(opted.sent[0], /未捕获文字任务/);
  assert.doesNotMatch(opted.sent[0], /private old task/);
  opted.event(session, 'turn/start', { turn: 4 });
  opted.event(session, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'older text' }] });
  opted.event(session, 'user/message', { source: { kind: 'user' }, content: [{ type: 'image', data: 'not shared' }] });
  opted.event(session, 'assistant/message', { turn: 4, message: { content: [{ type: 'text', text: 'intermediate reply' }] } });
  opted.event(session, 'assistant/message', { turn: 4, message: { content: [{ type: 'tool-call', name: 'bash' }] } });
  opted.event(session, 'turn/end', { turn: 4, reason: { kind: 'completed' } });
  assert.match(opted.sent[1], /本回合未捕获文字任务/);
  assert.match(opted.sent[1], /本回合未捕获文字回复/);
  assert.doesNotMatch(opted.sent[1], /older text|intermediate reply|not shared/);
  opted.stop();
});
