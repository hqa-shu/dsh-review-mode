/**
 * 面板按钮 → 复审的**落点**证明（2026-10 用户抓到的现场失败）。
 *
 * 症状：用户在对话里看到整张评价表（建议、理由一句话、整张固定表格），
 * 而面板右栏一直停在「审核中…表格会一行一行长出来，同时在对话里流式写出」。
 *
 * 真因：面板按钮走的是 `agent.followup(提示词)` —— 它唤醒的是**审核会话的主 Agent**，
 * 由主 Agent 自己做复审、把表写进它自己的回复。那条路根本不经过
 * `reviewMode` 投影，所以面板一无所知；而提示词里还逐字写着「在对话里…写出来」。
 *
 * 这个测试证明改后的纪律：
 *   (a) 按钮触发的复审**走监控器那条管线**（同一个 `subagents.start`、同一个
 *       `parseTableVerdict`、同一个 `developer/message` 投递）→ 结果折进面板 feed；
 *   (b) 全程**零 `followup`**（不唤醒主 Agent）、**零 `inject`**（不往对话里塞东西）；
 *   (c) 源码里再没有任何提示词要求把表格写进对话（`followup` 只剩开场那一处）；
 *   (d) `dir` 只是目录、不派复审；`dir self` 立刻审当前会话。
 */

import { readFileSync } from 'node:fs';
import { currentTarget, listCodex, setTarget } from '../reviewer.js';
import { analysisReviewText } from './harness.mjs';

let failed = 0;
const check = (label, pass, extra = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  ${extra}`}`);
  if (!pass) failed += 1;
};

// ── 一条真实的可审对话（`pick` 要真的取证）────────────────
const real = listCodex(50).find((entry) => typeof entry?.id === 'string' && entry.id.length > 0);
check('真实数据里有一条可点的 Codex 对话', real !== undefined, real?.id?.slice(0, 30) ?? '（没有真实数据）');

const REVIEW = analysisReviewText({
  verdict: 'drifting',
  headline: '按钮路哨兵_主题从课件滑到路径',
  dialog: ['你：「课件讲了吗」', '对面：「做成流水线」'],
  summary: '整条对话偏了。',
  analysis: ['页码上转了两轮。', '没先确认口径。'],
  advice: ['[给用户] 先把页码口径写死。', '[给Agent] 先给样例。'],
});

// ── 假宿主 ────────────────────────────────────────────────
const handlers = new Map();
const registeredCommands = new Map();
const appended = [];
const starts = [];
const agent = {
  id: 'review-1',
  session: {
    header: { id: 'review-1', cwd: '/w' },
    seq: 7,
    // 「审你自己」审的是**当前会话**：内存事件快照里要有东西。
    snapshotEvents: () => [
      { type: 'session/title', seq: 1, data: { title: '当前会话' } },
      { type: 'turn/start', seq: 2, data: { turn: 1 } },
      { type: 'user/message', seq: 3, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '本会话哨兵_把这条对话的界面也改一下' }] } },
      { type: 'tool/call', seq: 4, data: { name: 'read' } },
      { type: 'assistant/message', seq: 5, data: { content: [{ type: 'text', text: '好的，我改了界面。' }] } },
    ],
    append(type, data, opts) { appended.push({ type, seq: this.seq, data, opts }); this.seq += 1; return appended[appended.length - 1]; },
  },
  followups: [],
  injects: [],
  followup(m) { this.followups.push(m); },
  inject(m) { this.injects.push(m); },
};
const childScopes = [];
let projection = null;
let projectionState = null;

const timers = [];
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms) => { const id = realSetInterval(fn, ms); timers.push(id); return id; };

