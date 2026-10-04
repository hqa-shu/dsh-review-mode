import assert from 'node:assert/strict';

let cursor = 0;
const slots = [];
let rerender = () => {};
let probeIndex = null;
const React = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } };
  },
  useState(initial) {
    const index = cursor++;
    if (initial?.status === 'first' && initial?.at === 0) probeIndex = index;
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
    return [slots[index], next => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; rerender(); }];
  },
  useRef(value) { return { current: value }; },
  useEffect() {},
};

let registered;
globalThis.window = {
  __ModuleLoader__: { load({ factory }) { registered = factory(spec => spec === 'react' ? React : {}); } },
  localStorage: { getItem: () => null, setItem() {} },
  addEventListener() {}, removeEventListener() {},
};
await import('../client.js');
let panel;
const calls = [];
const reply = value => ({ ok: true, value: { commandId: 'c1', result: { kind: 'success', text: JSON.stringify(value) } } });
const EVIDENCE = { title: '合成对话', youSaid: [
  '第一条：先说清任务',
  '第二条：这是一段很长的原话，里面有多次停顿和解释。'.repeat(8),
  '第三条：最后补充验收条件',
], otherSaid: ['合成回答'] };
registered.apply({
  remote: { commands: { execute(_sessionId, command) {
    calls.push(command);
    if (command.includes(' dir ')) return Promise.resolve(reply({ recent: [{ kind: 'dsh', id: 'synthetic', title: '合成对话' }], groups: [] }));
    if (command.includes(' advise-turn ')) return Promise.resolve(reply({ status: 'pending', number: 2, answer: '', error: '' }));
    if (command.includes(' focus ')) {
      const lane = command.match(/ focus (me|conversation|agent)(?:\s|$)/)?.[1];
      return Promise.resolve(reply({ selected: { kind: 'dsh', id: 'synthetic', title: '合成对话', lane }, evidence: EVIDENCE }));
    }
    return Promise.resolve(reply({ selected: { kind: 'dsh', id: 'synthetic', title: '合成对话', lane: 'me' }, evidence: EVIDENCE }));
  } } },
  slots: { inject(_name, fn) { fn(); }, register(meta, component) { if (meta.name === 'shell.overlay') panel = component; } },
});

const collect = (node, predicate, out = []) => {
  if (node === null || typeof node !== 'object') return out;
  if (predicate(node)) out.push(node);
  const kids = node.props?.children;
  for (const child of Array.isArray(kids) ? kids : kids === undefined ? [] : [kids]) collect(child, predicate, out);
  return out;
};
const first = predicate => collect(tree, predicate)[0];
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
let feed = [{ kind: 'review', targetKey: 'dsh:synthetic', lane: 'me', at: 1, turn: 1, verdict: 'on-track', headline: '只属于审我', analysis: ['合成洞察'] }];
let tree;
rerender = () => {
  cursor = 0;
  tree = panel({ sessionId: 's1', useSessions: selector => selector({ byId: { s1: { projectionValues: { agentPreset: 'review', reviewMode: { feed } } } } }) });
};
rerender();
first(node => node.props?.['data-review-direction'] === 'dsh').props.onClick();
await tick();
first(node => node.props?.['data-review-target'] === 'synthetic').props.onClick();
await tick();
assert.equal(first(node => node.props?.['data-review-current-focus'] !== undefined)?.props['data-review-current-focus'], 'me');
assert(JSON.stringify(tree).includes('只属于审我'));
console.log('PASS 选中目标后明确显示当前审我及其评价');

const saidItems = () => collect(tree, node => node.props?.['data-review-said-item'] !== undefined);
assert.deepEqual(saidItems().map(node => node.props['data-review-said-item']), ['3', '2', '1']);
assert(saidItems().every(node => node.props.style.flex === 'none'), '展开后的原话卡片不能在滚动列表中被压缩截断');
const saidList = first(node => node.props?.['data-review-said-list'] === '1');
assert.equal(saidList.props.style.overflowY, 'auto');
assert.match(saidList.props.style.maxHeight, /vh/);
assert.equal(first(node => node.props?.['data-review-body'] === '1')?.props.style.overflowY, 'auto');
assert.equal(first(node => node.props?.['data-review-said-full'] === '2')?.props.children, EVIDENCE.youSaid[1]);
assert(first(node => node.props?.['data-review-said-summary'] === '2')?.props.children[1].props.children.length < EVIDENCE.youSaid[1].length);
first(node => node.props?.['data-review-filter'] === 'said').props.onChange({ target: { value: '第三条' } });
assert.deepEqual(saidItems().map(node => node.props['data-review-said-item']), ['3']);
first(node => node.props?.['data-review-filter'] === 'said').props.onChange({ target: { value: '' } });
console.log('PASS 原话分成编号卡片，长文可展开，筛选后仍保留原编号');

