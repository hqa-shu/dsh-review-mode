/**
 * **A 路的落点证明**：主 Agent 调 `review_conversation`（原生可点选项那条路，
 * 也就是默认体验）之后，复审同样**由宿主派单、结果只折进 `reviewMode` 投影**，
 * 面板照常长出一张卡片；对话里没有表。
 *
 * 现场失败（用户原话：「这个显示地区问题，你从来没有做对过」）：
 *   对话记录里是主 Agent 自己写的评价散文（含「表已落到审核面板」），
 *   而面板停在空状态「审核中…复审员正在写」。
 *
 * 真因：A 路只做了两件事 —— `setTarget()` + 把证据 render 给主 Agent，
 * 让主 Agent **自己**填表、自己写进回复；那条路根本不经过 `runDirectedReview`，
 * 所以面板一无所知（B 路 bug 37 修过一次，A 路一直没修）。
 *
 * 这个测试证明改后的纪律：
 *   (a) `review_conversation` 之后宿主真的派了复审子 Agent（`subagents.start` 1 次），
 *       结果折进投影 `feed`，卡片带固定表格与复审员的哨兵内容；
 *   (b) 工具给主 Agent 的 text（模型真正读到的东西）**不含表格、不含证据**，
 *       只给一句「已交给复审员，结果只落在面板」；
 *   (c) 宿主管线**没接上**时，工具结果必须如实说「没有生成任何评价、面板上不会有东西」，
 *       绝不允许出现「表已落到审核面板」这类成功断言；
 *   (d) 复审**一开始**就在投影里立 `pending`（面板据此说「进行中」而不是空状态），
 *       失败时立 `failed`（说出真因），完成时两者都被清掉；
 *   (e) 全程零 `followup`、零 `inject`（对话区回到「你问我答」）。
 *
 * 反向变异：每一条正向断言都配一个可以失败的对照 ——
 *   · (c) 用「把派单钩子摘掉」证明这条断言真的依赖宿主回话（摘掉 → 必须变红）；
 *   · (b) 用「把旧的两段表格文本拼回去」证明 no-table 判据不是恒真；
 *   · (d) 用「失败场景」证明 pending 判据不是恒真。
 */

import { readFileSync } from 'node:fs';
import { listCodex, currentTarget, setTarget } from '../reviewer.js';
import { analysisReviewText } from './harness.mjs';
import * as reviewer from '../reviewer.js';

let failed = 0;
const check = (label, pass, extra = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  ${extra}`}`);
  if (!pass) failed += 1;
};

/** 反向变异用的判据：真表格 / 假表格。 */
const hasMarkdownTable = (text) => /^\s*\|.*\|\s*$/m.test(String(text)) || /^\s*\|?[-:\s|]+\|\s*$/m.test(String(text));

// ── 一条真实的可审对话（复审要真的取证）──────────────────────
const real = listCodex(50).find((entry) => typeof entry?.id === 'string' && entry.id.length > 0);
check('真实数据里有一条可审的 Codex 对话', real !== undefined, real?.id?.slice(0, 30) ?? '（没有真实数据）');

const REVIEW = analysisReviewText({
  verdict: 'drifting',
  headline: 'A路哨兵_主题从课件滑到路径',
  dialog: ['你：「课件讲了吗」', '对面：「做成流水线」'],
  summary: '整条对话偏了。',
  analysis: ['页码上转了两轮，同一细节来回说。', '没先确认口径。'],
  advice: ['[给用户] 先把页码口径写死。', '[给Agent] 先给样例。'],
});

// ── 假宿主（真 `apply`，只有宿主是替身）─────────────────────
const handlers = new Map();
const appended = [];
const starts = [];
let projection = null;
const timers = [];
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms) => { const id = realSetInterval(fn, ms); timers.push(id); return id; };

const agent = {
  id: 'review-1',
  session: {
    header: { id: 'review-1', cwd: '/w' },
    seq: 7,
    snapshotEvents: () => [],
    append(type, data, opts) { appended.push({ type, seq: this.seq, data, opts }); this.seq += 1; return appended[appended.length - 1]; },
  },
  followups: [],
  injects: [],
  followup(m) { this.followups.push(m); },
  inject(m) { this.injects.push(m); },
};

