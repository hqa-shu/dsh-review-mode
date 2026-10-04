/**
 * **一个用户动作 → 恰好一次评价、恰好一张卡片**（2026-10 用户抓到的那次「两边一起跳」）。
 *
 * 现场：用户原话「我点了之后，**审核面板会跳，对话框那边也会跳，它有相冲突**」。
 * 真因是**同一个用户回合被审了两遍**：
 *   - A 路（主 Agent 在回合里调 `review_conversation` / 面板按钮）**已经**派了一次
 *     directed review（`runDirectedReview`，结果落进 `reviewMode` 投影 → 面板一张卡）；
 *   - 回合干净收尾时，插件的 `agent/turn-stopping` **又**触发一次本会话的通用复审
 *     （`runReview`，整会话 digest）→ 面板第二张卡、对话那边也再动一次。
 *
 * 规则（写死在这里，也写进 FLOW.md 第 8 步）：
 *   **同一个回合（同一个 `turnStartSeq`）里只要已经派过一次 directed 复审，
 *   这一轮收尾的通用复审就跳过。一个动作 = 一次评价 = 一张卡片。**
 * 判据用的是投影里真实的 `turnStartSeq`（`turn/start` 事件的 seq），
 * 所以「回合中间点的按钮」会被去重，「两个回合各点一次」不会被误去重。
 *
 * 反向变异：每一条正向断言都配一个必须变红的对照 ——
 *   · 没有 directed 复审的同一回合 → 通用复审**必须照跑**（证明去重不是「永远不跑」）；
 *   · `turnStartSeq` 前进之后（下一个回合）→ 通用复审**必须照跑**（证明不是一劳永逸地关掉）。
 */

import { analysisReviewText } from './harness.mjs';

let failed = 0;
const check = (label, pass, extra = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  ${extra}`}`);
  if (!pass) failed += 1;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 通用复审（`runReview` → `parseVerdict`）认得的文本。 */
const GENERIC = [
  '结论: on-track',
  '一句话: 通用复审哨兵_这一轮没漂',
  '① 主题漂移: 通用哨兵_没有漂移',
  '② 局部纠结: 无',
  '③ 选择理性: 合理',
  '建议: 继续',
].join('\n');

/** directed 复审（`runDirectedReview` → `parseTableVerdict`）认得的固定表格。 */
const DIRECTED = analysisReviewText({
  verdict: 'drifting',
  headline: 'directed哨兵_主题偏了',
  dialog: ['你说：「方向」→ 对面：「别的」'],
  summary: '整条对话偏了。',
  analysis: ['对面做了别的。'],
  advice: ['收窄范围。'],
});

// ── 假宿主 ────────────────────────────────────────────────
const handlers = new Map();
const appended = [];
const starts = [];
const registeredCommands = new Map();
let projection = null;
let answer = GENERIC;               // 假复审员这一次吐什么
let projState = { turn: 0, toolCalls: 0, turnStartSeq: 0 };
const intervals = [];
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
globalThis.setInterval = (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; };
globalThis.clearInterval = () => {};

const agent = {
  id: 'review-1',
  session: {
    header: { id: 'review-1', cwd: '/w' },
    seq: 100,
    snapshotEvents: () => [],
    append(type, data, opts) { appended.push({ type, seq: this.seq, data, opts }); this.seq += 1; return appended[appended.length - 1]; },
  },
  followups: [],
  injects: [],
  followup(m) { this.followups.push(m); },
  inject(m) { this.injects.push(m); },
};

const indexMod = await import(new URL('../index.js', import.meta.url).pathname);
indexMod.apply({
  logger: { warn: (...a) => console.log('WARN', ...a.map(String)), info() {} },
  reflect: { provide: () => {}, get: () => undefined },
  effect: (fn) => fn(),
  on: (name, fn) => { handlers.set(name, fn); },
  inject: (names, cb) => {
    const scope = {
      names,
      commands: { register(def) { registeredCommands.set(def.name, def); return () => {}; } },
      get: (name) => (name === 'commands' ? scope.commands : undefined),
      effect: (fn) => fn(),
    };
    cb(scope);
  },
  sessionProjections: {
    register: (def) => { projection = def; return () => {}; },
    stateOf: (s, k) => {
      if (k === 'agentPreset') return 'review';
      if (k === 'reviewMode') return projState;
      return undefined;
    },
  },
  subagents: {
    start: async (name, req) => {
      starts.push({ name, req });
      return { id: `rev-${starts.length}`, result: Promise.resolve({ output: [{ type: 'text', text: answer }] }), dispose: async () => {} };
    },
  },
  agents: { list: () => [agent], get: () => agent, withoutInitiator: (o) => o() },
}, { watchIntervalMs: 5000, watchCodex: false, codex: false });

