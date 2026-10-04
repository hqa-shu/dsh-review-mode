/**
 * FLOW.md 第 4 / 8 步的端到端证明：**三路一起审 + 固定表格 + 0 句对话仍可审**。
 *
 * 用户 2026-10 的修正原话：「三路都要这样审啊……这三个问题，我希望你每次都以表格的
 * 形式生成，然后确保每次不变」。
 *
 * 这个测试挑一条**你说 0 条、对面 AI 说了话**的真实 Codex 对话，用 `lane: 'conversation'`
 * 选它，断言：
 *   - 监控器**照样派复审**（改前的闸门 `asks.length === 0` 会挡掉它）；
 *   - 提示词走的是三路表格版，带着常量里的三行三列；
 *   - 解析出来的是**固定 3×3 + 建议**，形状与常量逐字一致；
 *   - 通知卡片署名带这条线，并且带表格。
 *
 * 用真实的 ~/.codex 数据和真实定时器，最多等 15 秒。
 */

import { listCodex, readCodex, setTarget, LANE_LABELS } from '../reviewer.js';
import { analysisReviewText } from './harness.mjs';

let failed = 0;
const check = (label, pass, extra = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  ${extra}`}`);
  if (!pass) failed += 1;
};

// ① 找一条「你说 0 条、对面说了话」的真实对话 —— 这正是用户说的那种「0 句话的对话」。
const all = listCodex(1000);
let picked = null;
let pickedRead = null;
for (const entry of all) {
  const read = readCodex(entry);
  if (read.askCount === 0 && read.otherCount > 0 && read.did.length > 0) {
    picked = entry; pickedRead = read; break;
  }
}
check('找到一条「你说 0 条、对面说了话」的真实对话', picked !== null,
  picked === null ? '（真实数据里没有，无法验证）' : `→ ${pickedRead.title} · 对面 ${pickedRead.otherCount} 条`);
if (picked === null) { console.log('\n1 项失败'); process.exit(1); }

setTarget({ kind: 'codex', id: picked.id, title: pickedRead.title, lane: 'conversation' });

// 复审员按**固定表格**回答 —— 行/列名逐字来自常量，格子里才是内容。
const REVIEW = analysisReviewText({
  verdict: 'drifting',
  headline: '整条对话从整理滑到格式',
  dialog: ['你：「先转 PDF」', '对面：「整理 20 份 PDF」'],
  summary: '整条对话从整理知识点滑到格式转换。',
  analysis: ['在页码口径上转了两轮。', '没先确认页码口径，站不住。'],
  advice: ['[给用户] 先把页码口径写死。', '[给Agent] 先给 3 份样例的页码对照。'],
});

const agents = [];
// 会话真正的模型配置由请求头给出（shipped 形状：`parentAgentOptionsForDelegation`
// 读的就是 `session.requestHeader()?.config`）。这里刻意用 `deepseek-account`：
// 现场那次失败是**新会话默认落到 `deepseek-official`**（要裸 DEEPSEEK_API_KEY），
// 而主对话走的是账号那条 route。
const ROUTE = { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' };
const agent = {
  id: 'review-1',
  options: { ...ROUTE },
  session: {
    header: { id: 'review-1', cwd: '/w' }, seq: 10, snapshotEvents: () => [],
    requestHeader: () => ({ config: { ...ROUTE }, adapterDefaults: {} }),
  },
  inject(m) { this.injected = m; },
};
agents.push(agent);

let started = null;
const timers = [];
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms) => { const id = realSetInterval(fn, ms); timers.push(id); return id; };

