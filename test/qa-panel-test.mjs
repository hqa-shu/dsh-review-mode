/**
 * 面板上的「针对评价的问答」——用户 2026-10 第二次澄清：
 *   「点进去问答，我是针对你的评价问答……话旁左边有一个对话框，我可以问相关的内容」。
 *
 * 三条要成立：
 *   1. 对话框在**左栏**（`data-review-col="q"` 里能找到它）；
 *   2. 提交走宿主会话命令 `commands.execute("/review-mode ask <问题>")` ——
 *      不驱动复审、不重置流；
 *   3. 问答条目在**同一个流**里但带 `data-review-qa`，与自动评价一眼可分。
 *
 * 普通 Node，不用重启（客户端改动只要刷新页面）。
 */

// ── 有状态极小 React（同 client-test）────────────────────────
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

const calls = [];
const RECENT = [{ id: 'a1', kind: 'codex', project: '5005复习', title: '细节问答', label: '5005复习 / 细节问答', age: '3 分钟前' }];
const DIRECTORY = { kind: 'codex', total: 1, recent: RECENT, groups: [{ project: '5005复习', count: 1, conversations: [{ id: 'a1', kind: 'codex', title: '细节问答', age: '3 分钟前' }] }], selected: null };
const EVIDENCE = { title: '5005复习 / 细节问答', cwd: '/w', youSaid: ['你查查课件当中有讲这几个算法吗'], background: [], otherSaid: [], stats: '你说 1 条', lane: 'me' };
const reply = (text) => ({ ok: true, value: { commandId: 'c1', result: { kind: 'success', text } } });
const fakeRemote = {
  commands: {
    execute(_sessionId, line) {
      const parts = String(line).trim().split(/\s+/);
      calls.push([parts[1], line]);
      if (parts[1] === 'dir') return Promise.resolve(reply(JSON.stringify(DIRECTORY)));
      if (parts[1] === 'pick') return Promise.resolve(reply(JSON.stringify({ ok: true, evidence: EVIDENCE })));
      if (parts[1] === 'ask') return Promise.resolve(reply('按「② 局部纠结」这一行：审我=在页码上转了两轮'));
      return Promise.resolve({ ok: true, value: undefined });
    },
  },
};

let registered = null;
globalThis.window = {
  __ModuleLoader__: { load({ factory }) { registered = factory((spec) => (spec === 'react' ? FakeReact : {})); } },
  localStorage: { getItem: () => null, setItem: () => {} },
  addEventListener() {}, removeEventListener() {},
  __reviewRemoteTimeoutMs: 60,
};

let panel = null;
await import('../client.js');
registered.apply({ remote: fakeRemote, slots: { inject: (name, fn) => fn(), register: (meta, component) => { if (meta.name === 'shell.overlay') panel = component; } } });

let bad = 0;
const check = (label, pass, detail = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `  ${detail}`}`);
  if (!pass) bad += 1;
};

const SECTIONS = [
  { key: 'dialog', title: '具体对话' }, { key: 'summary', title: '对话概述' },
  { key: 'analysis', title: '分析' }, { key: 'advice', title: '建议' },
];
const REVIEW_CARD = {
  kind: 'review', verdict: 'drifting', lane: 'me', text: '有漂移',
  sections: SECTIONS,
  headline: '有漂移_领先行',
  dialog: ['你说：「收窄」'],
  summary: '在收窄范围。',
  analysis: ['分析哨兵_它站不住'],
  advice: ['建议哨兵_先给样例'],
};
const QA_ENTRY = { kind: 'qa', question: '② 展开讲讲', text: '按「分析」这一段：分析哨兵_它站不住' };

const propsFor = (projection) => ({
  sessionId: 's1',
  useSessions: (selector) => selector({ byId: { s1: { projectionValues: { agentPreset: 'review', reviewMode: projection } } } }),
});

rerender = () => { cursor = 0; tree = panel(props); };
let props = propsFor({ feed: [REVIEW_CARD] });
let tree = null;
rerender();

const collect = (node, predicate, out = []) => {
  if (node === null || typeof node !== 'object') return out;
  if (predicate(node)) out.push(node);
  const kids = node.props?.children;
  const list = Array.isArray(kids) ? kids : (kids === undefined ? [] : [kids]);
  for (const kid of list) collect(kid, predicate, out);
  return out;
};
const byProp = (t, key) => collect(t, (n) => n.props?.[key] !== undefined)[0];
const hasText = (t, text) => JSON.stringify(t).includes(text);
/** 某个节点子树里有没有带这个 prop 的后代。 */
const subtreeHas = (node, key) => collect(node, (n) => n.props?.[key] !== undefined).length > 0;

// 走到状态 3（选方向 → 选对话）
byProp(tree, 'data-review-direction'); // 触发收集（保持与 client-test 相同的调用形态）
collect(tree, (n) => n.props?.['data-review-direction'] === 'codex')[0].props.onClick();
await new Promise((r) => setTimeout(r, 0));
collect(tree, (n) => n.props?.['data-review-target'] === 'a1')[0].props.onClick();
await new Promise((r) => setTimeout(r, 0));
props = propsFor({ feed: [REVIEW_CARD, QA_ENTRY] });
rerender();

check('状态 3 有左栏（data-review-col="q"）', byProp(tree, 'data-review-col') !== undefined || collect(tree, (n) => n.props?.['data-review-col'] === 'q').length === 1);
const leftCol = collect(tree, (n) => n.props?.['data-review-col'] === 'q')[0];
check('对话框在**左栏**里', leftCol !== undefined && subtreeHas(leftCol, 'data-review-ask'), leftCol === undefined ? '没有左栏' : '');
const askSubmit = byProp(tree, 'data-review-ask-submit');
check('左栏有提交按钮', askSubmit !== undefined && typeof askSubmit.props.onClick === 'function');

// 输入并提交
const askInput = byProp(tree, 'data-review-ask');
askInput.props.onChange({ target: { value: '② 展开讲讲' } });
rerender();
byProp(tree, 'data-review-ask-submit').props.onClick();
await new Promise((r) => setTimeout(r, 0));
check('提交走宿主会话命令 /review-mode ask <问题>',
  calls.some(([verb, line]) => verb === 'ask' && line === '/review-mode ask ② 展开讲讲'),
  JSON.stringify(calls.filter(([verb]) => verb === 'ask')));
check('提问**不**驱动复审（没有额外的 dir/pick 调用）',
  calls.filter(([verb]) => verb === 'dir').length === 1 && calls.filter(([verb]) => verb === 'pick').length === 1);

// 问答条目：同一个流里，但带 data-review-qa，和自动评价可分
const qaNodes = collect(tree, (n) => n.props?.['data-review-qa'] !== undefined);
check('问答条目渲染成可分辨的 data-review-qa', qaNodes.length === 1, `→ ${qaNodes.length} 个`);
check('问答条目同时显示问题和回答', hasText(tree, '② 展开讲讲') && hasText(tree, '分析哨兵_它站不住'));
check('自动评价仍然在同一个流里（四段分析也在）', hasText(tree, '具体对话') && hasText(tree, '建议哨兵_先给样例'));
check('自动评价那张卡片**没有**被标成问答',
  collect(tree, (n) => n.props?.['data-review-qa'] !== undefined).length === 1
  && hasText(tree, '有漂移'));

console.log(bad === 0 ? '\n全部通过' : `\n${bad} 项失败`);
process.exit(bad === 0 ? 0 : 1);
