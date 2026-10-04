/**
 * **面板四态**：真空 / 进行中 / 失败 / 有结果 —— 四者必须长得不一样。
 *
 * 现场失败（用户截图）：面板停在空状态
 * 「审核中…复审员正在写，表格会一行一行长出来（结果只落在这一区）」，
 * 而评价其实已经写在**上面的对话里**。用户看到的是「一句永远不动的进行中」，
 * 分不清「还没开始」「正在跑」「已经失败了」。
 *
 * 改后的判据（都来自 `reviewMode` 投影，客户端零猜测）：
 *   - `empty`     ：没有评价、没有进行中、没有失败 → 空状态文案（指引点方向）；
 *   - `pending`   ：宿主立了「复审进行中」→ 说「进行中」，**不许**再显示空状态；
 *   - `failed`    ：宿主报了失败 → 说失败原因，**不许**再显示空状态/进行中；
 *   - `ready`     ：有评价 → 画卡片，**不许**再显示空状态。
 *
 * 反向变异：同一个收集器分别喂四种投影，正向必须为真、其它三种必须为假 ——
 * 如果哪条断言恒真（以前审计抓到过两条这种），这里会立刻暴露。
 */

// ── 有状态的极小 React（和 client-test 同款）───────────────
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
    return [stateSlots[index], (next) => {
      stateSlots[index] = typeof next === 'function' ? next(stateSlots[index]) : next;
      rerender();
    }];
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

import { readFileSync } from 'node:fs';
import { ANALYSIS_SECTIONS } from '../rubric.js';

let panel = null;
await import('../client.js');
if (registered === null) { console.log('FAIL  模块没注册'); process.exit(1); }
registered.apply({
  remote: {},
  slots: { inject: (name, fn) => fn(), register: (meta, component) => { if (meta.name === 'shell.overlay') panel = component; } },
});

