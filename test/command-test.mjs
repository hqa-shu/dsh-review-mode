/**
 * C 的证明：**面板按钮 → 宿主会话命令 → 提示词真的到了 Agent**。
 *
 * 为什么不能再走 `reviewRemote`：浏览器能调的远程命名空间是**构建期写死的**。
 * 证据（shipped 源码）：
 *   - `@deepseek-ai/dsh-api-remotes/lib/client.js:13503` `const inject = ["remote"]`，
 *     `:13512-13538` 是 25 个生成贡献，`ctx.remote.$mount(contribution)` 挂上去；
 *     README:75：「The capability set is fixed by explicit build-time value imports;
 *     the Client does not discover the Host's active Services or Remote definitions at runtime.」
 *   - `commands` 在**那份清单里**（`commands.execute` / `commands.list`，:4884-4942），
 *     所以它是唯一真能用的前端→宿主通道。用户提的做法也是这个：
 *     「你按钮变成自动注入一段提示词，然后我再点击……可以激发那个后续 Agent」。
 *
 * 这个测试证明：
 *   1. 宿主用 `ctx.inject(['commands'], …)`（child fiber）注册了会话命令 `review-mode`，
 *      **没有**把 `commands` 或任何未证实名字加进顶层 `inject`；
 *   2. `dir` 返回目录，**不唤醒主 Agent**（零 followup）；`dir self` 才由宿主派复审；
 *   3. `pick` 记进 `currentTarget()`（与 `review_conversation` 同一份），并**由宿主
 *      自己派复审子 Agent**（不再是 `agent.followup` 让主 Agent 去做 —— 那条路会把
 *      整张表写进对话，用户 2026-10 抓到过）；
 *   4. `ask` 把问答条目投成 `developer/message`（对话记录里看不见），不碰 `inject`；
 *   5. 任何坏输入都返回 `{kind:'error'}`，**不抛**。
 */

import { currentTarget, listCodex, setTarget } from '../reviewer.js';
import { ANALYSIS_SECTIONS } from '../rubric.js';
import { analysisReviewText } from './harness.mjs';

let failed = 0;
const check = (label, pass, extra = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  ${extra}`}`);
  if (!pass) failed += 1;
};

// ── 假宿主 ────────────────────────────────────────────────
const handlers = new Map();
const registeredCommands = new Map();
const appended = [];
const starts = [];
const REVIEW = analysisReviewText({
  verdict: 'drifting',
  headline: '命令路_领先行',
  dialog: ['你：「命令路」'],
  summary: '命令路的概述。',
  analysis: ['命令路·审我', '命令路·审对话'],
  advice: ['[给用户] 命令路·建议'],
});
const agent = {
  id: 'review-1',
  session: {
    header: { id: 'review-1', cwd: '/w' },
    seq: 7,
    snapshotEvents: () => [],
    append(type, data, opts) { appended.push({ type, data, opts }); this.seq += 1; return { type, seq: this.seq, data }; },
  },
  followups: [],
  injects: [],
  followup(m) { this.followups.push(m); },
  inject(m) { this.injects.push(m); },
};
const childScopes = [];
let projection = null;

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
  // 真实 cordis 的 child-fiber 形状：`ctx.inject([...], cb)` 不进 loader.entries()。
  inject: (names, cb) => {
    const scope = {
      names,
      get: (name) => (name === 'commands' ? scope.commands : undefined),
      effect: (fn) => fn(),
      commands: {
        register(definition) { registeredCommands.set(definition.name, definition); return () => {}; },
      },
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
      starts.push(req);
      return { id: `rev-${starts.length}`, result: Promise.resolve({ output: [{ type: 'text', text: REVIEW }] }), dispose: async () => {} };
    },
  },
  agents: { list: () => [agent], get: () => agent, withoutInitiator: (o) => o() },
}, { watchIntervalMs: 5000, watchCodex: false });

// 让投影先折一张评价卡片，`ask` 才有表可查。
let projectionState = null;
{
  let state = projection.init(agent.session.header, 0);
  state = projection.apply(state, {
    type: 'user/message',
    seq: 1,
    data: {
      id: 'r1',
      role: 'user',
      source: {
        kind: 'review-mode',
        form: 'notice',
        review: {
          lane: 'me', turn: 1, verdict: 'drifting', sections: ANALYSIS_SECTIONS,
          headline: '命令路_领先行', dialog: ['命令路·对话'], summary: '有漂移',
          analysis: ['命令路·审我', '命令路·审对话'], advice: ['命令路·建议'],
          openIssues: [], resolvedIssues: [], forUser: [], forAgent: [],
        },
      },
      content: [{ type: 'text', text: 'x' }],
    },
  });
  projectionState = state;
}

// ── 1. 注册形状 ───────────────────────────────────────────
check('顶层 inject 没有被改动（commands 绝不进硬依赖）',
  JSON.stringify(topInject) === JSON.stringify(['sessionProjections', 'subagents', 'agents']),
  JSON.stringify(topInject));
check('走的是 ctx.inject([...], cb) 的 child fiber',
  childScopes.length === 1 && JSON.stringify(childScopes[0].names) === JSON.stringify(['commands']),
  JSON.stringify(childScopes.map((s) => s.names)));
