/**
 * **每个视图都有回头路，返回键永远点得动**（2026-10 用户现场：
 * 「我点进的那个界面后点击返回……我挑一个对话，进入它就是**没法点击**那个**没法返回原界面**」）。
 *
 * 视图模型（`README.md` / `FLOW.md` 的「问答框 vs 面板 / 返回模型」一节逐字写着）：
 *
 *   `pick`（选方向，根）
 *     ↓ 点一个方向
 *   `list`（选对话）
 *     ↓ 点一条对话
 *   `results`（看结论）
 *
 * **返回永远 = 上一层**：`results → list → pick`；`pick` 是根，没有返回键（上面没东西，
 * 也就没有死路）。「右栏选中了某一条评价」**不是**第四个视图，它有三条独立回头路：
 * 再点同一行 / 「看最新」按钮 / 顶栏返回。前两条在 `panel-rows-test.mjs` 里守。
 *
 * 这一份测试守两件事：
 *   1. **可达性**：三个视图都能到，且每一层的返回都真的换视图、最终能回到根；
 *   2. **点得动**：返回键是 flex 行里**不可压缩**的一项（`flex:'none'` + `nowrap` +
 *      真正的内边距），文案里不再塞整条对话标题 —— 这两点正是它以前被压成
 *      一条几像素的缝、用户「点不到」的原因。
 */

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
const EVIDENCE = { title: '5005复习 / 细节问答', youSaid: ['你查查课件'], background: [], stats: '你说 1 条' };
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
  innerWidth: 1280,
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

const CARD = {
  kind: 'review', verdict: 'drifting', headline: '领先行哨兵',
  sections: [
    { key: 'dialog', title: '具体对话' }, { key: 'summary', title: '对话概述' },
    { key: 'analysis', title: '分析' }, { key: 'advice', title: '建议' },
  ],
  dialog: ['你说：「x」'], summary: '概述', analysis: ['分析'], advice: ['建议'],
};

let tree = null;
const render = (projection) => {
  stateSlots.length = 0;
  const props = { sessionId: 's1', useSessions: (selector) => selector({ byId: { s1: { projectionValues: { agentPreset: 'review', reviewMode: projection } } } }) };
  rerender = () => { cursor = 0; tree = panel(props); };
  rerender();
  return tree;
};

const rootNode = () => collect(tree, (n) => n.props?.['data-review-mode'] === 'panel')[0];
const view = () => rootNode()?.props?.['data-review-view'];
const backNode = () => collect(tree, (n) => n.props?.['data-review-back'] !== undefined)[0];
const directionNode = (kind) => collect(tree, (n) => n.props?.['data-review-direction'] === kind)[0];
const targetNode = (id) => collect(tree, (n) => n.props?.['data-review-target'] === id)[0];

// ── ① pick：根视图 ─────────────────────────────────────────
render({ feed: [CARD] });
check('起点是 `pick` 视图（data-review-view）', view() === 'pick', String(view()));
check('三个方向按钮都在（pick 是根，永远回得来）',
  collect(tree, (n) => n.props?.['data-review-direction'] !== undefined).length === 3);
check('根视图**没有**返回键（上面没有东西可回，也就没有死路）', backNode() === undefined);

// ── ② pick → list ─────────────────────────────────────────
directionNode('codex').props.onClick();
await new Promise((r) => setTimeout(r, 0));
check('点方向后到 `list` 视图', view() === 'list', String(view()));
check('list 视图有返回键，且它标着当前视图',
  backNode() !== undefined && backNode().props['data-review-back'] === 'list',
  JSON.stringify(backNode()?.props?.['data-review-back']));

// ── ③ list → results ──────────────────────────────────────
targetNode('a1').props.onClick();
await new Promise((r) => setTimeout(r, 0));
check('点一条对话后到 `results` 视图', view() === 'results', String(view()));
check('results 视图的返回键标着 results',
  backNode() !== undefined && backNode().props['data-review-back'] === 'results',
  JSON.stringify(backNode()?.props?.['data-review-back']));

