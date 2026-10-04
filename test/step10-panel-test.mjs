/**
 * 第 10 / 11 步的走查测试：**面板状态 3 的版面**与**报错也要给出路**。
 *
 * FLOW.md 第 10 步「状态 3」的期望原文：
 *   左窄栏「问 · 你当时说的话」＋筛选；右宽栏上「总结」下「分析＋证据＋建议」
 * 实际（改前）：两栏都是 `flex: 1 1 0`（一样宽）、左栏没有任何筛选控件、
 * 复审的「总结」（卡片里的 `text`，也就是「一句话」）**整个被丢掉**，从来没渲染过。
 *
 * FLOW.md 第 11 步的期望原文：
 *   任何远程调用 4 秒内出结果，否则变成一句人话，并提示「改用对话里的可点选项」
 * 实际（改前）：超时和「远程缺失」都有这句提示，**报错分支没有** ——
 * 只显示「读目录失败：<原始报错>」，用户不知道还有原生可点选项那条路。
 *
 * 另外钉一条文档一致性：第 10 步的状态 3 曾经写成 `select` + `evidence`，
 * 但 `client.js` 刻意**不调** `select`（选中的记录由宿主的 `review_conversation`
 * 工具做，`client-test.mjs` 里有一条断言专门守这件事）。文档与代码不许再打架。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

let failed = 0;
const check = (label, pass, extra = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  ${extra}`}`);
  if (!pass) failed += 1;
};

// ── 有状态的极小 React（同 client-test.mjs）──────────────────
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

// ── 假的宿主入口：`ctx.remote.commands.execute(sessionId, line, [])` ──
const RECENT = [
  { id: 'a1', kind: 'codex', project: '5005复习', title: '细节问答', label: '5005复习 / 细节问答', age: '3 分钟前' },
];
const DIRECTORY = {
  kind: 'codex',
  total: 1,
  recent: RECENT,
  groups: [{ project: '5005复习', count: 1, conversations: [{ id: 'a1', kind: 'codex', title: '细节问答', age: '3 分钟前' }] }],
  selected: null,
};
const EVIDENCE = {
  title: '5005复习 / 细节问答',
  cwd: '/tmp/review-fixture/Desktop/5005',
  youSaid: ['第一句：课件当中有讲这几个算法吗？', '第二句：那个文件到底在哪'],
  background: ['命令 ls'],
  stats: '你说 2 条',
};
const reply = (text) => ({ ok: true, value: { commandId: 'c1', result: { kind: 'success', text } } });
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
  __reviewRemoteTimeoutMs: 60,
};

let panel = null;
await import('../client.js');
if (registered === null) { console.log('FAIL  模块没注册'); process.exit(1); }
registered.apply({
  remote: fakeRemote,
  slots: { inject: (name, fn) => fn(), register: (meta, component) => { if (meta.name === 'shell.overlay') panel = component; } },
});

const propsFor = (projection) => ({
  sessionId: 's1',
  useSessions: (selector) => selector({
    byId: { s1: { projectionValues: { agentPreset: 'review', reviewMode: projection } } },
  }),
});

const collect = (node, predicate, out = []) => {
  if (node === null || typeof node !== 'object') return out;
  if (predicate(node)) out.push(node);
  const kids = node.props?.children;
  const list = Array.isArray(kids) ? kids : (kids === undefined ? [] : [kids]);
  for (const kid of list) collect(kid, predicate, out);
  return out;
};
const hasText = (t, text) => JSON.stringify(t).includes(text);
const byDirection = (t, value) => collect(t, (n) => n.props?.['data-review-direction'] === value)[0];
const byTarget = (t, id) => collect(t, (n) => n.props?.['data-review-target'] === id)[0];
const byCol = (t, key) => collect(t, (n) => n.props?.['data-review-col'] === key)[0];

// 结论里放一个只可能出现在卡片 `text`（「一句话」/总结）里的哨兵字符串。
const FEED = [{
  verdict: 'drifting',
  text: '总结哨兵_注意力从课件滑到了路径',
  headline: '总结哨兵_注意力从课件滑到了路径',
  sections: [
    { key: 'dialog', title: '具体对话' }, { key: 'summary', title: '对话概述' },
    { key: 'analysis', title: '分析' }, { key: 'advice', title: '建议' },
  ],
  dialog: ['你说：「课件讲没讲」'],
  summary: '从「课件讲没讲」滑到「文件在哪」。',
  analysis: ['路径转了两轮。'],
  advice: ['下一条就一句。'],
  cost: 4000,
}];

let props = propsFor({ feed: FEED });
let tree = null;
rerender = () => { cursor = 0; tree = panel(props); };
rerender();

// ── 走到状态 3 ────────────────────────────────────────────────
byDirection(tree, 'codex').props.onClick();
await new Promise((resolve) => setTimeout(resolve, 0));
byTarget(tree, 'a1').props.onClick();
await new Promise((resolve) => setTimeout(resolve, 0));
check('前提：已经到状态 3（右栏出现四段分析）', hasText(tree, '具体对话') && hasText(tree, '分析'));

// ── BUG-A：状态 3 的版面 ─────────────────────────────────────
check('状态 3 右宽栏渲染了「总结」（卡片 text，改前整条被丢掉）',
  hasText(tree, '总结哨兵_注意力从课件滑到了路径'));

const left = byCol(tree, 'q');
const right = byCol(tree, 'a');
const flexOf = (node) => String(node?.props?.style?.flex ?? '');
const basisPct = (node) => {
  const match = /(\d+(?:\.\d+)?)%/.exec(flexOf(node));
  return match === null ? null : Number(match[1]);
};
const growOf = (node) => Number((/^(\d+)/.exec(flexOf(node)) ?? [])[1] ?? NaN);
check('状态 3 是左窄右宽（两栏 flex 不再相同）',
  left !== undefined && right !== undefined && flexOf(left) !== flexOf(right),
  `左=${flexOf(left) || '(无 data-review-col=q)'} · 右=${flexOf(right) || '(无 data-review-col=a)'}`);
check('状态 3 左栏明显窄于右栏（左 basis < 45%，右可伸展）',
  basisPct(left) !== null && basisPct(left) < 45 && growOf(right) === 1,
  `左 basis=${String(basisPct(left))}% · 右 grow=${String(growOf(right))}`);

const filterInput = collect(tree, (n) => n.props?.['data-review-filter'] !== undefined)[0];
check('状态 3 左栏有「筛选」控件', filterInput !== undefined);
if (filterInput !== undefined) {
  filterInput.props.onChange({ target: { value: '第二句' } });
  check('筛选后左栏只剩匹配的那句原话',
    hasText(tree, '第二句：那个文件到底在哪') && !hasText(tree, '第一句：课件当中有讲这几个算法吗？'));
  filterInput.props.onChange({ target: { value: '' } });
  check('清空筛选后两句原话都回来',
    hasText(tree, '第一句：课件当中有讲这几个算法吗？') && hasText(tree, '第二句：那个文件到底在哪'));
}

// ── BUG-B：报错也要给出路（第 11 步）────────────────────────
const clickBackOnce = () => {
  const back = collect(tree, (n) => typeof n.props?.children === 'string' && n.props.children.startsWith('← 返回'))[0];
  if (back !== undefined) back.props.onClick();
};
clickBackOnce();   // 3 → 2
clickBackOnce();   // 2 → 1
fakeRemote.commands.execute = () => { throw new Error('cordis: cannot get property "remote" without inject'); };
byDirection(tree, 'dsh').props.onClick();
await new Promise((resolve) => setTimeout(resolve, 0));
check('面板指令「报错」时也给出一句人话', hasText(tree, '面板指令失败'));
check('面板指令「报错」时提示改用对话里的可点选项（改前只有超时/缺失才有这句）',
  hasText(tree, '可点选项'), hasText(tree, '可点选项') ? '' : '只有原始报错，没有出路');

// ── BUG-C：第 10 步状态 3 的远程调用列不许再写 select ────────
const flow = fs.readFileSync(path.join(root, 'FLOW.md'), 'utf8');
const stateThreeRow = flow.split('\n').find((line) => /^\|\s*3\s*\|/.test(line)) ?? '';
check('FLOW.md 第 10 步状态 3 的远程调用列不再声称调 `select`（client.js 刻意不调它）',
  stateThreeRow.length > 0 && !/\bselect\b/.test(stateThreeRow),
  stateThreeRow.trim().slice(0, 120));

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
