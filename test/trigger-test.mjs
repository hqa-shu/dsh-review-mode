/**
 * 触发与流的三条硬规则（用户 2026-10 第二次澄清）：
 *
 *   1. **以我发问为节点**：用户消息数 +1 → 正好一次新评价；数没变 → **零次**。
 *      （`nextReviewEdge` 是这条规则的纯函数，宿主监控器就调它。）
 *   2. **流是只增不改的**：评价与问答都只往里追加，旧条目一个都不动。
 *   3. **问答和自动评价同一个流、但一眼可分**：`kind:'qa'` vs `kind:'review'`。
 *
 * 投影折叠用真代码（假宿主只为拿到注册进去的投影定义），不重启、不联网。
 */

import { nextReviewEdge } from '../reviewer.js';
import { ANALYSIS_SECTIONS, emptyAnalysis, fillAnalysis, leadingLine } from '../rubric.js';

let failed = 0;
const check = (label, pass, extra = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  ${extra}`}`);
  if (!pass) failed += 1;
};

// ── 1. 边沿规则 ──────────────────────────────────────────────
check('(触发) 第一次看到、用户说过话 → 审一次', nextReviewEdge(undefined, 3).fire === true);
check('(触发) 第一次看到、用户 0 句 → 不审', nextReviewEdge(undefined, 0).fire === false);
check('(触发) 数没变 → 零次', nextReviewEdge(3, 3).fire === false);
check('(触发) 多一条用户消息 → 正好一次', nextReviewEdge(3, 4).fire === true);
check('(触发) 连着再来一次没变 → 还是零次', nextReviewEdge(4, 4).fire === false);
check('(触发) 计数回退（日志截断）→ 不审', nextReviewEdge(4, 2).fire === false);
check('(触发) 边沿会带回要记下的新计数', nextReviewEdge(3, 4).count === 4);

// ── 2 & 3. 投影折叠：只增不改 + 两种条目可分 ─────────────────
let projection = null;
const timers = [];
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms) => { const id = realSetInterval(fn, ms); timers.push(id); return id; };
const agent = { id: 'review-1', session: { header: { id: 'review-1', cwd: '/w' }, seq: 10, snapshotEvents: () => [] }, inject() {} };
const mod = await import(new URL('../index.js', import.meta.url).pathname);
mod.apply({
  logger: { warn: (...a) => console.log('WARN', ...a.map(String)), info() {} },
  reflect: { provide: () => {}, get: () => undefined },
  effect: (fn) => fn(),
  on: () => {},
  sessionProjections: { register: (def) => { projection = def; return () => {}; }, stateOf: (s, k) => (k === 'agentPreset' ? 'review' : undefined) },
  subagents: { start: async () => ({ id: 'x', result: Promise.resolve({ output: [] }), dispose: async () => {} }) },
  agents: { list: () => [agent], get: () => agent, withoutInitiator: (o) => o() },
}, { watchCodex: false });
for (const id of timers) clearInterval(id);
check('拿到了注册进去的 reviewMode 投影', projection !== null && typeof projection.apply === 'function');

const reviewMessage = (turn, tag) => ({
  source: {
    kind: 'review-mode', form: 'notice',
    review: {
      lane: 'me', turn, sections: ANALYSIS_SECTIONS,
      ...fillAnalysis(emptyAnalysis(), {
        headline: `${tag} 的领先行`, dialog: [`${tag} 的对话`], summary: `${tag} 的一句话`,
        analysis: [`${tag} 的分析`], advice: [`${tag} 的建议`],
      }),
      verdict: 'drifting',
      openIssues: [], resolvedIssues: [], forUser: [], forAgent: [], good: [], noise: [],
      constraints: [], codexObs: [], dropped: [],
    },
  },
  content: [{ type: 'text', text: `${tag} 的评价` }],
});
const qaMessage = (question, answer) => ({
  source: { kind: 'review-mode', form: 'qa', review: { question, answer, lane: 'me', turn: 1 } },
  content: [{ type: 'text', text: `问：${question}\n→ ${answer}` }],
});

let state = projection.init(agent.session.header, 0);
let seq = 0;
const fold = (message) => {
  seq += 1;
  state = projection.apply(state, { type: 'agent/inbox/spliced', seq, data: { inserted: [message] } });
  return state.feed.map((entry) => entry.kind);
};
const k1 = fold(reviewMessage(1, 'A'));
const k2 = fold(qaMessage('② 展开讲讲', '按「② 局部纠结」这一行：审我=…'));
const snapAfterQa = JSON.stringify(state.feed);
const k3 = fold(reviewMessage(2, 'B'));

check('(流) 条目数是 1 → 2 → 3（只增）',
  k1.length === 1 && k2.length === 2 && k3.length === 3, `→ ${k1.length}/${k2.length}/${k3.length}`);
check('(流) 两种条目在同一个流里且标得不同',
  k1[0] === 'review' && k2[1] === 'qa' && k3[2] === 'review', `→ ${k3.join(',')}`);
check('(流) 旧的条目一个字符都没动（只增不改）',
  JSON.stringify(state.feed.slice(0, 2)) === snapAfterQa,
  JSON.stringify(state.feed[0]).slice(0, 60));
check('(流) 问答条目标成 kind=qa，带问题与回答',
  state.feed[1].kind === 'qa' && state.feed[1].question.includes('展开讲讲')
  && String(state.feed[1].text).includes('局部纠结'),
  `→ ${state.feed[1].question}`);
check('(流) 自动评价条目标成 kind=review，带四段自适应分析 + 领先行',
  state.feed[0].kind === 'review' && Array.isArray(state.feed[0].sections) && state.feed[0].sections.length === 4
  && state.feed[0].verdict === 'drifting'
  && state.feed[0].headline === 'A 的领先行'
  && leadingLine(state.feed[0]) === 'A 的领先行');
check('(流) 问答条目不会冒充评价（没有分析段落）',
  state.feed[1].kind === 'qa' && state.feed[1].analysis.length === 0 && state.feed[1].advice.length === 0);
check('(流) 新评价不会清掉或替换旧问答',
  state.feed.length === 3 && state.feed[1].kind === 'qa');

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
