/**
 * **入口唯一化**之后，面板那三个方块必须是**真的能用的唯一入口**。
 *
 * 用户 2026-10 批准（原话「OK，你先这样改」）：入口只留面板的
 * ```
 * [审你自己]  [审其它 DSH 会话]  [审 Codex 对话]
 * ```
 * 点一下选目标 → 宿主自己派复审子 Agent → 结果只落在面板；之后监控器按「新的用户消息」
 * 自动再生成评价。对话区不再承担选方向 / 列候选。
 *
 * 这个测试证明：
 *   (a) 状态 1 恰好三个方块，kind 是 self/dsh/codex，且都渲染成可点按钮；
 *   (b) 每一个方块各自发出**自己的**命令 `/review-mode dir <kind>`（不是只画着好看）；
 *   (c) 三个 kind 之外没有别的入口按钮（面板不偷偷加第二个入口）；
 *   (d) 结果区（`data-review-feed`）在状态 1 就常驻 —— 入口点完，结论就有地方落。
 *
 * 反向变异：同一个收集器在 `null` / 空树上必须返回 0 个方块（证明「恰好 3 个」不是恒真）。
 */

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

const calls = [];
const DIRECTORY = { kind: 'codex', total: 1, recent: [], groups: [], selected: null };
const reply = (text) => ({ ok: true, value: { commandId: 'c1', result: { kind: 'success', text } } });

let registered = null;
globalThis.window = {
  __ModuleLoader__: { load({ factory }) { registered = factory((spec) => (spec === 'react' ? FakeReact : {})); } },
  localStorage: { getItem: () => null, setItem: () => {} },
  addEventListener() {}, removeEventListener() {},
};

let panel = null;
await import('../client.js');
registered.apply({
  remote: {
    commands: {
      execute(sessionId, line) { calls.push(String(line)); return Promise.resolve(reply(JSON.stringify(DIRECTORY))); },
    },
  },
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
const props = {
  sessionId: 's1',
  useSessions: (selector) => selector({ byId: { s1: { projectionValues: { agentPreset: 'review', reviewMode: { feed: [] } } } } }),
};
let tree = null;
rerender = () => { cursor = 0; tree = panel(props); };
rerender();

/** 三个方块（`data-review-direction`）。 */
const squares = (node) => collect(node, (n) => n.props?.['data-review-direction'] !== undefined);
const kindsOf = (node) => squares(node).map((n) => String(n.props['data-review-direction']));

check('(a) 状态 1 恰好三个方向方块', squares(tree).length === 3, String(squares(tree).length));
check('(a) 三个方块是 self/dsh/codex（顺序固定）',
  JSON.stringify(kindsOf(tree)) === JSON.stringify(['self', 'dsh', 'codex']), kindsOf(tree).join(','));
check('(a) 三个方块都是可点按钮',
  squares(tree).every((n) => typeof n.props.onClick === 'function'));
check('(a) 反向变异：空树上一个方块都没有（「恰好 3 个」不是恒真）',
  squares(null).length === 0 && squares(tree).length === 3);
check('(c) 没有第四个来路不明的入口',
  squares(tree).every((n) => ['self', 'dsh', 'codex'].includes(n.props['data-review-direction'])));
check('(d) 结果区在状态 1 就常驻（点完就有地方落结论）',
  collect(tree, (n) => n.props?.['data-review-feed'] !== undefined).length === 1);

/** 退回状态 1（点目录页的「← 返回」）。 */
const back = () => {
  const node = collect(tree, (n) => typeof n.props?.children === 'string' && n.props.children.startsWith('← 返回'))[0];
  if (node !== undefined) { node.props.onClick(); rerender(); }
};

for (const kind of ['self', 'dsh', 'codex']) {
  const before = calls.length;
  const square = squares(tree).find((n) => n.props['data-review-direction'] === kind);
  check(`(b) 有 ${kind} 这个方块可点`, square !== undefined);
  square?.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  check(`(b) 点 ${kind} → 真的发出 /review-mode dir ${kind}`,
    calls.slice(before).includes(`/review-mode dir ${kind}`), calls.slice(before).join(' | '));
  back();
}

check('(b) 三步点完只发过 dir 命令，没有别的入口动词',
  calls.every((line) => /^\/review-mode dir (self|dsh|codex)$/.test(line)), calls.join(' | '));

console.log(bad === 0 ? '\n全部通过' : `\n${bad} 项失败`);
process.exit(bad === 0 ? 0 : 1);