const mod = await import(new URL('../index.js', import.meta.url).pathname);
const topInject = mod.inject;
mod.apply({
  logger: { warn: (...a) => console.log('WARN', ...a.map(String)), info() {} },
  reflect: { provide: () => {}, get: () => undefined },
  effect: (fn) => fn(),
  on: (name, fn) => { handlers.set(name, fn); },
  inject: (names, cb) => {
    const scope = {
      names,
      get: (name) => (name === 'commands' ? scope.commands : undefined),
      effect: (fn) => fn(),
      commands: { register(definition) { registeredCommands.set(definition.name, definition); return () => {}; } },
    };
    childScopes.push(scope);
    cb(scope);
  },
  sessionProjections: {
    register: (def) => { projection = def; return () => {}; },
    stateOf: (s, k) => (k === 'agentPreset' ? 'review' : projectionState),
  },
  subagents: {
    start: async (name, req) => {
      starts.push({ name, req });
      return {
        id: `rev-${starts.length}`,
        result: Promise.resolve({ output: [{ type: 'text', text: REVIEW }] }),
        dispose: async () => {},
      };
    },
  },
  agents: { list: () => [agent], get: () => agent, withoutInitiator: (o) => o() },
}, { watchIntervalMs: 5000, watchCodex: false });

{
  let state = projection.init(agent.session.header, 0);
  projectionState = state;
}
const syncProjection = () => {
  let state = projection.init(agent.session.header, 0);
  for (const event of appended) state = projection.apply(state, { type: event.type, seq: event.seq, data: event.data });
  projectionState = state;
  return state;
};

check('顶层 inject 没有被改动（commands 绝不进硬依赖）',
  JSON.stringify(topInject) === JSON.stringify(['sessionProjections', 'subagents', 'agents']),
  JSON.stringify(topInject));
const definition = registeredCommands.get('review-mode');
check('注册了会话命令 `review-mode`', definition !== undefined);
const run = (rawInput) => definition.handler({ agent, rawInput, commandId: 'cmd-1', attachments: [], signal: new AbortController().signal });
const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

// ── (d) dir codex：只给目录，不派复审、不唤醒任何人 ─────────
setTarget(null);
agent.followups.length = 0;
const dirResult = run('dir codex');
check('dir 返回 success 且 text 是目录 JSON',
  dirResult.kind === 'success' && Array.isArray(JSON.parse(dirResult.text).recent),
  String(dirResult.text).slice(0, 80));
check('(b) dir **不唤醒**主 Agent（零 followup）', agent.followups.length === 0, `followups=${agent.followups.length}`);
check('(d) dir 只读目录，不派复审子 Agent', starts.length === 0, `starts=${starts.length}`);

// ── (a) pick：宿主**自己**派复审，结果折进投影 ────────────
if (real !== undefined) {
  setTarget(null);
  appended.length = 0;
  agent.followups.length = 0;
  agent.injects.length = 0;
  const pickResult = run(`pick codex ${real.id}`);
  check('pick 返回 success 且带着证据（面板左栏要它）',
    pickResult.kind === 'success' && JSON.parse(pickResult.text).ok === true,
    String(pickResult.text).slice(0, 90));
  check('pick 仍然记进共享状态 currentTarget()（与 review_conversation 同一份）',
    currentTarget()?.id === real.id && currentTarget()?.kind === 'codex',
    JSON.stringify(currentTarget()));
  check('(a) pick **由宿主自己派复审子 Agent**（不再让主 Agent 去做）',
    starts.length === 1, `starts=${starts.length}`);
  const req = starts[0]?.req;
  check('(a) 复审的 parent 就是审核会话（上下文仍各自独立）', req?.parent === agent);
  const prompt = String(req?.prompt?.[0]?.text ?? '');
  check('(a) 提示词是四段自适应分析那一版（含四个锚点）',
    /具体对话/.test(prompt) && /对话概述/.test(prompt) && /分析/.test(prompt) && /建议/.test(prompt)
    && !/三个问题（固定/.test(prompt) && !/^\|/m.test(prompt),
    prompt.split('\n')[0]);
  check('(b) pick **零 followup** —— 主 Agent 完全没被唤醒', agent.followups.length === 0, `followups=${agent.followups.length}`);

  await settle();
  const notices = appended.filter((event) => event.type === 'user/message' && event.data?.source?.form === 'notice');
  check('(a) 复审结果作为 `user/message` 面事件落进会话（source.kind=review-mode → 客户端画成 context，看不见）',
    notices.length === 1 && notices[0].data.role === 'user' && notices[0].data.source.kind === 'review-mode'
    && notices[0].opts?.surfaceOp === 'append' && notices[0].type !== 'developer/message',
    JSON.stringify(notices.map((n) => [n.type, n.data?.role, n.data?.source?.kind, n.opts?.surfaceOp])));
  check('(b) **零 inject** —— 评价没有变成对话记录里的消息', agent.injects.length === 0, `injects=${agent.injects.length}`);
  const state = syncProjection();
  check('(a) 投影 feed 因此长出 1 张卡片（面板渲染的就是它）',
    state.feed.length === 1, `feed=${state.feed.length}`);
  check('(a) 卡片里有复审员写的哨兵内容（证明真的是这次复审的结果）',
    state.feed[0]?.headline === '按钮路哨兵_主题从课件滑到路径'
    && JSON.stringify(state.feed[0]?.analysis ?? {}).includes('页码上转了两轮'));
  check('(a) 卡片形状 = 四个锚点 + 条数不固定',
    Array.isArray(state.feed[0]?.sections) && state.feed[0].sections.length === 4
    && Array.isArray(state.feed[0]?.analysis) && state.feed[0].analysis.length === 2);
}

