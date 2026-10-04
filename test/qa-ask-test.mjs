/**
 * 面板左栏的「问 · 针对这条评价」框（bug 54，2026-10 用户现场）。
 *
 * 用户原话：「还有话我那边问话，现在还是显示不任何」。
 * 现场（`/tmp/dsh-review-watch.jsonl`，electron:true 的那一份）：`ask` 命令之后
 * **一条投递记录都没有** —— 那条正在跑的宿主还在用旧的 `developer/message` 投递，
 * 而它是步事件、在没有开着的 turn/step 时结构上就投不出去（见 bug 50）。
 *
 * 代码里真正的缺陷不是「投递格式」（`panelAsk` 现在用的已经是 `user/message`），
 * 而是**答案只有这一条投递通道，而且失败是静默的**：
 *   - 宿主 `index.js:2935` 的 `catch { /* ... *\/ }` 把投递失败整个吞掉，照旧回 `success`；
 *   - 客户端 `client.js:732-735` 拿到回答后**丢掉**（`res.text` 只在失败时用）；
 * 于是那条通道一断，用户看到的就是：输入框清空、命令成功、**屏幕上一个字都没有**。
 *
 * 这个测试钉三件事：
 *   1. 宿主那一路（真 `Session`）确实走 `user/message` + `source.kind=review-mode`
 *      + `form:'qa'`（不许退回 `developer/message` / `agent.inject`）；
 *   2. **投递没落地时，面板仍然要把回答显示出来** —— 回答是命令同步返回的，
 *      不该依赖任何异步通道；而且它要出现在**你打字的那个框下面**（左栏）；
 *   3. 投递落地之后**只有一份**（本地回显与投影条目去重，不许变成两句）。
 *
 * 反向变异：把命令回答换成空串（模拟「真的没答出来」），(2) 的判据必须为假。
 */

import { Session } from '@deepseek-ai/dsh-session';
import { ANALYSIS_SECTIONS } from '../rubric.js';

let failed = 0;
const check = (label, pass, extra = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  ${extra}`}`);
  if (!pass) failed += 1;
};

const QUESTION = '分析 展开讲讲';
const ANSWER = '按「分析」这一段：这个结论来自左栏第一条原话';

// ══════════════════════════════════════════════════════════
// 1. 宿主侧：真 Session，`ask` 必须走 user/message
// ══════════════════════════════════════════════════════════
let hostDeliver = null;
{
  const indexMod = await import(new URL('../index.js', import.meta.url).pathname);
  const session = Session.create('qa-ask');
  const agent = { id: 'qa-ask', session, injects: [], inject(m) { this.injects.push(m); } };
  let projectionDef = null;
  let projectionState = null;
  const registered = new Map();
  indexMod.apply({
    logger: { warn: () => {}, info() {} },
    reflect: { provide: () => {}, get: () => undefined },
    effect: (fn) => fn(),
    on: () => {},
    inject: (names, cb) => {
      const scope = {
        names,
        get: (name) => (name === 'commands' ? scope.commands : undefined),
        effect: (fn) => fn(),
        commands: { register(def) { registered.set(def.name, def); return () => {}; } },
      };
      cb(scope);
    },
    sessionProjections: {
      register: (def) => { projectionDef = def; return () => {}; },
      stateOf: (s, k) => (k === 'agentPreset' ? 'review' : projectionState),
    },
    subagents: { start: async () => ({ id: 'r', result: Promise.resolve({ output: [] }), dispose: async () => {} }) },
    agents: { list: () => [agent], get: () => agent, withoutInitiator: (o) => o() },
  }, { watchIntervalMs: 600000, watchCodex: false });

  projectionState = projectionDef.init(session.header, 0);
  projectionState = projectionDef.apply(projectionState, {
    type: 'user/message', seq: 1,
    data: {
      id: 'r1', role: 'user',
      source: {
        kind: 'review-mode', form: 'notice',
        review: {
          lane: 'me', turn: 1, verdict: 'drifting', sections: ANALYSIS_SECTIONS,
          headline: '有漂移', dialog: ['你说：「收窄」'], summary: '在收窄范围。',
          analysis: ['分析哨兵'], advice: ['建议哨兵'],
          openIssues: [], resolvedIssues: [], forUser: [], forAgent: [],
        },
      },
      content: [{ type: 'text', text: 'x' }],
    },
  });

  const result = registered.get('review-mode').handler({ agent, rawInput: ` ask ${QUESTION}`, commandId: 'c', attachments: [], signal: new AbortController().signal });
  const events = session.snapshotEvents();
  const surfaced = events.filter((e) => e.type === 'user/message');
  hostDeliver = {
    result,
    surfaced,
    developerMessages: events.filter((e) => e.type === 'developer/message'),
    injects: agent.injects.length,
    qaEvent: surfaced.find((e) => e.data?.source?.form === 'qa'),
  };
}
check('(1) ask 返回 success，text 就是回答（面板可以本地显示）',
  hostDeliver.result?.kind === 'success' && String(hostDeliver.result.text).length > 0,
  JSON.stringify(hostDeliver.result).slice(0, 120));