const onTurnStopping = handlers.get('agent/turn-stopping');
check('宿主注册了 agent/turn-stopping（通用复审的入口）', typeof onTurnStopping === 'function');

const command = registeredCommands.get('review-mode');
const runCommand = (line) => command.handler({ agent, rawInput: line, commandId: 'c1', attachments: [], signal: new AbortController().signal });

const fold = () => {
  let state = projection.init(agent.session.header, 0);
  for (const event of appended) state = projection.apply(state, { type: event.type, seq: event.seq, data: event.data });
  return state;
};
const cards = () => fold().feed.filter((entry) => entry?.kind !== 'qa').length;
const reset = (token) => {
  appended.length = 0;
  starts.length = 0;
  projState = { turn: 0, toolCalls: 1, turnStartSeq: token };
};

/* ── 场景 1（对照）：这一回合**没有** directed 复审 → 通用复审必须照跑 ── */
{
  reset(42);
  answer = GENERIC;
  onTurnStopping({ agent, turn: 1 });
  await sleep(30);
  check('对照：回合里没有 directed 复审时，通用复审**照跑**（证明去重不是「永远不审」）',
    starts.length === 1, `starts=${starts.length}`);
  check('对照：通用复审落进投影 1 张卡', cards() === 1, `cards=${cards()}`);
}

/* ── 场景 2（真 bug）：同一回合先派 directed，收尾时通用复审**必须被跳过** ── */
{
  reset(100);
  answer = DIRECTED;
  // 用户在回合中间点了面板方块（`dir self` 由宿主自己派一次 directed 复审）。
  runCommand('dir self');
  await sleep(30);
  check('directed 复审真的派了 1 次（这是用户点了按钮的那一下）', starts.length === 1, `starts=${starts.length}`);
  check('directed 复审已经落进投影 1 张卡', cards() === 1, `cards=${cards()}`);

  // 回合干净收尾 —— 旧的代码在这里会**再**派一次通用复审。
  answer = GENERIC;
  onTurnStopping({ agent, turn: 1 });
  await sleep(30);
  check('**同一个回合**收尾时，通用复审被跳过（一个动作只审一次）',
    starts.length === 1, `starts=${starts.length}（>1 就是用户看到的「两边一起跳」）`);
  check('一个用户动作之后，面板上**恰好一张**卡片（不是两张）', cards() === 1, `cards=${cards()}`);
  check('零 followup / 零 inject（对话区没有因为这次去重多出任何东西）',
    agent.followups.length === 0 && agent.injects.length === 0);
}

/* ── 场景 3（反向变异）：`turnStartSeq` 前进 = 下一个回合 → 通用复审必须照跑 ── */
{
  reset(200);
  answer = DIRECTED;
  runCommand('dir self');           // 回合一：用户点了按钮
  await sleep(30);
  check('回合一：directed 复审派了 1 次', starts.length === 1, `starts=${starts.length}`);

  projState = { turn: 0, toolCalls: 1, turnStartSeq: 201 };  // 新回合开始了
  answer = GENERIC;
  onTurnStopping({ agent, turn: 2 });                        // 回合二收尾
  await sleep(30);
  check('下一个回合（turnStartSeq 前进）收尾时，通用复审**照跑**（去重只对一个回合生效）',
    starts.length === 2, `starts=${starts.length}`);
  check('两个回合、两次动作 → 两张卡（互不吞并）', cards() === 2, `cards=${cards()}`);
}

/* ── 场景 4（反向变异）：token 不变时，第二次收尾也不许再派 ── */
{
  reset(300);
  answer = DIRECTED;
  runCommand('dir self');
  await sleep(30);
  projState = { turn: 0, toolCalls: 1, turnStartSeq: 300 };   // 还是同一个回合
  answer = GENERIC;
  onTurnStopping({ agent, turn: 1 });
  await sleep(30);
  check('反向变异：同一个 turnStartSeq 下重复收尾，通用复审仍然一次都不派',
    starts.length === 1, `starts=${starts.length}`);
}

for (const id of intervals) clearInterval(id);
globalThis.setInterval = realSetInterval;
globalThis.clearInterval = realClearInterval;
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
