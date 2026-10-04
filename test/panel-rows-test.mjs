/**
 * **评价是一行一条的清单，右边显示选中的那一条的分析**（bug 47/48，2026-10 用户要求）。
 *
 * 用户原话：
 *   1.「审核跳出来这个话，我觉得你要把它分成一条一条，然后每条就显示前面的一个部分，
 *      不然的话这样子你有的长有的短。」
 *   2.「然后每条是不是右边又应该有对应的相关的评价分析呢？」
 *
 * 改前：结果区把**整块**评价渲染出来（最新一条整张表展开、更早的只用一行收起），
 * 于是长的一块和短的一行挤在一起，扫不动。
 *
 * 现在（2026-10 第二版）：左栏一条一行，右栏是选中那条的**四段自适应分析**
 *   - 左栏（`data-review-col="q"`）：**一条评价一行**（`data-review-row="i"`），
 *     每行只有**前导部分**：时间 · 结论标签 · **领先行**（`rubric.js` 的 `leadingLine()`；
 *     截断、不换行、等高）；
 *   - 右栏（`data-review-col="a"`，`data-review-detail="<i>"`）：**选中那条**的完整分析
 *     —— 具体对话 / 对话概述 / 分析 / 建议（段落表跟着卡片走，条数不固定）；
 *   - 点左边某一行 → 右边换成那一条；**再点同一行 = 取消选中**（回到最新）。
 *
 * 「返回 / 视图」那一层由 `test/panel-back-test.mjs` 单独守（每个视图都有回头路）。
 *
 * 反向变异：默认态右栏里**不能**出现第 0 条的内容（否则「点一下会换」这条断言恒真），
 * 左栏的每一行里**不能**出现自己的分析 / 建议内容（否则「只显示前导部分」恒真）。
 */

import { ANALYSIS_SECTIONS } from '../rubric.js';

let failed = 0;
const check = (label, pass, extra = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  ${extra}`}`);
  if (!pass) failed += 1;
};

// ── 有状态的极小 React ─────────────────────────────────────
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

const reply = (text) => ({ ok: true, value: { commandId: 'c1', result: { kind: 'success', text } } });
const DIRECTORY = {
  kind: 'codex', total: 1, recent: [{ id: 'a1', kind: 'codex', title: '细节问答', label: '5005复习 / 细节问答', age: '3 分钟前' }],
  groups: [], selected: null,
};
const EVIDENCE = { title: '5005复习 / 细节问答', youSaid: ['你查查课件，课件当中有讲这几个算法吗？'], background: [], stats: '你说 1 条' };
const fakeRemote = {
  commands: {
    execute(_sessionId, line) {
      const verb = String(line).trim().split(/\s+/)[1];
      if (verb === 'dir') return Promise.resolve(reply(JSON.stringify(DIRECTORY)));
      if (verb === 'pick') return Promise.resolve(reply(JSON.stringify({ ok: true, evidence: EVIDENCE })));
      return Promise.resolve({ ok: true, value: undefined });
    },
  },
};

let registered = null;
globalThis.window = {
  __ModuleLoader__: { load({ factory }) { registered = factory((spec) => (spec === 'react' ? FakeReact : {})); } },
  localStorage: { getItem: () => null, setItem: () => {} },
  addEventListener() {}, removeEventListener() {},
};

let panel = null;
await import('../client.js');
if (registered === null) { console.log('FAIL  模块没注册'); process.exit(1); }
registered.apply({
  remote: fakeRemote,
  slots: { inject: (name, fn) => fn(), register: (meta, component) => { if (meta.id === 'review-mode-panel') panel = component; } },
});

const collect = (node, predicate, out = []) => {
  if (node === null || typeof node !== 'object') return out;
  if (predicate(node)) out.push(node);
  const kids = node.props?.children;
  const list = Array.isArray(kids) ? kids : (kids === undefined ? [] : [kids]);
  for (const kid of list) collect(kid, predicate, out);
  return out;
};
const hasText = (node, text) => JSON.stringify(node).includes(text);

// 三条**长短差得极大**的评价：领先行各不相同，分析与建议也各不相同。
const CARD = (n, verdict) => ({
  kind: 'review', at: Date.UTC(2026, 9, 3, 14, 32 - n, 0), turn: n, lane: 'me', verdict,
  sections: ANALYSIS_SECTIONS,
  headline: `领先哨兵${n}_最要紧那一句`,
  dialog: [`对话哨兵${n}_你：「……」`],
  summary: `概述哨兵${n}`,
  analysis: [`分析哨兵${n}_第一条`, `分析哨兵${n}_第二条`],
  advice: [`建议哨兵${n}_给用户`, `建议哨兵${n}_给Agent`],
  text: `领先哨兵${n}_最要紧那一句`,
});
const FEED = [CARD(0, 'on-track'), CARD(1, 'drifting'), CARD(2, 'off-track')];

