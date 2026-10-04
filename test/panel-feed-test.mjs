/**
 * 新要求的证明：**评价长在面板上，不长在对话记录里**。
 *
 * 用户 2026-10 的原话：「我希望的是就是你审核的结果，每一条审核的结果你都输出，
 * 然后输出在下面，就是下面空着审核那边，然后上面的话，我提问了，你在回答我……
 * 我点进去，你就自动开始审查，并且监控，然后就显示在审核的那个版当中，开始自动输出。」
 *
 * 改前的问题：结论用 `agent.inject(userMessage)` 投递 —— 那条消息会被 Agent 收成
 * `user/message` 面事件，于是**评价直接显示在对话记录（上面）里**，而面板（读
 * `reviewMode` 投影）反而空着。
 *
 * 改后：投递走 `developer/message` 面事件。依据（shipped 源码）：
 *   - 模型看得到：`dsh-session/lib/index.js:154-160` SURFACE_EVENT_TYPES 含它；
 *   - 对话记录**不渲染**：`dsh-client-ui-chat/lib/client.js:9309-9321` 把它变成
 *     `kind:'context'`，而同文件 `:7719` 的 `isVisibleChatNode` 明确排除 context；
 *   - 投影照折：`applyEvent` 的 `developer/message` 分支。
 *
 * 这个测试端到端跑一次真实监控器（真 ~/.codex 数据 + 真定时器），然后证明：
 *   1. 宿主 append 的是 `developer/message`（role=developer、surfaceOp=append）；
 *   2. **一次 `agent.inject` 都没有** —— 评价没有变成对话消息；
 *   3. 折进投影后 `feed` 真的多了一张带固定表格的卡片；
 *   4. 客户端面板在**状态 1**（一进来、没点任何东西）就把它画出来了。
 */

import { listCodex, readCodex, setTarget } from '../reviewer.js';
import { analysisReviewText } from './harness.mjs';

let failed = 0;
const check = (label, pass, extra = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  ${extra}`}`);
  if (!pass) failed += 1;
};

// ── ① 挑一条真实对话（0 句也审，走 conversation 线）────────
const all = listCodex(1000);
let picked = null;
let pickedRead = null;
for (const entry of all) {
  const read = readCodex(entry);
  if (read.askCount === 0 && read.otherCount > 0 && read.did.length > 0) { picked = entry; pickedRead = read; break; }
}
check('找到一条可审的真实对话', picked !== null, picked === null ? '（真实数据里没有）' : `→ ${pickedRead.title}`);
if (picked === null) { console.log('\n1 项失败'); process.exit(1); }
setTarget({ kind: 'codex', id: picked.id, title: pickedRead.title, lane: 'conversation' });

const REVIEW = analysisReviewText({
  verdict: 'drifting',
  headline: '面板哨兵_主题从整理滑到格式',
  dialog: ['你：「整理一下」', '对面：「做成流水线」'],
  summary: '整条对话从整理滑到格式。',
  analysis: ['页码上转了两轮，同一细节来回说。', '没先确认口径。'],
  advice: ['[给用户] 先把页码口径写死。', '[给Agent] 先给样例。'],
});

// ── ② 假宿主：会话**支持 append**（真会话就是这样）────────
const appended = [];
const agent = {
  id: 'review-1',
  session: {
    header: { id: 'review-1', cwd: '/w' },
    seq: 10,
    snapshotEvents: () => [],
    append(type, data, opts) { appended.push({ type, seq: this.seq, data, opts }); this.seq += 1; return appended[appended.length - 1]; },
  },
  injects: [],
  inject(m) { this.injects.push(m); },
};
let projection = null;
const timers = [];
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms) => { const id = realSetInterval(fn, ms); timers.push(id); return id; };

const mod = await import(new URL('../index.js', import.meta.url).pathname);
mod.apply({
  logger: { warn: (...a) => console.log('WARN', ...a.map(String)), info() {} },
  reflect: { provide: () => {}, get: () => undefined },
  effect: (fn) => fn(),
  on: () => {},
  sessionProjections: {
    register: (def) => { projection = def; return () => {}; },
    stateOf: (s, k) => (k === 'agentPreset' ? 'review' : undefined),
  },
  subagents: {
    start: async () => ({ id: 'rev-1', localAgent: undefined, result: Promise.resolve({ output: [{ type: 'text', text: REVIEW }] }), dispose: async () => {} }),
  },
  agents: { list: () => [agent], get: () => agent, withoutInitiator: (o) => o() },
}, { watchIntervalMs: 5000, codexWindowHours: 720 });

console.log('等待监控器触发（最多 15 秒）…');
// 等的是**最终结论**（`notice`），不是「有任何一个事件」—— 复审一开始会先投一条
// `pending`（进度标记），只等 appended 非空会在结论还没落时就往下走。
const hasNotice = () => appended.some((event) => event.data?.source?.form === 'notice');
for (let i = 0; i < 30 && !hasNotice(); i += 1) await new Promise((r) => setTimeout(r, 500));
for (const id of timers) clearInterval(id);