first(node => node.props?.['data-review-said-item'] === '2').props.onToggle({ currentTarget: { open: true } });
await tick();
assert(calls.some(command => command.includes(' advise-turn 2')));
assert(JSON.stringify(first(node => node.props?.['data-review-turn-advice'] === '2')).includes('正在生成'));
console.log('PASS 打开一条原话才请求该条建议，不预先批量生成');

first(node => node.props?.['data-review-focus'] === 'conversation').props.onClick();
await tick();
assert(calls.some(command => command.includes(' focus conversation')));
assert.equal(first(node => node.props?.['data-review-current-focus'] !== undefined)?.props['data-review-current-focus'], 'conversation');
assert.equal(first(node => node.props?.['data-review-focus-selected'] !== undefined)?.props['data-review-focus-selected'], 'conversation');
assert(!JSON.stringify(tree).includes('只属于审我'));
console.log('PASS 点审对话后发出审核命令并显示选中状态');

first(node => node.props?.['data-review-focus'] === 'me').props.onClick();
await tick();
assert(calls.some(command => command.includes(' focus me')));
assert.equal(first(node => node.props?.['data-review-current-focus'] !== undefined)?.props['data-review-current-focus'], 'me');
assert.equal(first(node => node.props?.['data-review-focus-selected'] !== undefined)?.props['data-review-focus-selected'], 'me');
assert(JSON.stringify(tree).includes('只属于审我'));
console.log('PASS 点审我后发出审核命令并恢复对应评价');

first(node => node.props?.['data-review-focus'] === 'agent').props.onClick();
await tick();
assert(calls.some(command => command.includes(' focus agent')));
assert.equal(first(node => node.props?.['data-review-current-focus'] !== undefined)?.props['data-review-current-focus'], 'agent');
assert.equal(first(node => node.props?.['data-review-focus-selected'] !== undefined)?.props['data-review-focus-selected'], 'agent');
assert(!JSON.stringify(tree).includes('只属于审我'));
assert(first(node => node.props?.['data-review-start'] !== undefined));
console.log('PASS 点审AI后选中状态可见，审我的旧评价不会冒充审AI结果');

first(node => node.props?.['data-review-start'] !== undefined).props.onClick();
await tick();
assert(calls.some(command => command.includes(' refresh')));
console.log('PASS 当前侧重点无评价时有明确的开始审核入口');

feed = [...feed, { kind: 'review', targetKey: 'dsh:synthetic', lane: 'agent', at: 2, turn: 2, verdict: 'drifting', headline: '只属于审AI', analysis: ['合成洞察'] }];
rerender();
assert(JSON.stringify(tree).includes('只属于审AI'));
assert(!JSON.stringify(tree).includes('只属于审我'));
console.log('PASS 审AI评价生成后只显示该侧重点的结果');

const now = Date.now();
slots[probeIndex] = { status: 'ok', at: now, why: '', facts: {
  pong: true, tick: { enabled: true, lastAt: now, intervalMs: 5000 },
  autoReview: { checkedAt: now, observedMessages: 1, triggerCount: 0, lastTriggeredAt: null, lastDelta: 0 },
} };
rerender();
const autoStatus = () => first(node => node.props?.['data-review-auto-status'] === '1')?.props?.children;
assert.match(autoStatus(), /自本次选择后尚未触发/);
slots[probeIndex] = { ...slots[probeIndex], facts: { ...slots[probeIndex].facts,
  autoReview: { checkedAt: now, observedMessages: 2, triggerCount: 1, lastTriggeredAt: now, lastDelta: 1 },
} };
rerender();
assert.match(autoStatus(), /自本次选择后已触发 1 次/);
assert.match(autoStatus(), /新增 1 条用户消息/);
console.log('PASS 页面分别显示自动复审尚未触发与真实触发次数');
