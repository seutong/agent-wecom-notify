import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDelivery, readWebhook } from '../transport.js';
import { apply } from '../index.js';

const webhook = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=12345678-1234-1234-1234-123456789abc';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function harness(config = {}) {
  const handlers = new Map();
  const sent = [];
  const active = new Set();
  const delivery = { enqueue: (message) => { sent.push(message); return true; }, stop() {} };
  const sessionProjections = { stateOf: () => ({ questions: { active: [...active].map((callId) => ({ callId })) } }) };
  const stop = apply({ on: (name, fn) => handlers.set(name, fn), sessionProjections }, config, { delivery });
  return { sent, active, stop, event: (session, type, data) => handlers.get('session/event')(session, { type, data }),
    question: (request, next) => handlers.get('user-questions/request')(request, next) };
}

test('private webhook accepts only a locked-down WeCom URL file', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-wecom-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'secret');
  await writeFile(file, webhook, { mode: 0o600 });
  assert.equal(await readWebhook(file), webhook);
  await chmod(file, 0o644);
  await assert.rejects(readWebhook(file));
  await chmod(file, 0o600);
  for (const invalid of [
    webhook.replace('qyapi.weixin.qq.com', 'qyapi.weixin.qq.com.evil.invalid'),
    webhook.replace('https:', 'http:'),
    webhook + '&anything=1',
  ]) {
    await writeFile(file, invalid);
    await assert.rejects(readWebhook(file));
  }
  await writeFile(file, webhook);
  await symlink(file, join(dir, 'symlink'));
  await assert.rejects(readWebhook(join(dir, 'symlink')));
});

test('delivery sends expected format, never leaks secret on failure, stops cleanly', async () => {
  const warnings = [];
  const posts = [];
  const delivery = createDelivery({ webhookFile: '/unused' }, {
    readSecret: async () => webhook,
    fetchImpl: async (url, request) => { posts.push([url, request]); return { ok: true, json: async () => ({ errcode: 0 }) }; },
    warn: (message) => warnings.push(message),
  });
  delivery.enqueue('完成');
  await delivery.drained();
  assert.equal(posts.length, 1);
  assert.equal(posts[0][0], webhook);
  assert.equal(JSON.parse(posts[0][1].body).markdown.content, '完成');
  assert.equal(posts[0][1].redirect, 'error');
  delivery.stop();
  assert.equal(delivery.enqueue('no'), false);
  const failing = createDelivery({ webhookFile: '/unused' }, {
    readSecret: async () => webhook,
    fetchImpl: async () => { throw new Error(webhook); },
    warn: (message) => warnings.push(message),
  });
  failing.enqueue('no secret in log');
  await failing.drained();
  assert.ok(warnings.some((message) => message.includes('delivery failed')));
  assert.ok(!warnings.join('').includes('key='));
});

test('queued reminders are discarded if their approval is already decided', async () => {
  const posts = [];
  let release;
  const firstResponse = new Promise((resolve) => { release = resolve; });
  const delivery = createDelivery({ webhookFile: '/unused' }, {
    readSecret: async () => webhook,
    fetchImpl: async (_url, request) => {
      posts.push(JSON.parse(request.body).markdown.content);
      if (posts.length === 1) await firstResponse;
      return { ok: true, json: async () => ({ errcode: 0 }) };
    },
  });
  delivery.enqueue('first');
  await wait(5);
  let pending = true;
  delivery.enqueue('stale approval', () => pending);
  delivery.enqueue('stale answered question', () => pending);
  pending = false;
  release();
  await delivery.drained();
  assert.deepEqual(posts, ['first']);
  delivery.stop();
});

test('completion only for completed turns; fast approvals do not alert', async () => {
  const h = harness({ delayMs: 200 });
  const session = {};
  h.event(session, 'turn/end', { turn: 1, reason: { kind: 'aborted' } });
  h.event(session, 'turn/end', { turn: 2, reason: { kind: 'completed' } });
  h.event(session, 'turn/end', { turn: 2, reason: { kind: 'completed' } });
  h.event(session, 'approval/asked', { id: 'fast' });
  h.event(session, 'approval/decided', { id: 'fast', outcome: 'rejected' });
  await wait(250);
  assert.equal(h.sent.length, 1);
  h.event(session, 'approval/asked', { id: 'slow' });
  await wait(250);
  assert.equal(h.sent.length, 2);
  h.event(session, 'approval/decided', { id: 'slow', outcome: 'allowed-once' });
  h.stop();
});

test('question waterfall retains answer/errors and alerts only while pending', async () => {
  const h = harness({ delayMs: 200 });
  assert.equal(await h.question({ questions: [{ id: 'q' }] }, async () => 'answer'), 'answer');
  await wait(220);
  assert.equal(h.sent.length, 0);
  let finish;
  const pending = h.question({ questions: [{ id: 'q' }] }, () => new Promise((resolve) => { finish = resolve; }));
  await wait(230);
  assert.equal(h.sent.length, 1);
  finish('later');
  assert.equal(await pending, 'later');
  await assert.rejects(h.question({ questions: [] }, async () => { throw new Error('test-error'); }), /test-error/);
  h.stop();
});

test('timed questions follow durable pending state, including NO_PROVIDER and ASK_ABORTED', async () => {
  const h = harness({ delayMs: 200 });
  const session = {};
  const noProvider = Object.assign(new Error('unavailable'), { code: 'NO_PROVIDER' });
  h.active.add('short');
  h.event(session, 'tool/call', { name: 'ask_user_question', callId: 'short' });
  await assert.rejects(h.question({ questions: [{ id: 'q' }], wait: { timed: true, callId: 'short' } },
    async () => { throw noProvider; }), (error) => error === noProvider);
  await wait(230);
  assert.equal(h.sent.length, 1, 'question still active after foreground NO_PROVIDER');
  const aborted = Object.assign(new Error('foreground abort'), { code: 'ASK_ABORTED' });
  h.active.add('ptc');
  h.event(session, 'tool/ptc-dispatch', { name: 'ask_user_question', subCallId: 'ptc' });
  await assert.rejects(h.question({ questions: [{ id: 'q' }], wait: { timed: true, callId: 'ptc' } },
    async () => { throw aborted; }), (error) => error === aborted);
  await wait(230);
  assert.equal(h.sent.length, 2, 'PTC pending question still active after abort');
  h.active.add('answered');
  h.event(session, 'tool/call', { name: 'ask_user_question', callId: 'answered' });
  h.active.delete('answered');
  await wait(230);
  assert.equal(h.sent.length, 2, 'answered question must not alert');
  h.stop();
});