const toolCtx = {
  logger: { warn: () => {}, info() {} },
  effect: (fn) => fn(),
  tools: {
    restrict: () => () => {},
    register: (def) => tools.set(def.name, def),
  },
};
const tools = new Map();

const indexMod = await import(new URL('../index.js', import.meta.url).pathname);
let startBehavior = 'ok';
indexMod.apply({
  logger: { warn: (...a) => console.log('WARN', ...a.map(String)), info() {} },
  reflect: { provide: () => {}, get: () => undefined },
  effect: (fn) => fn(),
  on: (name, fn) => { handlers.set(name, fn); },
  inject: () => {},
  sessionProjections: {
    register: (def) => { projection = def; return () => {}; },
    stateOf: (s, k) => (k === 'agentPreset' ? 'review' : undefined),
  },
  subagents: {
    start: async (name, req) => {
      starts.push({ name, req });
      if (startBehavior === 'throw') throw new Error('spawn 失败哨兵');
      const result = startBehavior === 'reject'
        ? Promise.reject(new Error('复审超时哨兵'))
        : Promise.resolve({ output: [{ type: 'text', text: REVIEW }] });
      return { id: `rev-${starts.length}`, result, dispose: async () => {} };
    },
  },
  agents: { list: () => [agent], get: () => agent, withoutInitiator: (o) => o() },
}, { watchIntervalMs: 5000, watchCodex: false });

reviewer.apply(toolCtx);
const review = tools.get('review_conversation');
check('A 路的工具 `review_conversation` 注册上了', review !== undefined, [...tools.keys()].join(', '));