check('注册了会话命令 `review-mode`', registeredCommands.has('review-mode'));
const definition = registeredCommands.get('review-mode');
check('命令声明了 input.hint（面板按钮就是它的调用方）',
  typeof definition?.input?.hint === 'string' && definition.input.hint.includes('dir'),
  String(definition?.input?.hint));
const run = (rawInput) => definition.handler({ agent, rawInput, commandId: 'cmd-1', attachments: [], signal: new AbortController().signal });

// ── 2. dir：只给目录（`dsh`/`codex` 这一层不派复审）────────
agent.followups.length = 0;
starts.length = 0;
const dirResult = run('dir codex');
check('dir 返回 success', dirResult.kind === 'success', JSON.stringify(dirResult).slice(0, 120));
const directory = JSON.parse(dirResult.text);
check('dir 的 text 是目录 JSON（recent + groups）',
  Array.isArray(directory.recent) && Array.isArray(directory.groups) && typeof directory.total === 'number',
  `recent=${directory.recent?.length} groups=${directory.groups?.length} total=${directory.total}`);
check('dir **不唤醒主 Agent**（零 followup、零 inject）',
  agent.followups.length === 0 && agent.injects.length === 0,
  `followups=${agent.followups.length} injects=${agent.injects.length}`);

// ── 3. pick：记进 currentTarget + **由宿主派复审** ─────────
const real = listCodex(50).find((entry) => {
  try { return typeof entry.id === 'string' && entry.id.length > 0; } catch { return false; }
});
check('真实数据里有一条可点的 Codex 对话', real !== undefined, real?.id?.slice(0, 30) ?? '（没有真实数据）');
if (real !== undefined) {
  setTarget(null);
  agent.followups.length = 0;
  agent.injects.length = 0;
  starts.length = 0;
  const pickResult = run(`pick codex ${real.id}`);
  check('pick 返回 success', pickResult.kind === 'success', String(pickResult.text).slice(0, 120));
  const payload = JSON.parse(pickResult.text);
  check('pick 返回证据（面板左栏要它）',
    payload.ok === true && typeof payload.evidence?.title === 'string', String(payload.evidence?.title));
  check('pick 把选择记进共享状态 currentTarget()（与 review_conversation 同一份）',
    currentTarget()?.id === real.id && currentTarget()?.kind === 'codex',
    JSON.stringify(currentTarget()));
  check('pick **由宿主自己派复审子 Agent**（parent 是审核会话）',
    starts.length === 1 && starts[0]?.parent === agent, `starts=${starts.length}`);
  const pickPrompt = String(starts[0]?.prompt?.[0]?.text ?? '');
  check('pick 的复审提示词是四段自适应分析那一版',
    /具体对话/.test(pickPrompt) && /对话概述/.test(pickPrompt) && /分析/.test(pickPrompt) && /建议/.test(pickPrompt)
    && !/三个问题（固定/.test(pickPrompt),
    pickPrompt.split('\n')[0]);
  check('pick **零 followup** —— 不再让主 Agent 把表写进对话',
    agent.followups.length === 0, `followups=${agent.followups.length}`);
  // 让后台复审落完（它会把结论投成 `user/message`），免得影响下一段计数。
  await new Promise((resolve) => setTimeout(resolve, 25));
  check('pick 的结论落成 `user/message` + source.kind=review-mode（对话流不渲染）',
    appended.filter((e) => e.type === 'user/message' && e.data?.source?.form === 'notice'
      && e.data?.source?.kind === 'review-mode').length === 1
    && appended.every((e) => e.type !== 'developer/message')
    && agent.injects.length === 0,
    `appended=${appended.length} injects=${agent.injects.length}`);
}

// ── 4. ask：问答条目走 developer/message（对话记录看不见）──
appended.length = 0;
agent.injects.length = 0;
const askResult = run('ask 分析 展开讲讲');
check('ask 返回 success 且 text 就是回答',
  askResult.kind === 'success' && String(askResult.text).length > 0, String(askResult.text).slice(0, 90));
check('ask 的问答条目走 user/message（生产者 source → 不进对话记录）',
  appended.length === 1 && appended[0].type === 'user/message'
  && appended[0].data?.source?.form === 'qa'
  && appended[0].data?.source?.kind === 'review-mode'
  && appended[0].data?.role === 'user'
  && appended[0].opts?.surfaceOp === 'append',
  JSON.stringify(appended.map((a) => [a.type, a.data?.source?.form, a.data?.role, a.opts?.surfaceOp])));
check('ask 没有用 agent.inject（那会让问答长在对话里）', agent.injects.length === 0);

// ── 5. 坏输入不抛 ─────────────────────────────────────────
for (const bad of ['', 'nonsense', 'pick', 'pick codex', 'ask']) {
  let result;
  let threw = false;
  try { result = run(bad); } catch { threw = true; }
  check(`坏输入 ${JSON.stringify(bad)} 返回 error 且不抛`,
    !threw && result?.kind === 'error', threw ? '抛了' : JSON.stringify(result).slice(0, 80));
}

for (const id of timers) clearInterval(id);
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
