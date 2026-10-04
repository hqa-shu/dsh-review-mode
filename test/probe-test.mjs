/**
 * B 的证明：**只读探测，不改行为**。
 *
 * 背景（真发生过）：客户端插件的 `inject` 是 cordis 的**硬依赖**。我们一度写了
 * `inject: ['slots','remote','remote.reviewRemote']`，`remote.reviewRemote` 永远
 * 解析不出来 → 这个 fiber 一直 pending → web boot 把「1 entry did not activate」
 * 当启动失败 → **整个应用打不开**。abort 回 `inject: ['slots']` 才恢复。
 *
 * 所以现在的规矩是：
 *   - 顶层 `inject` 里只放**已在 shipped 源码里找到提供者**的服务；
 *   - 想「看看有什么」就用 `ctx.get('名字')` —— cordis 文档原文
 *     「Read a service from the store without the inject requirement」，
 *     shipped 客户端插件的先例：`dsh-client-ui-conversation/lib/client.js:14171`
 *     `ctx.get("productAnalytics")?.track(...)`。
 *
 * 这个测试证明四件事：
 *   1. 诊断行**四个探针全部走 `ctx.get`**（不是属性访问）；
 *   2. 未知名字返回 undefined 时，面板照常渲染、诊断写「无」、**不抛不挂**；
 *   3. 正对照（`remote` / `remote.commands` / `remote.agentPresets`）返回对象时写「有」；
 *   4. `ctx.get` 本身抛异常（cordis 对某些未声明名字会抛）也吞得住，
 *      并且把原文附在诊断行末尾。
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

let failed = 0;
const check = (label, pass, extra = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  ${extra}`}`);
  if (!pass) failed += 1;
};

/** 探测记录：证明走的是 ctx.get，而不是 `ctx.remote.xxx` 属性访问。 */
const probed = [];
const services = {
  remote: { marker: 'remote' },
  'remote.commands': { marker: 'commands' },
  'remote.agentPresets': { marker: 'agentPresets' },
  // `remote.reviewRemote` 刻意缺席 —— 它就是那个永远不存在的名字。
};
const throwing = new Set();
const fakeCtx = {
  get(name) {
    probed.push(name);
    if (throwing.has(name)) throw new Error(`cannot get property "${name}" without inject`);
    return services[name];
  },
  slots: { inject: (name, fn) => fn(), register: (meta, component) => { globalThis.__meta = meta; if (meta.name === 'shell.overlay') globalThis.__panel = component; } },
};

let registered = null;
globalThis.window = {
  __ModuleLoader__: { load({ factory }) { registered = factory((spec) => (spec === 'react' ? FakeReact : {})); } },
  localStorage: { getItem: () => null, setItem: () => {} },
  addEventListener() {}, removeEventListener() {},
  __reviewRemoteTimeoutMs: 60,
};

await import('../client.js');
if (registered === null) { console.log('FAIL  模块没注册'); process.exit(1); }

check('inject 仍然只有 slots（绝不把探针名字写进硬依赖）',
  Array.isArray(registered.inject) && registered.inject.length === 1 && registered.inject[0] === 'slots',
  JSON.stringify(registered.inject));

registered.apply(fakeCtx);
const panel = globalThis.__panel;
const props = {
  sessionId: 's1',
  useSessions: (selector) => selector({ byId: { s1: { projectionValues: { agentPreset: 'review', reviewMode: { feed: [] } } } } }),
};
const collect = (node, predicate, out = []) => {
  if (node === null || typeof node !== 'object') return out;
  if (predicate(node)) out.push(node);
  const kids = node.props?.children;
  const list = Array.isArray(kids) ? kids : (kids === undefined ? [] : [kids]);
  for (const kid of list) collect(kid, predicate, out);
  return out;
};
const diagOf = (tree) => collect(tree, (n) => typeof n.props?.['data-review-diag'] === 'string')[0]?.props['data-review-diag'] ?? '';

let tree = null;
rerender = () => { cursor = 0; tree = panel(props); };
rerender();

check('面板渲染出来了（探测不改变渲染）', tree !== null);
const diag = diagOf(tree);
check('四个探针都走了 ctx.get',
  ['remote', 'remote.commands', 'remote.agentPresets', 'remote.reviewRemote'].every((name) => probed.includes(name)),
  probed.join(', '));
check('正对照 remote=有', /ctx\.remote=有/.test(diag), diag);
check('正对照 commands=有', /commands=有/.test(diag), diag);
check('正对照 agentPresets=有', /agentPresets=有/.test(diag), diag);
check('未知名字 reviewRemote=无 且 typeof=undefined',
  /reviewRemote=无/.test(diag) && /typeof=undefined/.test(diag), diag);

// ── ctx.get 抛异常也必须吞得住 ──────────────────────────────
throwing.add('remote.reviewRemote');
rerender();
const thrownDiag = diagOf(tree);
check('ctx.get 抛异常时面板照常渲染', tree !== null);
check('抛异常也写进诊断行（附 cordis 原文）',
  /取不到：.*without inject/.test(thrownDiag), thrownDiag);
throwing.delete('remote.reviewRemote');

// ── 全部未知：诊断是四个「无」，仍然不抛 ───────────────────
for (const key of Object.keys(services)) delete services[key];
rerender();
const emptyDiag = diagOf(tree);
check('四个都没有时诊断写四个「无」',
  /ctx\.remote=无/.test(emptyDiag) && /commands=无/.test(emptyDiag)
  && /agentPresets=无/.test(emptyDiag) && /reviewRemote=无/.test(emptyDiag),
  emptyDiag);

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