const syncProjection = () => {
  let state = projection.init(agent.session.header, 0);
  for (const event of appended) state = projection.apply(state, { type: event.type, seq: event.seq, data: event.data });
  return state;
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
const forms = () => appended.map((e) => e.data?.source?.form ?? '').filter((f) => f !== '');

/**
 * **「表已落到面板」这类完成断言**：三种受理状态里一个都不许出现。
 * 这是用户现场那句话（「表已落到审核面板」而面板是空的）的机器判据。
 */
const claimsTableLanded = (value) => /表.{0,8}(已|已经).{0,6}(落|进|出现|放|到)/.test(String(value))
  || /审核结果.{0,8}(已|已经).{0,6}(落|进|出现|放|到).{0,6}面板/.test(String(value));

// ── (c) 反向变异：把派单钩子摘掉 → 必须如实说「没有生成任何评价」 ──
{
  const saved = typeof reviewer.getReviewDispatch === 'function' ? reviewer.getReviewDispatch() : null;
  check('宿主注册了 A 路派单钩子（没有它 A 路就落不到面板）', saved !== null && saved !== undefined,
    `dispatch=${saved === null || saved === undefined ? '无' : '有'}`);
  if (typeof reviewer.setReviewDispatch === 'function') reviewer.setReviewDispatch(null);
  appended.length = 0;
  agent.followups.length = 0;
  agent.injects.length = 0;
  starts.length = 0;
  const value = real === undefined ? {} : review.execute({ kind: 'codex', id: real.id, lane: 'agent' }, { agent });
  const text = review.output.render({ kind: 'codex', id: real?.id, lane: 'agent' }, value)[0].text;
  check('(c) 管线没接上时状态是 unavailable，而不是假装成功',
    value.reviewStatus === 'unavailable', String(value.reviewStatus));
  check('(c) 管线没接上时**一次复审都没派**', starts.length === 0, `starts=${starts.length}`);
  check('(c) 管线没接上时 panel 上确实什么都没有（零 notice）',
    !appended.some((e) => e.data?.source?.form === 'notice') && agent.injects.length === 0);
  check('(c) 没接上时工具明说「没有生成评价 / 面板上不会有东西」',
    /没有生成任何评价|面板上也不会有东西|没有生成评价/.test(text), text.slice(0, 120));
  check('(c) 没接上时**绝不许**出现「表已落到面板」这类成功断言',
    !claimsTableLanded(text), text.slice(0, 160));
  check('(c) 判据本身能失败（反向变异）：把这句假话拼进去必须变红',
    claimsTableLanded(text) === false && claimsTableLanded('表已落到审核面板') === true
    && claimsTableLanded('结论: on-track，表已落到审核面板') === true);
  if (typeof reviewer.setReviewDispatch === 'function') reviewer.setReviewDispatch(saved);
}

if (real !== undefined) {
  // ── (a)(b)(e) A 路真跑一次：宿主派单、面板长卡片、对话零表 ──
  setTarget(null);
  appended.length = 0;
  agent.followups.length = 0;
  agent.injects.length = 0;
  starts.length = 0;
  const value = review.execute({ kind: 'codex', id: real.id, lane: 'agent' }, { agent });
  const text = review.output.render({ kind: 'codex', id: real.id, lane: 'agent' }, value)[0].text;

  check('(a) 工具执行后立刻记进共享状态 currentTarget()', currentTarget()?.id === real.id,
    JSON.stringify(currentTarget()));
  check('(a) 工具受理成功（started）', value.reviewStatus === 'started', String(value.reviewStatus));
  check('(a) 宿主**自己**派了复审子 Agent（1 次）', starts.length === 1, `starts=${starts.length}`);
  check('(a) 复审的 parent 是审核会话（上下文仍各自独立）', starts[0]?.req?.parent === agent);
  check('(a) 提示词用的是这条对话的真证据（A 路与面板同一条取证路）',
    String(starts[0]?.req?.prompt?.[0]?.text ?? '').includes(String(value.title).slice(0, 8)),
    String(starts[0]?.req?.prompt?.[0]?.text ?? '').split('\n')[0]);
  check('(a) 提示词是四段自适应分析那一版（复审员要的，不是主 Agent 要的）',
    /具体对话/.test(String(starts[0]?.req?.prompt?.[0]?.text ?? ''))
    && /对话概述/.test(String(starts[0]?.req?.prompt?.[0]?.text ?? ''))
    && /分析/.test(String(starts[0]?.req?.prompt?.[0]?.text ?? ''))
    && /建议/.test(String(starts[0]?.req?.prompt?.[0]?.text ?? '')));
  check('(e) A 路**零 followup** —— 主 Agent 没有被叫去做复审', agent.followups.length === 0,
    `followups=${agent.followups.length}`);
  check('(e) A 路**零 inject** —— 评价没有变成对话记录里的消息', agent.injects.length === 0,
    `injects=${agent.injects.length}`);

  // (b) 模型真正读到的 text：不含证据、不含表格。
  check('(b) 工具给主 Agent 的 text **不含表格**', !hasMarkdownTable(text)
    && !/① 主题漂移/.test(text), text.slice(0, 120));
  check('(b) 工具给主 Agent 的 text **不含证据原文**（用户说过的话不再倒给它）',
    (value.youSaid ?? []).every((said) => String(said).length < 8 || !text.includes(String(said).slice(0, 12))));
  check('(b) 工具给主 Agent 的 text 明说「结果只落在面板 / 不要复述证据」',
    /只(会)?(出现)?在.{0,6}面板/.test(text) && /不要复述|不要贴表格|最多一句话/.test(text), text.slice(0, 160));
  check('(c) 受理成功时只承诺「正在生成」，**不**承诺「已经落到面板」',
    !claimsTableLanded(text) && /正在后台生成/.test(text), text.slice(0, 160));
  // 反向变异：把一张真正的 markdown 表格拼进回执，同一条 no-table 判据必须变红。
  // （`REVIEW` 现在已经是**四段分析**、本身不含表格，所以变异体要自己写一张表。）
  const LEGACY_TABLE = '| | 审我 | 审对话 | 审 Agent |\n|---|---|---|---|\n| ① 主题漂移 | a | b | c |';
  check('(b) 反向变异：把旧表格块拼回去，no-table 判据会变红',
    hasMarkdownTable(text) === false && hasMarkdownTable(`${text}\n${LEGACY_TABLE}`) === true);

  await settle();
  check('(d) 复审一开始先立了 pending（面板据此说「进行中」，不再显示空状态）',
    forms().includes('pending'), forms().join(',') || '（没有事件）');
  const state = syncProjection();
  check('(a) 投影 feed 长出 1 张卡片（面板渲染的就是它）', state.feed.length === 1, `feed=${state.feed.length}`);
  check('(a) 卡片里有复审员写的 A 路哨兵（证明真的是这次复审的结果）',
    state.feed[0]?.headline === 'A路哨兵_主题从课件滑到路径'
    && JSON.stringify(state.feed[0]?.analysis ?? {}).includes('页码上转了两轮'));
  check('(d) 收口后 pending 被清掉（完成品不并存）', state.pending === null, JSON.stringify(state.pending));
  check('(d) 成功收口时不留下失败状态', state.failure === null, JSON.stringify(state.failure));
}

// ── (d) 失败路：复审员起不来时必须立 failed，并说出真因 ──────
if (real !== undefined) {
  appended.length = 0;
  agent.injects.length = 0;
  starts.length = 0;
  startBehavior = 'throw';
  const failedValue = review.execute({ kind: 'codex', id: real.id, lane: 'me' }, { agent });
  const failedText = review.output.render({ kind: 'codex', id: real.id, lane: 'me' }, failedValue)[0].text;
  await settle();
  const failedForms = forms();
  check('(d) 复审员起不来时投了一条 `failed`（不是静默失败）', failedForms.includes('failed'),
    failedForms.join(',') || '（没有事件）');
  check('(d) failed 里带着真因（面板要把原因说出来）',
    appended.some((e) => e.data?.source?.form === 'failed'
      && /spawn 失败哨兵/.test(JSON.stringify(e.data?.source?.review ?? {}))),
    JSON.stringify(appended.map((e) => e.data?.source?.form)));
  check('(c) 即使这次复审随后失败，当时那句话也**没有**承诺「已落到面板」',
    !claimsTableLanded(failedText), failedText.slice(0, 120));
  startBehavior = 'ok';
}

// ── (b) 三条线都必须是不含表格的回执 ─────────────────────────
if (real !== undefined) {
  for (const lane of ['me', 'conversation', 'agent']) {
    const value = review.execute({ kind: 'codex', id: real.id, lane }, { agent });
    const text = review.output.render({ kind: 'codex', id: real.id, lane }, value)[0].text;
    check(`(b) lane=${lane} 的回执不含表格、不含证据`,
      !hasMarkdownTable(text)
      && !/① 主题漂移/.test(text)
      && (value.youSaid ?? []).every((s) => String(s).length < 8 || !text.includes(String(s).slice(0, 12))),
      text.slice(0, 80));
  }
}

// ── 源码纪律：A 路的 render 里不许再出现旧那两段「输出格式 + 表格」 ──
{
  const reviewerSource = readFileSync(new URL('../reviewer.js', import.meta.url), 'utf8');
  const legacy = '## 输出格式（**每次都一模一样**，只换格子里的内容；三列都要填）';
  // 判据：既没有旧的格式块、也没有任何渲染表格的函数/常量出口（注释里提到名字不算）。
  const noLegacyBlock = (source) => !source.includes(legacy)
    && !/renderReviewTable\s*\(/.test(source) && !/export\s+const\s+REVIEW_TABLE_ROWS/.test(source);
  check('A 路工具 render 里的旧「输出格式 + 固定表格」块已删',
    noLegacyBlock(reviewerSource), legacy);
  check('A 路 render 删块的反向变异：把旧块拼回去，判据必须变红',
    noLegacyBlock(reviewerSource) === true && noLegacyBlock(`${reviewerSource}\n${legacy}`) === false);
}

for (const id of timers) clearInterval(id);
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