// ── (d) dir self：立刻审**当前会话**，材料来自内存快照 ──────
{
  appended.length = 0;
  agent.followups.length = 0;
  agent.injects.length = 0;
  starts.length = 0;
  projectionState = projection.init(agent.session.header, 0);
  const before = starts.length;
  const selfResult = run('dir self');
  check('dir self 返回 success（目录照给）', selfResult.kind === 'success', String(selfResult.text).slice(0, 60));
  check('(d) dir self 立刻派了一次复审（审的就是当前会话）',
    starts.length === before + 1, `starts=${starts.length}`);
  const prompt = String(starts[0]?.req?.prompt?.[0]?.text ?? '');
  check('(d) 材料来自**当前会话的内存快照**（读到了本会话哨兵）',
    prompt.includes('本会话哨兵_把这条对话的界面也改一下'), prompt.slice(0, 90));
  check('(b) dir self 也零 followup', agent.followups.length === 0, `followups=${agent.followups.length}`);
  await settle();
  const state = syncProjection();
  check('(a) dir self 的结果同样折进面板 feed', state.feed.length === 1, `feed=${state.feed.length}`);
}

// ── (c) 源码纪律：**两条复审派单路**再没有任何要求把表格写进对话 ──
// 范围说明：这里扫的是 `index.js` / `client.js`（宿主复审管线 + 面板）。
// **不含** `cordis.patch.yml` 的 persona —— 那是 A 路（用户在对话里用原生可点选项
// 驱动主 Agent）的预设，用户明确要求它在被问到时给出那张固定表（FLOW 第 7 步，
// `test/patch-test.mjs` 守）。按钮路现在**一次都不唤醒主 Agent**（见下面那条
// `.followup(` 只剩 1 处），所以 persona 不可能再被按钮触发。
{
  const indexSource = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const clientSource = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  check('(c) 旧的「同时在对话里流式写出」文案已删（index.js + client.js）',
    !/同时在对话里流式写出/.test(indexSource) && !/同时在对话里流式写出/.test(clientSource));
  check('(c) 旧的「在对话里用一两句…不必把整张表再抄一遍」提示词已删',
    !/在对话里用一两句/.test(indexSource) && !/不必把整张表再抄一遍/.test(indexSource));
  check('(c) 那个专门唤醒主 Agent 的 `wakePanelAgent` 已经不存在',
    !/wakePanelAgent/.test(indexSource));
  // 反向纪律：**代码里**的 `followup` 现在只允许出现在开场那一处。
  // 先把注释剥掉 —— 注释里提到旧做法（`agent.followup(提示词)`）不算调用点。
  const codeOnly = indexSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const followups = codeOnly.match(/\.followup\(/g) ?? [];
  check('(c) index.js 代码里 `.followup(` 只剩开场那 1 处（面板路一处都没有）',
    followups.length === 1, `followup calls=${followups.length}`);
}

for (const id of timers) clearInterval(id);
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
