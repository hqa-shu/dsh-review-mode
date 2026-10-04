/**
 * 流式复审的证明：**表格一行一行长出来，而不是最后一次性冒出来**。
 *
 * 用户的原话：「这些全集左边右边又有界面不断流式，自动生成这样一个表格……它自动生成评价」。
 *
 * 链路（都是真代码，只有宿主是替身）：
 *   `agent/assistant-stream` 的帧 → 按 subagent id 认领 → 每成型一行就
 *   `agent.inject(form:'stream')` → 投影折出 `stream.table` → 客户端照常量渲染。
 *
 * 这个测试**不依赖 Electron**，但也不能证明真实宿主真的把子 Agent 的帧派给了根作用域的
 * 监听器 —— 那要重启后看。它证明的是：只要帧到了，增量就是真的（>1 个中间状态）。
 */

import { listCodex, readCodex, setTarget } from '../reviewer.js';
import { analysisReviewText } from './harness.mjs';

let failed = 0;
const check = (label, pass, extra = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  ${extra}`}`);
  if (!pass) failed += 1;
};

// 找一条真实的 0 句对话（顺带证明 0 句在 conversation 线上照样能流式审）。
const all = listCodex(1000);
let picked = null;
for (const entry of all) {
  const read = readCodex(entry);
  if (read.askCount === 0 && read.otherCount > 0 && read.did.length > 0) { picked = entry; break; }
}
check('找到一条可审的真实对话', picked !== null, picked === null ? '（真实数据里没有）' : `→ ${picked.id.slice(0, 24)}`);
if (picked === null) { console.log('\n1 项失败'); process.exit(1); }
setTarget({ kind: 'codex', id: picked.id, lane: 'conversation' });

const FULL = analysisReviewText({
  verdict: 'drifting',
  headline: '你从整理滑到转格式',
  dialog: ['你：「先转格式」'],
  summary: '整条往返偏了。',
  analysis: ['在页码上转了两轮。', '没先确认页码口径，站不住。'],
  advice: ['[给用户] 先把页码口径写死。', '[给Agent] 先给 3 份样例对照。'],
});

// 假宿主：收事件处理器、收投影定义、收 inject。
const handlers = new Map();
const agent = {
  id: 'review-1',
  session: { header: { id: 'review-1', cwd: '/w' }, seq: 10, snapshotEvents: () => [] },
  injects: [],
  inject(m) { this.injects.push(m); },
};
let started = null;
let startCount = 0;
let resolveResult = null;
const resultPromise = new Promise((resolve) => { resolveResult = resolve; });
let projection = null;

const timers = [];
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms) => { const id = realSetInterval(fn, ms); timers.push(id); return id; };

const mod = await import(new URL('../index.js', import.meta.url).pathname);
mod.apply({
  logger: { warn: (...a) => console.log('WARN', ...a.map(String)), info() {} },
  reflect: { provide: () => {}, get: () => undefined },
  effect: (fn) => fn(),
  on: (name, fn) => { handlers.set(name, fn); },
  sessionProjections: {
    register: (def) => { projection = def; return () => {}; },
    stateOf: (s, k) => (k === 'agentPreset' ? 'review' : undefined),
  },
  subagents: {
    start: async (name, req) => {
      startCount += 1;
      if (started === null) started = req;
      return { id: 'rev-1', localAgent: undefined, result: resultPromise, dispose: async () => {} };
    },
  },
  agents: { list: () => [agent], get: () => agent, withoutInitiator: (o) => o() },
}, { watchIntervalMs: 5000, codexWindowHours: 720 });

check('宿主注册了 agent/assistant-stream 监听器', typeof handlers.get('agent/assistant-stream') === 'function');
const emit = handlers.get('agent/assistant-stream') ?? (() => {});
const frame = (f) => emit({ agent: { id: 'rev-1' }, frame: f });
const delta = (text) => frame({ type: 'chunk', chunk: { type: 'text-delta', index: 0, text } });

console.log('等待监控器派单（最多 12 秒）…');
for (let i = 0; i < 24 && started === null; i += 1) await new Promise((r) => setTimeout(r, 500));
check('监控器派出了复审子 Agent（拿到了流式缓冲的 key）', started !== null);
if (started === null) { console.log('\n2 项失败'); process.exit(1); }
await new Promise((r) => setTimeout(r, 150));   // 等 streams.set 落定