const notices = appended.filter((event) => event.type === 'user/message' && event.data?.source?.form === 'notice');
check('宿主投递了一条 user/message 面事件（**不是** developer/message）', notices.length === 1, `→ ${notices.length} 条`);
check('角色是 user、source.kind 是我们的、surfaceOp=append（面事件，不是对话节点）',
  notices[0]?.data?.role === 'user' && notices[0]?.data?.source?.kind === 'review-mode'
  && notices[0]?.opts?.surfaceOp === 'append',
  JSON.stringify([notices[0]?.data?.role, notices[0]?.data?.source?.kind, notices[0]?.opts?.surfaceOp]));
check('**一次 agent.inject 都没有** —— 评价没有变成对话记录里的消息',
  agent.injects.length === 0, `injects=${agent.injects.length}`);
check('投递的内容里带着结论与四段分析',
  /结论/.test(JSON.stringify(notices[0]?.data?.content ?? []))
  && JSON.stringify(notices[0]?.data?.content ?? []).includes('具体对话')
  && JSON.stringify(notices[0]?.data?.content ?? []).includes('面板哨兵_主题从整理滑到格式'));

// ── ③ 折进投影：feed 多一张卡片 ───────────────────────────
let state = projection.init(agent.session.header, 0);
for (const event of appended) state = projection.apply(state, { type: event.type, seq: event.seq, data: event.data });
check('投影折出了 1 张评价卡片', state.feed.length === 1, `→ feed=${state.feed.length}`);
check('卡片带四段分析 + 领先行（形状 = 常量键出的四个锚点）',
  Array.isArray(state.feed[0]?.sections) && state.feed[0].sections.length === 4
  && typeof state.feed[0]?.headline === 'string' && state.feed[0].headline.length > 0
  && Array.isArray(state.feed[0]?.analysis) && state.feed[0].analysis.length === 2,
  `→ 分析 ${state.feed[0]?.analysis?.length} 条`);
check('卡片里有复审员写的哨兵内容',
  JSON.stringify(state.feed[0]?.analysis ?? {}).includes('页码上转了两轮') 
  && state.feed[0].headline === '面板哨兵_主题从整理滑到格式');

// ── ④ 客户端面板：**一进来（状态 1）就画出来** ─────────────
let cursor = 0;
const stateSlots = [];
let rerender = () => {};
const FakeReact = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } };
  },
  useState(initial) {
    const index = cursor;
    cursor += 1;
    if (!(index in stateSlots)) stateSlots[index] = typeof initial === 'function' ? initial() : initial;
    return [stateSlots[index], (next) => { stateSlots[index] = typeof next === 'function' ? next(stateSlots[index]) : next; rerender(); }];
  },
  useRef(value) { return { current: value }; },
  useEffect() {},
};
let registered = null;
globalThis.window = {
  __ModuleLoader__: { load({ factory }) { registered = factory((spec) => (spec === 'react' ? FakeReact : {})); } },
  localStorage: { getItem: () => null, setItem: () => {} },
  addEventListener() {}, removeEventListener() {},
};
let panel = null;
await import('../client.js');
registered.apply({ remote: {}, slots: { inject: (name, fn) => fn(), register: (meta, component) => { if (meta.name === 'shell.overlay') panel = component; } } });
const props = {
  sessionId: 's1',
  useSessions: (selector) => selector({ byId: { s1: { projectionValues: { agentPreset: 'review', reviewMode: state } } } }),
};
let tree = null;
rerender = () => { cursor = 0; tree = panel(props); };
rerender();
const collect = (node, predicate, out = []) => {
  if (node === null || typeof node !== 'object') return out;
  if (predicate(node)) out.push(node);
  const kids = node.props?.children;
  const list = Array.isArray(kids) ? kids : (kids === undefined ? [] : [kids]);
  for (const kid of list) collect(kid, predicate, out);
  return out;
};
const feedNode = collect(tree, (n) => n.props?.['data-review-feed'] !== undefined)[0];
check('面板**状态 1** 就有常驻的结果区（data-review-feed）', feedNode !== undefined,
  feedNode === undefined ? '（面板结果区没渲染）' : `data-review-feed=${feedNode.props['data-review-feed']}`);
check('结果区写着有几条评价', feedNode !== undefined && feedNode.props['data-review-feed'] === '1',
  String(feedNode?.props?.['data-review-feed']));
const rendered = JSON.stringify(tree);
check('结果区把评价内容画出来了（不是空着只剩诊断）',
  rendered.includes('具体对话') && rendered.includes('面板哨兵_主题从整理滑到格式')
  && rendered.includes('页码上转了两轮'));
check('面板仍然是三个方向按钮的状态 1（feed 与选方向并存）',
  collect(tree, (n) => n.props?.['data-review-direction'] !== undefined).length === 3);

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