let bad = 0;
const check = (label, pass, detail = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `  ${detail}`}`);
  if (!pass) bad += 1;
};

const collect = (node, predicate, out = []) => {
  if (node === null || typeof node !== 'object') return out;
  if (predicate(node)) out.push(node);
  const kids = node.props?.children;
  const list = Array.isArray(kids) ? kids : (kids === undefined ? [] : [kids]);
  for (const kid of list) collect(kid, predicate, out);
  return out;
};

const CARD = {
  kind: 'review', verdict: 'drifting', lane: 'me',
  sections: ANALYSIS_SECTIONS,
  headline: '四态哨兵_从 A 滑到 B',
  dialog: ['你说：「A」'], summary: '四态哨兵_概述', analysis: ['四态哨兵_分析'], advice: ['四态哨兵_建议'],
  text: '四态哨兵_从 A 滑到 B',
};

const PROJECTIONS = {
  empty: { feed: [] },
  pending: { feed: [], pending: { lane: 'me', label: '审核 · 审我', at: Date.now() } },
  failed: { feed: [], failure: { lane: 'me', message: 'MISSING_CREDENTIAL 哨兵', at: Date.now() } },
  ready: { feed: [CARD], pending: null, failure: null },
};

const render = (projection) => {
  const props = {
    sessionId: 's1',
    useSessions: (selector) => selector({ byId: { s1: { projectionValues: { agentPreset: 'review', reviewMode: projection } } } }),
  };
  rerender = () => { cursor = 0; tree = panel(props); };
  let tree = null;
  rerender();
  return tree;
};
const stateOf = (tree) => collect(tree, (n) => n.props?.['data-review-state'] !== undefined)[0]?.props['data-review-state'] ?? null;
const textOf = (tree) => JSON.stringify(tree);

const trees = Object.fromEntries(Object.entries(PROJECTIONS).map(([key, projection]) => [key, render(projection)]));

// ── 四个状态标签必须两两不同、且各自正确 ────────────────────
check('真空态标成 `empty`', stateOf(trees.empty) === 'empty', String(stateOf(trees.empty)));
check('进行中标成 `pending`', stateOf(trees.pending) === 'pending', String(stateOf(trees.pending)));
check('失败标成 `failed`', stateOf(trees.failed) === 'failed', String(stateOf(trees.failed)));
check('有结果标成 `ready`', stateOf(trees.ready) === 'ready', String(stateOf(trees.ready)));

// ── 空状态文案：只在真空态出现 ───────────────────────────────
const looksEmpty = (tree) => /还没有评价/.test(textOf(tree));
check('真空态显示空状态文案（指引点方向）', looksEmpty(trees.empty) === true);
check('反向变异：进行中**不许**显示空状态文案', looksEmpty(trees.pending) === false, textOf(trees.pending).slice(0, 120));
check('反向变异：失败**不许**显示空状态文案', looksEmpty(trees.failed) === false, textOf(trees.failed).slice(0, 120));
check('反向变异：有结果**不许**显示空状态文案', looksEmpty(trees.ready) === false, textOf(trees.ready).slice(0, 120));

// ── 进行中文案：只在 pending 出现，且与空状态是两句不同的话 ──
const looksPending = (tree) => /复审进行中/.test(textOf(tree));
check('进行中显示「复审进行中…」', looksPending(trees.pending) === true);
check('反向变异：真空态**不许**显示进行中', looksPending(trees.empty) === false, textOf(trees.empty).slice(0, 120));
check('反向变异：失败**不许**显示进行中', looksPending(trees.failed) === false);
check('反向变异：有结果**不许**显示进行中', looksPending(trees.ready) === false);
check('「进行中」与「空状态」是两句不同的话（不会互相冒充）',
  looksPending(trees.pending) === true && looksEmpty(trees.pending) === false
  && looksEmpty(trees.empty) === true && looksPending(trees.empty) === false);

// ── 失败：说出真因，且不冒充其它态 ───────────────────────────
const looksFailed = (tree) => /复审没有完成/.test(textOf(tree));
check('失败态显示失败文案（不是空状态）', looksFailed(trees.failed) === true);
check('失败态把宿主的真因说出来', /MISSING_CREDENTIAL 哨兵/.test(textOf(trees.failed)), textOf(trees.failed).slice(0, 160));
check('反向变异：真空态**不许**显示失败文案', looksFailed(trees.empty) === false);
check('反向变异：进行中**不许**显示失败文案', looksFailed(trees.pending) === false);
check('反向变异：有结果**不许**显示失败文案', looksFailed(trees.ready) === false);

// ── 有结果：画卡片，不显示任何提示文案 ───────────────────────
check('有结果时画的是四段自适应分析（含哨兵内容）',
  /四态哨兵_从 A 滑到 B/.test(textOf(trees.ready))
  && textOf(trees.ready).includes('具体对话') && textOf(trees.ready).includes('四态哨兵_分析')
  && textOf(trees.ready).includes('四态哨兵_建议'));
check('有结果时**没有**固定表格节点（旧 3×3 已删）',
  collect(trees.ready, (n) => n.props?.['data-review-table'] !== undefined).length === 0);
check('有结果时三句提示文案一个都不出现',
  looksEmpty(trees.ready) === false && looksPending(trees.ready) === false && looksFailed(trees.ready) === false);

// ── 旧那句「审核中…复审员正在写…」必须从源码里彻底消失 ──────
{
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const legacy = '审核中…复审员正在写，表格会一行一行长出来';
  const gone = (code) => !code.includes(legacy);
  check('旧的假进行中文案「审核中…复审员正在写，表格会一行一行长出来」已删', gone(source) === true, legacy);
  check('反向变异：把旧文案拼回去，同一条判据会变红',
    gone(source) === true && gone(`${source}\n// ${legacy}`) === false);
}

console.log(bad === 0 ? '\n全部通过' : `\n${bad} 项失败`);
process.exit(bad === 0 ? 0 : 1);