check('(1) 投递走 user/message + source.kind=review-mode（**不是** developer/message）',
  hostDeliver.qaEvent !== undefined
  && hostDeliver.qaEvent.data.source.kind === 'review-mode'
  && hostDeliver.developerMessages.length === 0,
  JSON.stringify(hostDeliver.surfaced.map((e) => [e.type, e.data?.source?.form, e.data?.source?.kind])));
check('(1) 面事件带 surfaceOp=append（shipped 校验要求）', hostDeliver.qaEvent?.surfaceOp === 'append');
check('(1) 没有退回 agent.inject（那会让问答长在对话记录里）', hostDeliver.injects === 0, `injects=${hostDeliver.injects}`);

// ══════════════════════════════════════════════════════════
// 2. 客户端侧：投递没落地，面板仍然必须显示回答
// ══════════════════════════════════════════════════════════

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

const DIRECTORY = {
  kind: 'codex', total: 1,
  recent: [{ id: 'a1', kind: 'codex', title: '细节问答', label: '5005复习 / 细节问答', age: '3 分钟前' }],
  groups: [], selected: null,
};
const EVIDENCE = { title: '5005复习 / 细节问答', youSaid: ['你查查课件当中有讲这几个算法吗'], background: [], stats: '你说 1 条' };
const reply = (text) => ({ ok: true, value: { commandId: 'c1', result: { kind: 'success', text } } });