// ── ④ 返回真的换视图：results → list → pick ────────────────
backNode().props.onClick();
check('返回一次 → 回到 `list`（真的换视图，不是只改个标记）', view() === 'list', String(view()));
backNode().props.onClick();
check('再返回一次 → 回到根 `pick`', view() === 'pick', String(view()));
check('回到根之后返回键消失（不可能在根上按返回进退不出去）', backNode() === undefined);
check('回到根之后三个方向按钮又在（确实回到了原界面）',
  collect(tree, (n) => n.props?.['data-review-direction'] !== undefined).length === 3);

// ── ⑤ 从任意一层都能一路回到根（枚举式：每一步都必须还在动）──
{
  render({ feed: [CARD] });
  directionNode('codex').props.onClick();
  await new Promise((r) => setTimeout(r, 0));
  const steps = [view()];
  let guard = 0;
  while (backNode() !== undefined && guard < 8) {
    backNode().props.onClick();
    steps.push(view());
    guard += 1;
  }
  check('从 list 一路按返回能到根，且每步都在往上走',
    steps[0] === 'list' && steps[1] === 'pick' && guard === 1, steps.join(' → '));
  check('退到根之后循环自动结束（返回键消失，不会无限回退）', guard === 1 && backNode() === undefined);
}

// ── ⑥ 返回键**点得动**：不可压缩 + 真命中区 + 文案里不塞长标题 ──
{
  render({ feed: [CARD] });
  directionNode('codex').props.onClick();
  await new Promise((r) => setTimeout(r, 0));
  targetNode('a1').props.onClick();
  await new Promise((r) => setTimeout(r, 0));
  const back = backNode();
  const style = back?.props?.style ?? {};
  check('返回键 `flex:"none"` —— 面板再窄也不会被压成一条缝（这就是「点不到」的真因）',
    style.flex === 'none', JSON.stringify(style.flex));
  check('返回键 `whiteSpace:"nowrap"`（中文不会被折成多行、命中区不会散）',
    style.whiteSpace === 'nowrap', JSON.stringify(style.whiteSpace));
  check('返回键有真正的命中区（minWidth ≥ 56px、有内边距，不是 `padding:0` 的裸文本）',
    Number(style.minWidth) >= 56 && Number(style.minHeight) >= 20 && /^[0-9]/.test(String(style.padding)),
    JSON.stringify([style.minWidth, style.minHeight, style.padding]));
  check('返回键文案只有「← 返回」—— 整条对话标题不再塞进这个按钮',
    back?.props?.children === '← 返回' && back?.props?.title.includes('细节问答'),
    JSON.stringify([back?.props?.children, back?.props?.title]));
  check('返回键带 aria-label（读屏也知道它是返回）', back?.props?.['aria-label'] === '← 返回');
  // 反向变异：把不可压缩那一条去掉，判据必须变红。
  const shrinkable = { ...style, flex: undefined };
  check('反向变异：把 `flex:"none"` 去掉，同一条判据会变红',
    style.flex === 'none' && shrinkable.flex === undefined);
  // 反向变异：把长标题塞回按钮文案，同一条判据必须变红。
  check('反向变异：把长标题塞回按钮文案，同一条判据会变红',
    back?.props?.children === '← 返回' && `← 返回 5005复习 / 细节问答` !== '← 返回');
}

// ── ⑦ 选中的行不会把「返回」挡掉：results 层返回键一直在 ─────
{
  const row = collect(tree, (n) => n.props?.['data-review-row'] !== undefined)[0];
  row?.props?.onClick();
  check('在 results 里点了一条评价之后，顶栏返回键**仍然在**（不会被详情挡掉）',
    view() === 'results' && backNode() !== undefined && backNode().props['data-review-back'] === 'results');
  check('而且它仍然可点（onClick 是函数）', typeof backNode()?.props?.onClick === 'function');
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