const mod = await import(new URL('../index.js', import.meta.url).pathname);
mod.apply({
  logger: { warn: (...a) => console.log('WARN', ...a.map(String)), info() {} },
  reflect: { provide: () => {}, get: () => undefined },
  effect: (fn) => fn(),
  on: () => {},
  sessionProjections: { register: () => () => {}, stateOf: (s, k) => (k === 'agentPreset' ? 'review' : undefined) },
  subagents: {
    start: async (name, req) => {
      // 只记**第一次**派单：监控器可能在校验完这条之后又回落到「最近动过的那条」，
      // 那次派单不能拿来冒充「这条 0 句对话被审了」（红测里就是这么假通过的）。
      if (started === null) started = req;
      return { id: 'rev-1', localAgent: undefined, result: Promise.resolve({ output: [{ type: 'text', text: REVIEW }] }), dispose: async () => {} };
    },
  },
  agents: { list: () => agents, get: () => agent, withoutInitiator: (o) => o() },
}, { watchIntervalMs: 5000, codexWindowHours: 720 });

console.log('等待监控器触发（最多 15 秒）…');
for (let i = 0; i < 30 && agent.injected === undefined; i += 1) {
  await new Promise((r) => setTimeout(r, 500));
}
for (const id of timers) clearInterval(id);

// 这条对话自己的 AI 原话 —— 证明复审的**确实是这一条**，而不是回落到了别的会话。
const marker = String(pickedRead.said[pickedRead.said.length - 1]?.text ?? '').slice(0, 18);
const sawPicked = started !== null
  && marker.length > 0
  && String(started.prompt?.[0]?.text ?? '').includes(marker);
check('「你说 0 条」的对话仍然被复审了（三路里的 conversation 线）',
  agent.injected !== undefined && started !== null && sawPicked,
  sawPicked ? '' : `（第一次派单不是这条对话；marker=${JSON.stringify(marker)}）`);

if (started !== null) {
  const prompt = String(started.prompt?.[0]?.text ?? '');
  console.log('  它用的提示词首行:', prompt.split('\n')[0]);
  check('提示词是「四段自适应分析」那一版', prompt.includes('具体对话') && prompt.includes('对话概述') && prompt.includes('分析') && prompt.includes('建议'));
  check('提示词点明了本次的线（审对话）', prompt.includes('审对话'));
  check('提示词里**没有**旧的固定表格要求',
    !/三个问题（固定/.test(prompt) && !/① 主题漂移/.test(prompt) && !/^\|/m.test(prompt),
    (prompt.match(/^\|.*$/m) ?? [''])[0].slice(0, 60));
  check('0 句对话在提示词里被标明「没什么可审」',
    prompt.includes('（这条对话里用户一句话都没说'));
  check('parent 是审核会话', started.parent === agent);
  // 模型配置必须跟主对话一样（用户原话：「主对话用什么，审核用什么；模型配置一样，
  // 就是上下文不一样」）——不然复审会走另一条 route，真发生过 MISSING_CREDENTIAL。
  check('复审继承了这条会话的模型配置（provider/model）',
    started.agentOptions?.provider === ROUTE.provider
    && started.agentOptions?.model === ROUTE.model,
    JSON.stringify(started.agentOptions));
  check('上下文不共享：复审仍带自己的 parent 与自己的提示词',
    started.prompt?.[0]?.text?.includes('四段') === false && started.prompt?.[0]?.text?.includes('具体对话') === true);
}
if (agent.injected !== undefined) {
  const r = agent.injected.source.review;
  const card = String(agent.injected.content?.[0]?.text ?? '');
  check('解析出的 lane 是 conversation', r?.lane === 'conversation', `→ ${String(r?.lane)}`);
  check('结论形状 = 四个锚点 + 领先行（条数不固定）',
    Array.isArray(r?.sections) && r.sections.length === 4
    && typeof r?.headline === 'string' && r.headline.length > 0
    && Array.isArray(r?.analysis) && r.analysis.length === 2 && Array.isArray(r?.advice) && r.advice.length === 2,
    `→ 分析 ${r?.analysis?.length} 条 / 建议 ${r?.advice?.length} 条`);
  check('conversation 线的分析被填上了（本次点选那条线）',
    String(r?.analysis?.[0] ?? '').includes('页码口径'));
  check('通知卡片署名是「审对话」且带四段分析',
    card.includes('审对话') && card.includes('具体对话') && card.includes('分析'));
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
