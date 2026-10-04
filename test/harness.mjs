/**
 * 测试用宿主：把真实的会话事件喂给 review-mode 插件，取出它会生成的复审提示词。
 *
 * 这样测的是**真代码 + 真数据**，不是再抄一份逻辑。
 */
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 逐帧解压拼接的 zstd 日志（假 magic 靠解压失败合并排除）。 */
function decompressLog(file) {
  const raw = fs.readFileSync(file);
  const offsets = [];
  let idx = raw.indexOf(MAGIC, 0);
  while (idx !== -1) { offsets.push(idx); idx = raw.indexOf(MAGIC, idx + 4); }
  const parts = [];
  let i = 0;
  while (i < offsets.length) {
    let advanced = false;
    for (let j = i + 1; j <= offsets.length && !advanced; j += 1) {
      const end = j < offsets.length ? offsets[j] : raw.length;
      try { parts.push(zlib.zstdDecompressSync(raw.subarray(offsets[i], end))); i = j; advanced = true; } catch { /* 假 magic */ }
    }
    if (!advanced) i += 1;
  }
  return Buffer.concat(parts).toString('utf8');
}

const WORKSPACE_SLUG = '--tmp-review-fixture-workspace--';

/**
 * 读取一个真实会话的事件、轮次边界与用户指令。
 * @param {string} sessionId - 会话 id。
 * @returns {{events: object[], turns: object[], users: object[]}} 会话数据。
 */
export function loadSession(sessionId) {
  const dir = path.join(os.homedir(), '.dsh', 'sessions', WORKSPACE_SLUG, `session-${sessionId}`);
  const file = fs.readdirSync(dir).find((name) => name.startsWith('session.v') && name.endsWith('.jsonl.zstd'));
  const text = decompressLog(path.join(dir, file));
  const events = text.split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const turns = [];
  const users = [];
  let cur = null;
  for (const e of events) {
    if (e.type === 'turn/start') cur = { turn: e.data.turn, start: e.seq, calls: 0, errors: 0, end: null };
    if (e.type === 'user/message' && e.data?.source?.kind === 'user') {
      const message = { seq: e.seq, turn: cur?.turn ?? 0, text: (e.data.content ?? []).map((b) => b.text ?? '').join('') };
      users.push(message);
      if (cur) cur.turnUser = message.text;
    }
    if (!cur) continue;
    if (e.type === 'tool/call') cur.calls += 1;
    if (e.type === 'tool/result' && (e.data?.message?.isError || e.data?.error)) cur.errors += 1;
    if (e.type === 'turn/end') { cur.end = e.seq; cur.reason = e.data?.reason?.kind; turns.push(cur); cur = null; }
  }
  return { events, turns, users, lastSeq: events[events.length - 1]?.seq ?? 0 };
}

/**
 * 造一个假宿主，让插件的 runReview 真正跑起来，并把生成的提示词截下来。
 * @param {object} mod - review-mode 模块。
 * @param {object} opts - events、截止 seq、进度、配置、复审回复、提示词回调。
 * @returns {object} 捕获结果与触发函数。
 */