// 逐段喂帧：结论 + 领先行 → 具体对话 → 对话概述 → 分析 → 建议。
// 现在的推送粒度是**段落**（旧版是表格行），所以一段成型就推一次。
frame({ type: 'start' });
delta('结论: drifting\n一句话: 你从整理滑到转格式\n');
const streamCounts = [];
const CHUNKS = [
  '## 具体对话\n- 你：「先转格式」\n',
  '## 对话概述\n整条往返偏了。\n',
  '## 分析\n- 在页码上转了两轮。\n',
  '## 建议\n- [给用户] 先把页码口径写死。\n',
];
for (const chunk of CHUNKS) {
  delta(chunk);
  const pushed = agent.injects.filter((m) => m.source?.form === 'stream');
  streamCounts.push(pushed.length);
}
frame({ type: 'end', outcome: { kind: 'committed' } });

const streamMsgs = agent.injects.filter((m) => m.source?.form === 'stream');
check('流式帧被按 subagent id 认领并增量注入（>1 次）', streamMsgs.length > 1, `→ ${streamMsgs.length} 次`);
check('每个成型的新段落都推了一次（4 段 → 4 次）', streamMsgs.length === 4,
  `→ ${streamCounts.join(',')}`);
check('推的是分析正文，且内容逐次变多',
  streamMsgs.length >= 2
  && String(streamMsgs[0].content?.[0]?.text ?? '').length < String(streamMsgs[streamMsgs.length - 1].content?.[0]?.text ?? '').length);

// 把这些流式通知折进投影：必须看到 >1 个**不同的**中间状态，且形状永远是常量那张表。
let state = projection.init(agent.session.header, 0);
const seen = [];
let seq = 1;
for (const message of streamMsgs) {
  state = projection.apply(state, { type: 'agent/inbox/spliced', seq: seq++, data: { inserted: [message] } });
  seen.push(JSON.stringify([state.stream.analysis, state.stream.advice, state.stream.summary]));
}
const unique = new Set(seen);
check('投影折出了 >1 个不同的中间状态（不是最后一次才有）', unique.size > 1, `→ ${unique.size} 个不同状态`);
check('每个中间状态都带四个锚点（形状 = 常量，条数随进度增长）',
  seen.every((snapshot) => {
    const [analysis, advice, summary] = JSON.parse(snapshot);
    return Array.isArray(analysis) && Array.isArray(advice) && typeof summary === 'string';
  }));
check('中间状态里 stream.lane 是这条线', state.stream?.lane === 'conversation', `→ ${String(state.stream?.lane)}`);

// 收口：最终结论（notice）落进 feed，并清掉流式半成品。
resolveResult({ output: [{ type: 'text', text: FULL }] });
for (let i = 0; i < 20 && !agent.injects.some((m) => m.source?.form !== 'stream'); i += 1) {
  await new Promise((r) => setTimeout(r, 200));
}
// **没有新的用户消息就不审**：再多等一个 tick（检测间隔 5 秒），派单数必须还是 1。
const beforeIdle = startCount;
await new Promise((r) => setTimeout(r, 6000));
check('没有新的用户消息 → 不再产生新评价（派单数不涨）', startCount === beforeIdle,
  `→ ${beforeIdle} → ${startCount}`);
for (const id of timers) clearInterval(id);

const finalMsg = agent.injects.find((m) => m.source?.form !== 'stream');
check('最终结论也注入了父会话（收口）', finalMsg !== undefined);
if (finalMsg !== undefined) {
  state = projection.apply(state, { type: 'agent/inbox/spliced', seq: 999, data: { inserted: [finalMsg] } });
  check('收口后 stream 半成品被清掉（完成品不并存）', state.stream === null);
  check('收口后 feed 多了一张带四段分析的卡片',
    state.feed.length === 1 && Array.isArray(state.feed[0].sections) && state.feed[0].sections.length === 4
    && state.feed[0].headline === '你从整理滑到转格式'
    && state.feed[0].analysis.length === 2 && state.feed[0].advice.length === 2,
    `→ feed=${state.feed.length}`);
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