let askAnswer = ANSWER;
const fakeRemote = {
  commands: {
    execute(_sessionId, line) {
      const verb = String(line).trim().split(/\s+/)[1];
      if (verb === 'dir') return Promise.resolve(reply(JSON.stringify(DIRECTORY)));
      if (verb === 'pick') return Promise.resolve(reply(JSON.stringify({ ok: true, evidence: EVIDENCE })));
      // 关键：回答只从**命令的同步返回**里来；投影**一个字节都不动**（模拟投递没落地）。
      if (verb === 'ask') return Promise.resolve(reply(askAnswer));
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
await import('../client.js');
if (registered === null) { console.log('FAIL  模块没有注册'); process.exit(1); }
let panel = null;
registered.apply({
  remote: fakeRemote,
  slots: { inject: (name, fn) => fn(), register: (meta, component) => { if (meta.name === 'shell.overlay') panel = component; } },
});

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
const occurrences = (t, text) => JSON.stringify(t).split(text).length - 1;

const CARD = {
  kind: 'review', verdict: 'drifting', lane: 'me', text: '有漂移', sections: ANALYSIS_SECTIONS,
  headline: '有漂移_领先行', dialog: ['具体对话哨兵'], summary: '概述哨兵',
  analysis: ['分析哨兵'], advice: ['建议哨兵'],
};

let projection = { feed: [CARD] };
let tree = null;
const props = {
  sessionId: 's1',
  useSessions: (selector) => selector({ byId: { s1: { projectionValues: { agentPreset: 'review', reviewMode: projection } } } }),
};
rerender = () => { cursor = 0; tree = panel(props); };
rerender();

/** 走到状态 3（选方向 → 选对话）。 */
const goToResults = async () => {
  collect(tree, (n) => n.props?.['data-review-direction'] === 'codex')[0].props.onClick();
  await new Promise((r) => setTimeout(r, 0));
  rerender();
  collect(tree, (n) => n.props?.['data-review-target'] === 'a1')[0].props.onClick();
  await new Promise((r) => setTimeout(r, 0));
  rerender();
};
/** 在左栏那个框里提问并提交。 */
const ask = async (question) => {
  byProp(tree, 'data-review-ask').props.onChange({ target: { value: question } });
  rerender();
  byProp(tree, 'data-review-ask-submit').props.onClick();
  await new Promise((r) => setTimeout(r, 5));
  rerender();
};

await goToResults();
check('(2) 走到状态 3，左栏有那个框', byProp(tree, 'data-review-ask') !== undefined);

await ask(QUESTION);
const leftCol = collect(tree, (n) => n.props?.['data-review-col'] === 'q')[0];
check('(2) 投递**没落地**时，命令同步返回的回答仍然显示在面板上',
  hasText(tree, ANSWER), `answer in tree=${hasText(tree, ANSWER)}`);
check('(2) 回答就长在**你打字的那个框下面**（左栏里，不是另一栏）',
  leftCol !== undefined && hasText(leftCol, ANSWER),
  leftCol === undefined ? '没有左栏' : '左栏里没有回答');
check('(2) 这个问题本身也记在那一块里（问与答成对）',
  leftCol !== undefined && hasText(leftCol, QUESTION));
check('(2) 问答条目带 data-review-qa，与自动评价一眼可分',
  collect(tree, (n) => n.props?.['data-review-qa'] !== undefined).length === 1,
  `→ ${collect(tree, (n) => n.props?.['data-review-qa'] !== undefined).length} 个`);
check('(2) 自动评价那条卡片**没有**被标成问答（防恒真）',
  collect(tree, (n) => n.props?.['data-review-qa'] !== undefined).length === 1 && hasText(tree, '有漂移'));

// ── 3. 投递后来落地了：不许变成两句 ────────────────────────
{
  projection = {
    feed: [CARD, {
      kind: 'qa', question: QUESTION, text: ANSWER, headline: ANSWER,
      verdict: 'unknown', lane: 'me', sections: ANALYSIS_SECTIONS,
      dialog: [], summary: '', analysis: [], advice: [],
    }],
  };
  rerender();
  check('(3) 投影里出现同一条问答之后，面板上仍然**只有一份**（本地回显去重）',
    occurrences(tree, ANSWER) === 1, `出现 ${occurrences(tree, ANSWER)} 次`);
  check('(3) 问答节点仍然只有 1 个',
    collect(tree, (n) => n.props?.['data-review-qa'] !== undefined).length === 1,
    `→ ${collect(tree, (n) => n.props?.['data-review-qa'] !== undefined).length} 个`);
}

// ── 反向变异：命令真的没答出来时，不许凭空长出一个空条目 ────
{
  projection = { feed: [CARD] };
  rerender();
  askAnswer = '';
  await ask('这条没人回答');
  check('反向变异：命令返回空回答时，那条问题不会凭空长出一个（空的）问答条目',
    !hasText(tree, '这条没人回答')
    && collect(tree, (n) => n.props?.['data-review-qa'] !== undefined).length === 1,
    `问题在树上=${hasText(tree, '这条没人回答')}，问答节点=${collect(tree, (n) => n.props?.['data-review-qa'] !== undefined).length} 个`);
  check('反向变异：先前的问答仍然是**一条**（空回答不把历史冲掉，也不把它复制一份）',
    occurrences(tree, ANSWER) === 1, `出现 ${occurrences(tree, ANSWER)} 次`);
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