export function makeHost(mod, opts) {
  const captured = { prompt: '', startRequest: null, injected: null, logs: [] };
  let progressState = opts.progress ?? { turn: 0, toolCalls: 0, totalToolCalls: 0, reviews: 0, history: [], last: null };
  const handlers = new Map();
  const events = opts.events;
  const upto = opts.uptoSeq;
  const agent = {
    id: 'sess-real',
    injected: null,
    session: {
      header: { id: 'sess-real', cwd: '/tmp/review-fixture/Documents/deepseek-harness/default-workspace' },
      seq: upto,
      snapshotEvents: (from, to) => events.filter((e) => e.seq >= from && e.seq < to),
    },
    inject: (message) => { agent.injected = message; captured.injected = message; },
  };
  const ctx = {
    logger: { warn: (...a) => captured.logs.push(a.map(String).join(' ')), info: () => {} },
    // cordis 的 `Service` 构造里会调 `ctx.reflect.provide(name, this, ...)`。
    // 缺了它，`new ReviewRemote(ctx)` 会抛 "reading 'provide' of undefined"，
    // 被 index.js 的 try/catch 兜住后只留一行 WARN —— 看着像真 bug，其实只是测试替身少个字段。
    reflect: { provide: () => {}, get: () => undefined },
    effect: (fn) => fn(),
    on: (name, fn) => handlers.set(name, fn),
    sessionProjections: {
      register: (def) => { captured.projection = def; return () => {}; },
      stateOf: (session, key) => {
        if (key === 'agentPreset') return opts.preset ?? 'review';
        if (key === 'reviewMode') return progressState;
        return undefined;
      },
    },
    subagents: {
      start: async (name, req) => {
        captured.prompt = req.prompt.map((b) => b.text).join('\n');
        captured.startRequest = req;
        if (opts.onPrompt) opts.onPrompt(captured.prompt);
        return {
          id: 'child-real',
          localAgent: undefined,
          result: Promise.resolve({ output: [{ type: 'text', text: opts.reviewText ?? '结论: on-track\n一句话: ok' }], stopReason: 'completed' }),
          dispose: async () => {},
        };
      },
    },
    agents: { get: (id) => (id === agent.id ? agent : undefined), withoutInitiator: (op) => op() },
  };
  mod.apply(ctx, opts.config ?? {});
  return {
    agent,
    captured,
    /** 换一份进度状态（用于驱动台账链条）。 */
    setProgress: (next) => { progressState = next; },
    /**
     * 触发某一轮的收尾复审，并等到提示词真的被生成。
     *
     * 不能只 sleep 一个固定时长：`buildCodexDigest` 要读几十个 rollout 文件，
     * 真实耗时是几百毫秒量级。这里等 `onPrompt` 回调，超时才放弃。
     */
    fire: async (turn, timeoutMs = 20000) => {
      let resolve;
      const arrived = new Promise((r) => { resolve = r; });
      const previous = opts.onPrompt;
      opts.onPrompt = (text) => { previous?.(text); resolve(text); };
      handlers.get('agent/turn-stopping')({ agent, turn, signal: new AbortController().signal });
      const text = await Promise.race([arrived, new Promise((r) => setTimeout(() => r(''), timeoutMs))]);
      opts.onPrompt = previous;
      return text;
    },
  };
}

/**
 * 测试用的**自适应分析**输出（2026-10 起复审员写的就是这个形状）。
 *
 * 上一版是一张「每次都一模一样」的 3×3 表格，已被用户推翻（「我感觉有点呆吧」；
 * 「分析没有必要一定按照三个选项」）。现在固定的是**四个锚点**，条数自由。
 * 这里只做一件事：把 sentinel 塞进四段，方便测试断言「是这一条的内容」。
 * @param {object} opts - `{verdict, headline, dialog, summary, analysis, advice}`。
 * @returns {string} 复审输出原文。
 */
export function analysisReviewText(opts = {}) {
  const lines = [
    `结论: ${opts.verdict ?? 'drifting'}`,
    `一句话: ${opts.headline ?? '一句话哨兵'}`,
    '## 具体对话',
    ...(opts.dialog ?? ['你说：「对话哨兵」']).map((item) => `- ${item}`),
    '## 对话概述',
    opts.summary ?? '概述哨兵',
    '## 分析',
    ...(opts.analysis ?? ['分析哨兵']).map((item) => `- ${item}`),
    '## 建议',
    ...(opts.advice ?? ['建议哨兵']).map((item) => `- ${item}`),
  ];
  return lines.join('\n');
}

/**
 * 用一个已注册的投影定义，把一条复审结论折进状态（模拟「上一轮结论进入台账」）。
 * @param {object} projection - 投影定义。
 * @param {object} state - 当前状态。
 * @param {object} review - 复审结论。
 * @returns {object} 新状态。
 */
export function foldReview(projection, state, review) {
  return projection.apply(state, {
    type: 'agent/inbox/spliced',
    data: { target: 'next-step', start: 0, inserted: [{ id: `r${review.turn}`, source: { kind: 'review-mode', review } }] },
  });
}