let tree = null;
const render = (projection, sessionId = 's1') => {
  stateSlots.length = 0;
  const props = { sessionId, useSessions: (selector) => selector({ byId: { [sessionId]: { projectionValues: { agentPreset: 'review', reviewMode: projection } } } }) };
  rerender = () => { cursor = 0; tree = panel(props); };
  rerender();
  return tree;
};

tree = render({ feed: FEED });

// ── ① 一条评价一行 ─────────────────────────────────────────
const rows = () => collect(tree, (n) => n.props?.['data-review-row'] !== undefined);
check('评价渲染成**一条一行**（3 条评价 = 3 行）', rows().length === 3, `→ ${rows().length} 行`);
check('每一行的下标就是它在 feed 里的位置',
  JSON.stringify(rows().map((n) => String(n.props['data-review-row']))) === JSON.stringify(['0', '1', '2']),
  JSON.stringify(rows().map((n) => n.props['data-review-row'])));

// ── ② 每行只有前导部分（截断的一行）────────────────────────
for (const index of [0, 1, 2]) {
  const row = rows()[index];
  const rowJson = JSON.stringify(row ?? null);
  check(`第 ${index} 行带自己的**领先行**`, row !== undefined && rowJson.includes(`领先哨兵${index}_最要紧那一句`));
  check(`第 ${index} 行**不带**自己的分析与建议`,
    row !== undefined
    && !rowJson.includes(`分析哨兵${index}`) && !rowJson.includes(`建议哨兵${index}`) && !rowJson.includes(`概述哨兵${index}`),
    rowJson.slice(0, 100));
  check(`第 ${index} 行带结论标签`, row !== undefined && rowJson.includes(['未走偏', '有漂移', '已走偏'][index]));
}
check('反向变异：把「分析」的内容塞进行里，同一条判据会为假',
  rows()[0] !== undefined && !JSON.stringify(rows()[0]).includes('分析哨兵0') && JSON.stringify(FEED[0]).includes('分析哨兵0'));

// ── ③ 等高、单行、截断 ─────────────────────────────────────
const heights = rows().map((n) => n.props?.style?.height);
check('每一行**等高**（同一个固定高度）',
  heights.length > 0 && heights.every((h) => h !== undefined && h === heights[0]), JSON.stringify(heights));
const nowrap = rows().map((n) => [n.props?.style?.whiteSpace, n.props?.style?.textOverflow, n.props?.style?.overflow]);
check('每一行都是单行 + 省略号（不换行、溢出截断）',
  nowrap.length > 0 && nowrap.every(([ws, te, ov]) => ws === 'nowrap' && te === 'ellipsis' && ov === 'hidden'), JSON.stringify(nowrap));

// ── ④ 右栏 = 选中那条的完整分析（默认最新一条）─────────────
const detail = () => collect(tree, (n) => n.props?.['data-review-detail'] !== undefined)[0];
const detailJson = () => JSON.stringify(detail() ?? null);
check('有右栏（data-review-detail）', detail() !== undefined);
check('默认选中的是**最新一条**（下标 2）', String(detail()?.props?.['data-review-detail']) === '2',
  String(detail()?.props?.['data-review-detail']));
check('右栏画出四段分析（具体对话 / 对话概述 / 分析 / 建议）',
  detail() !== undefined
  && ANALYSIS_SECTIONS.every((section) => detailJson().includes(section.title))
  && collect(tree, (n) => n.props?.['data-review-section'] !== undefined).length >= 4,
  detailJson().slice(0, 120));
check('右栏的四段都是**最新那条**的内容（哨兵2）',
  detail() !== undefined && detailJson().includes('对话哨兵2') && detailJson().includes('概述哨兵2')
  && detailJson().includes('分析哨兵2_第二条') && detailJson().includes('建议哨兵2_给Agent'));
check('**不固定条数**：分析 2 条、建议 2 条都画出来了（不是每格一条）',
  detailJson().includes('分析哨兵2_第一条') && detailJson().includes('分析哨兵2_第二条')
  && detailJson().includes('建议哨兵2_给用户') && detailJson().includes('建议哨兵2_给Agent'));
check('反向变异：默认态右栏里**没有**第 0 条的内容（否则「点一下会换」恒真）',
  detail() !== undefined && detailJson().includes('哨兵2') && !detailJson().includes('哨兵0'), detailJson().slice(0, 80));
check('右栏同时有选中的那条结论标签（已走偏）', detail() !== undefined && (detailJson().includes('已走偏') || hasText(detail(), '已走偏')));
check('默认态**没有**「看最新」按钮（已经在最新那条，不需要回退）',
  collect(tree, (n) => n.props?.['data-review-latest'] !== undefined).length === 0);

