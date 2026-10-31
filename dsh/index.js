import { createDelivery } from './transport.js';
import { formatCompletion, textExcerpt } from './format.js';

export const inject = ['sessionProjections', 'workingDirectory'];

const MESSAGES = Object.freeze({
  completed: '【DSH】本轮任务已完成\n请返回 DSH 查看结果。',
  approval: '【DSH】有操作等待权限审批\n请返回 DSH 查看并决定；企业微信群内不能直接审批。',
  question: '【DSH】有问题等待你回答\n请返回 DSH 查看并回答。',
  plan: '【DSH】有计划等待你确认\n请返回 DSH 查看并回答。',
});

// Opt-in completion previews can leave the machine; never include tool arguments,
// question details, approval reasons, absolute directory paths, or the webhook URL.
export function apply(ctx, config = {}, testing = {}) {
  const webhookFile = config.webhookFile;
  const delayMs = Number.isSafeInteger(config.delayMs) && config.delayMs >= 200 && config.delayMs <= 5000
    ? config.delayMs : 800;
  const timeoutMs = Number.isSafeInteger(config.timeoutMs) && config.timeoutMs >= 500 && config.timeoutMs <= 10000
    ? config.timeoutMs : 3000;
  const delivery = testing.delivery ?? createDelivery({ webhookFile, timeoutMs }, {
    warn: (message) => console.warn('[dsh-wecom-notify]', message),
  });
  const pending = new WeakMap();
  const seenTurns = new WeakMap();
  const timedCalls = new WeakMap();
  const turnPreviews = new WeakMap(); // Only bounded text from the current turn, never whole transcripts.
  const timers = new Set();
  let disposed = false;

  const schedule = (callback) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!disposed) callback();
    }, delayMs);
    timers.add(timer);
    return timer;
  };
  const cancel = (timer) => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.delete(timer);
    }
  };

  const isTimedQuestionOpen = (session, callId) => {
    try {
      const state = ctx.sessionProjections.stateOf(session, 'userQuestions');
      return state?.questions?.active?.some((entry) => entry.callId === callId) === true;
    } catch {
      return false; // An unavailable projection must never emit an unverified reminder.
    }
  };
  const watchTimedQuestion = (session, callId) => {
    if (config.question === false || typeof callId !== 'string') return;
    const calls = timedCalls.get(session) ?? new Map();
    timedCalls.set(session, calls);
    if (calls.has(callId)) return;
    const timer = schedule(() => {
      calls.set(callId, null); // Retain the identity to prevent repeat alerts.
      if (isTimedQuestionOpen(session, callId)) {
        delivery.enqueue(MESSAGES.question, () => isTimedQuestionOpen(session, callId));
      }
    });
    calls.set(callId, timer);
    if (calls.size > 256) {
      const oldest = calls.keys().next().value;
      cancel(calls.get(oldest));
      calls.delete(oldest);
    }
  };

  ctx.on('session/event', (session, event) => {
    if (disposed) return;
    if (event.type === 'turn/start') {
      turnPreviews.set(session, { turn: event.data?.turn, prompt: '', response: '' });
    } else if (event.type === 'user/message' && event.data?.source?.kind === 'user') {
      const state = turnPreviews.get(session);
      if (state) state.prompt = textExcerpt(event.data.content, 200);
    } else if (event.type === 'assistant/message') {
      const state = turnPreviews.get(session);
      if (state?.turn === event.data?.turn) {
        // A later tool-only message cannot be mislabelled as the final reply.
        state.response = textExcerpt(event.data.message?.content, 500);
      }
    } else if (event.type === 'tool/call' && event.data?.name === 'ask_user_question') {
      watchTimedQuestion(session, event.data.callId);
    } else if (event.type === 'tool/ptc-dispatch' && event.data?.name === 'ask_user_question') {
      watchTimedQuestion(session, event.data.subCallId);
    } else if (event.type === 'approval/asked' && config.approval !== false) {
      const approvals = pending.get(session) ?? new Map();
      pending.set(session, approvals);
      const id = event.data?.id;
      if (typeof id !== 'string' || approvals.has(id)) return;
      const timer = schedule(() => {
        if (approvals.get(id) !== timer) return;
        // Keep the entry until approval/decided: a delayed callback is still pending.
        delivery.enqueue(MESSAGES.approval, () => approvals.has(id));
      });
      approvals.set(id, timer);
    } else if (event.type === 'approval/decided') {
      const approvals = pending.get(session);
      const id = event.data?.id;
      if (typeof id === 'string' && approvals?.has(id)) {
        cancel(approvals.get(id));
        approvals.delete(id);
      }
    } else if (event.type === 'turn/end') {
      const approvals = pending.get(session);
      if (approvals) {
        for (const timer of approvals.values()) cancel(timer);
        approvals.clear();
      }
      const preview = turnPreviews.get(session);
      turnPreviews.delete(session);
      if (config.completion === false || event.data?.reason?.kind !== 'completed') return;
      const turn = event.data.turn;
      if (!Number.isSafeInteger(turn)) return;
      const seen = seenTurns.get(session) ?? new Set();
      seenTurns.set(session, seen);
      if (seen.has(turn)) return;
      seen.add(turn);
      if (seen.size > 64) seen.delete(seen.values().next().value);
      if (config.includeExcerpts !== true) {
        delivery.enqueue(MESSAGES.completed);
        return;
      }
      let cwd = session.header?.cwd;
      try { cwd = ctx.workingDirectory.get(session) ?? cwd; } catch { /* Preserve the reminder. */ }
      delivery.enqueue(formatCompletion({
        time: event.time, cwd, sessionId: session.id, turn,
        prompt: preview?.turn === turn ? preview.prompt : '',
        response: preview?.turn === turn ? preview.response : '',
      }));
    }
  }, { global: true });

  // This is a waterfall: ALWAYS pass the result and errors from next() through unchanged.
  ctx.on('user-questions/request', async (request, next) => {
    // Timed questions are observed through committed tool events and the
    // userQuestions projection; waterfall errors do not describe pending state.
    if (disposed || config.question === false || request.wait?.timed === true) return next();
    const isPlan = request.questions?.some((question) => question.intent?.kind === 'plan-review');
    const message = isPlan ? MESSAGES.plan : MESSAGES.question;
    let waiting = true;
    const timer = schedule(() => {
      if (!request.signal?.aborted) delivery.enqueue(message, () => waiting);
    });
    try {
      return await next();
    } finally {
      cancel(timer);
      waiting = false;
    }
  }, { global: true });

  return () => {
    disposed = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    delivery.stop();
  };
}