// ── ⑤ 点左边第 0 行 → 右边换成第 0 条 ──────────────────────
rows()[0]?.props?.onClick();
check('点第 0 行后，右栏改画第 0 条（下标 0）',
  String(detail()?.props?.['data-review-detail']) === '0', String(detail()?.props?.['data-review-detail']));
check('点第 0 行后，右栏出现第 0 条自己的四段内容',
  detail() !== undefined
  && detailJson().includes('对话哨兵0') && detailJson().includes('分析哨兵0_第二条') && detailJson().includes('建议哨兵0_给Agent'),
  detailJson().slice(0, 120));
check('点第 0 行后，右栏**没有**最新那条第 2 条的内容（真的换了，不是叠加）',
  detail() !== undefined && !detailJson().includes('哨兵2'));
check('选中的那一行被标出来（data-review-row-selected=0）',
  JSON.stringify(rows().map((n) => n.props['data-review-row-selected'] ?? null)) === JSON.stringify(['0', null, null]),
  JSON.stringify(rows().map((n) => n.props['data-review-row-selected'] ?? null)));
check('选中一条**不是**最新时，出现「看最新」按钮（data-review-latest）',
  collect(tree, (n) => n.props?.['data-review-latest'] !== undefined).length === 1);

// ── ⑤b **再点同一行 = 取消选中**（退得出来，不必依赖顶栏返回键）──
rows()[0]?.props?.onClick();
check('再点同一行 → 取消选中，右栏回到**最新**那条（下标 2）',
  String(detail()?.props?.['data-review-detail']) === '2', String(detail()?.props?.['data-review-detail']));
check('取消选中后「看最新」按钮消失',
  collect(tree, (n) => n.props?.['data-review-latest'] !== undefined).length === 0);
check('取消选中后回到「跟随最新」：只有最新那一行被标出来',
  JSON.stringify(rows().map((n) => n.props['data-review-row-selected'] ?? null)) === JSON.stringify([null, null, '2']));

// ── ⑤c 「看最新」按钮也能回到最新那条 ──────────────────────
rows()[1]?.props?.onClick();
check('点第 1 行 → 右栏是第 1 条', String(detail()?.props?.['data-review-detail']) === '1');
const latestButton = () => collect(tree, (n) => n.props?.['data-review-latest'] !== undefined)[0];
latestButton()?.props?.onClick();
check('点「看最新」→ 右栏回到最新那条（下标 2）',
  String(detail()?.props?.['data-review-detail']) === '2', String(detail()?.props?.['data-review-detail']));

// ── ⑥ 老卡片（这次改动之前落进日志的，没有 sections）也要画得出来 ──
{
  const keep = tree;
  render({ feed: [{ kind: 'review', verdict: 'drifting', headline: '老卡片_领先行', analysis: ['老卡片_分析'], advice: ['老卡片_建议'], text: '老卡片_领先行' }] });
  check('没有 `sections` 的老卡片也不会空：用兜底段落名画出内容',
    detail() !== undefined && hasText(detail(), '老卡片_分析')
    && hasText(detail(), '具体对话') && hasText(detail(), '建议'),
    detailJson().slice(0, 120));
  tree = keep;
}

// ── ⑦ 状态 3：左栏是清单，右栏是分析（同一列里，不新开界面）──
{
  render({ feed: FEED });
  collect(tree, (n) => n.props?.['data-review-direction'] === 'codex')[0]?.props?.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  collect(tree, (n) => n.props?.['data-review-target'] === 'a1')[0]?.props?.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('状态 3 左栏（data-review-col="q"）就是评价清单：3 行',
    rows().length === 3, `→ ${rows().length} 行`);
  const byCol = (key) => collect(tree, (n) => n.props?.['data-review-col'] === key)[0];
  const flexOf = (node) => String(node?.props?.style?.flex ?? '');
  check('状态 3 仍然是左窄右宽（左 basis < 45%，右可伸展）',
    /4\d%|3\d%/.test(flexOf(byCol('q'))) && /^1\b/.test(flexOf(byCol('a'))),
    `左=${flexOf(byCol('q'))} · 右=${flexOf(byCol('a'))}`);
  check('状态 3 右栏是选中那条的完整分析（四段在）',
    byCol('a') !== undefined && hasText(byCol('a'), '分析哨兵2_第二条')
    && String(detail()?.props?.['data-review-detail']) === '2');
  check('“你当时说的话”和针对评价的对话框还在（都在同一列里，没有新开界面）',
    byCol('q') !== undefined
    && hasText(byCol('q'), '你当时说的话') && collect(byCol('q'), (n) => n.props?.['data-review-ask'] !== undefined).length === 1);
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
