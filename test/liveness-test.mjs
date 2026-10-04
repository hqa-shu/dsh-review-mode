/**
 * 活性指示条的客户端侧证明。
 *
 * 用户的原话：「您那边如果一直不动……你要不弄一个一直在转的帮我显示他在连接……
 * 连接上那就在转，没有连接上就消失，不然我不知道他有没有（在工作）」。
 *
 * 面板渲染自 `reviewMode` 投影；用户不发消息 → 没有会话事件 → 投影不变 →
 * 面板一次都不重画。所以这个测试要证明的是**它不靠投影**：
 *   (a) 三种状态各画各的（连接中 / 已连接 · 监控中 / 未连接），后两种带事实或原因；
 *   (b) 「未连接」**不画**转圈元素（用户原话「没有连接上就消失」），失败与超时都算；
 *   (c) 转圈的动画是 **CSS `@keyframes`**，不是每帧改 style，也不是
 *       `requestAnimationFrame` —— 投影不动它也照转；
 *   (d) 本地时钟（每秒一次 `setState`）**只重算新鲜度**，一个宿主请求都不发；
 *       心跳成功过期后，状态自己变成「未连接」，不需要任何新数据；
 *   (e) 真心跳走 `/review-mode ping`，并且带 4 秒硬超时（超时退成「未连接」，
 *       绝不挂在转圈上）。
 *
 * 用**带真实 effect 的**极小 React（其他客户端测试用的是 `useEffect(){}` 空实现，
 * 所以这个文件自己带一个），并且用 `window.__review*` 覆盖把毫秒数压到几十毫秒。
 */

import { readFileSync } from 'node:fs';

let failed = 0;
const check = (label, pass, extra = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  ${extra}`}`);
  if (!pass) failed += 1;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── 有小状态 + **真的跑 effect** 的极小 React ─────────────
function makeReact() {
  const stateSlots = [];
  const effectSlots = [];
  let cursor = 0;
  let effectCursor = 0;
  let onChange = () => {};
  const React = {
    createElement(type, props, ...children) {
      return { type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } };
    },
    useState(initial) {
      const index = cursor;
      cursor += 1;
      if (!(index in stateSlots)) stateSlots[index] = typeof initial === 'function' ? initial() : initial;
      return [stateSlots[index], (next) => {
        stateSlots[index] = typeof next === 'function' ? next(stateSlots[index]) : next;
        onChange();
      }];
    },
    useRef(value) { return { current: value }; },
    useEffect(fn, deps) {
      const index = effectCursor;
      effectCursor += 1;
      const prev = effectSlots[index];
      const same = prev !== undefined && Array.isArray(deps) && Array.isArray(prev.deps)
        && deps.length === prev.deps.length && deps.every((dep, i) => Object.is(dep, prev.deps[i]));
      if (same) return;
      if (prev !== undefined && typeof prev.cleanup === 'function') { try { prev.cleanup(); } catch { /* 无所谓 */ } }
      effectSlots[index] = { deps, cleanup: fn() };
    },
  };
  return { React, reset() { cursor = 0; effectCursor = 0; }, onChange(fn) { onChange = fn; } };
}

const PROPS_FOR = (preset) => ({
  sessionId: 's1',
  useSessions: (selector) => selector({ byId: { s1: { projectionValues: { agentPreset: preset, reviewMode: { feed: [] } } } } }),
});

let importId = 0;

/**
 * 起一个面板实例。`window.__review*` 必须在 `import('../client.js')` **之前**设好
 * —— 那些毫秒常量是模块加载时求值的，所以每个场景用不同的 URL 拿一份新模块。
 * @param {object} options - `{execute, probeMs, localMs, staleMs, timeoutMs, facts}`。
 * @returns {Promise<object>} `{tree, render, collect, liveness, calls}`。
 */
async function boot(options) {
  const react = makeReact();
  let registered = null;
  const calls = [];
  const facts = options.facts ?? {
    ok: true, pong: true, hostNow: Date.now(),
    tick: { enabled: true, intervalMs: 5000, lastAt: Date.now() - 2100, ageMs: 2100, count: 12 },
    scan: { at: Date.now() - 3000, ageMs: 3000, conversations: 40, targetId: 'abc' },
    busy: false, uptimeMs: 65000,
  };
  const execute = options.execute ?? ((sessionId, line, attachments) => {
    calls.push([sessionId, line, attachments]);
    return Promise.resolve({ ok: true, value: { commandId: 'c1', result: { kind: 'success', text: JSON.stringify(facts) } } });
  });
  globalThis.window = {
    __ModuleLoader__: { load({ factory }) { registered = factory((spec) => (spec === 'react' ? react.React : {})); } },
    localStorage: { getItem: () => null, setItem: () => {} },
    addEventListener() {}, removeEventListener() {},
    __reviewRemoteTimeoutMs: options.timeoutMs ?? 60,
    __reviewLocalTickMs: options.localMs ?? 1000,
    __reviewProbeIntervalMs: options.probeMs ?? 100000,
    __reviewStaleMs: options.staleMs ?? 5000,
  };
  const url = new URL(`../client.js?scenario=${importId++}`, import.meta.url).href;
  await import(url);
  if (registered === null) throw new Error('client.js 没有注册');
  let panel = null;
  registered.apply({
    remote: { commands: { execute } },
    slots: { inject: (name, fn) => fn(), register: (meta, component) => { if (meta.name === 'shell.overlay') panel = component; } },
  });
  let tree = null;
  const props = PROPS_FOR(options.preset ?? 'review');
  const render = () => { react.reset(); tree = panel(props); };
  react.onChange(render);
  render();
  return { get tree() { return tree; }, render, calls };
}

const collect = (node, predicate, out = []) => {
  if (node === null || typeof node !== 'object') return out;
  if (predicate(node)) out.push(node);
  const kids = node.props?.children;
  const list = Array.isArray(kids) ? kids : (kids === undefined ? [] : [kids]);
  for (const kid of list) collect(kid, predicate, out);
  return out;
};
const statusOf = (tree) => livenessNode(tree)?.props?.['data-review-liveness'] ?? null;
const livenessNode = (tree) => collect(tree, (n) => n.props?.['data-review-liveness'] !== undefined)[0];
const spins = (tree) => collect(tree, (n) => String(n.props?.className ?? '').includes('review-mode-spin'));
const textOf = (tree) => JSON.stringify(tree);

// ── 场景 1：三态齐全（成功 → 失败）────────────────────────
{
  let failMode = false;
  const facts = {
    ok: true, pong: true, hostNow: Date.now(),
    tick: { enabled: true, intervalMs: 5000, lastAt: Date.now() - 2100, ageMs: 2100, count: 12 },
    scan: { at: Date.now() - 3000, ageMs: 3000, conversations: 40, targetId: 'abc' },
    busy: false, uptimeMs: 65000,
  };
  const panel = await boot({
    probeMs: 30, localMs: 1000, staleMs: 5000,
    execute: (sessionId, line, attachments) => {
      if (failMode) return Promise.resolve({ ok: false, error: { code: 'channel-down', message: '通道断了' } });
      return Promise.resolve({ ok: true, value: { commandId: 'c1', result: { kind: 'success', text: JSON.stringify(facts) } } });
    },
  });
  check('首次心跳还没回来时是「连接中」（neutral，仍然转）',
    statusOf(panel.tree) === 'first' && /连接中/.test(textOf(panel.tree)) && spins(panel.tree).length === 1,
    String(statusOf(panel.tree)));

  await sleep(12);
  check('心跳成功后是「已连接 · 监控中」',
    statusOf(panel.tree) === 'ok' && /已连接/.test(textOf(panel.tree)),
    String(statusOf(panel.tree)));
  check('「已连接」有事实，不是空转的装饰：主机心跳 / 间隔 / 上次扫描条数',
    /主机心跳/.test(textOf(panel.tree)) && /间隔 5s/.test(textOf(panel.tree)) && /上次扫描 40 条对话/.test(textOf(panel.tree)),
    livenessNode(panel.tree)?.props?.children?.map?.((c) => c?.props?.children).flat?.().join(' '));
  check('「已连接」在转（CSS class 的转圈元素存在）', spins(panel.tree).length === 1 && spins(panel.tree)[0].props?.['data-review-spin'] === '1');

  failMode = true;
  await sleep(70);
  check('心跳失败后是「未连接」', statusOf(panel.tree) === 'down', String(statusOf(panel.tree)));
  check('「未连接」**不画转圈元素**（用户原话：没有连接上就消失）', spins(panel.tree).length === 0,
    `spin nodes=${spins(panel.tree).length}`);
  check('「未连接」带一句短原因', /通道断了/.test(textOf(panel.tree)));
  check('「未连接」的灰点标记成 off（不是假装在转）',
    collect(panel.tree, (n) => n.props?.['data-review-spin'] === 'off').length === 1);
}

// ── 场景 2：超时也退成「未连接」，不挂在转圈上 ────────────
{
  const panel = await boot({ probeMs: 25, timeoutMs: 40, execute: () => new Promise(() => {}) });
  check('探测超时前仍是「连接中」', statusOf(panel.tree) === 'first');
  await sleep(120);
  check('探测超时后是「未连接」（4 秒硬超时的纪律）', statusOf(panel.tree) === 'down', String(statusOf(panel.tree)));
  check('超时的「未连接」也不画转圈', spins(panel.tree).length === 0);
  check('超时的原因说得清是超时', /超时/.test(textOf(panel.tree)));
}

// ── 场景 3：本地时钟重算新鲜度，且一个宿主请求都不发 ──────
{
  let executeCalls = 0;
  const lines = [];
  const facts = {
    ok: true, pong: true, hostNow: Date.now(),
    tick: { enabled: true, intervalMs: 5000, lastAt: Date.now(), ageMs: 0, count: 3 },
    scan: { at: Date.now(), ageMs: 0, conversations: 40, targetId: null },
    busy: false, uptimeMs: 1000,
  };
  const panel = await boot({
    probeMs: 100000,   // 只有挂载时那一次心跳
    localMs: 15,       // 本地时钟每 15ms 一跳
    staleMs: 80,       // 80ms 没成功就算过期
    execute: (sessionId, line, attachments) => {
      executeCalls += 1;
      lines.push(line);
      return Promise.resolve({ ok: true, value: { commandId: 'c1', result: { kind: 'success', text: JSON.stringify(facts) } } });
    },
  });
  await sleep(10);
  check('(e) 挂载时真的探了一次（走 /review-mode ping）', executeCalls === 1 && lines[0] === '/review-mode ping',
    JSON.stringify(lines));
  check('(e) 成功之后是「已连接 · 监控中」', statusOf(panel.tree) === 'ok', String(statusOf(panel.tree)));

  // 本地时钟会重画：转圈元素的**节点本身**必须逐字不变（动画不由 tick 驱动）。
  const spinBefore = JSON.stringify(spins(panel.tree)[0] ?? null);
  await sleep(45);
  const spinAfter = JSON.stringify(spins(panel.tree)[0] ?? null);
  check('(c) 本地时钟跳了几次，转圈节点逐字不变（动画与重画解耦）',
    spinBefore === spinAfter && spinBefore !== 'null', `${spinBefore} vs ${spinAfter}`);

  check('(d) 本地时钟一个宿主请求都没发（execute 仍然只有挂载那一次）',
    executeCalls === 1, `executeCalls=${executeCalls}`);

  await sleep(120);
  check('(d) 心跳成功**过期**后，状态自己变成「未连接」（不需要任何新数据）',
    statusOf(panel.tree) === 'down', String(statusOf(panel.tree)));
  check('(d) 过期判定完全靠本地时钟：期间零宿主请求',
    executeCalls === 1, `executeCalls=${executeCalls}`);
  check('(d) 过期的原因说清「最后一次成功心跳是多久前」',
    /最后一次成功心跳是/.test(textOf(panel.tree)), textOf(panel.tree).slice(0, 40));
  check('(d) 过期后转圈消失', spins(panel.tree).length === 0);
}

// ── 场景 4：动画是 CSS 声明 ───────────────────────────────
{
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  check('(c) 源码里有 CSS @keyframes review-spin', /@keyframes\s+review-spin/.test(source));
  check('(c) 转圈靠 class 上的 `animation: review-spin …`，不是每帧重算 style',
    /\.review-mode-spin\s*\{\s*animation:\s*review-spin[^}]*\}/.test(source));
  check('(c) 没有 requestAnimationFrame（不是 JS 逐帧）', !/requestAnimationFrame/.test(source));
  check('(c) 没有用 `transform: rotate(...)` 拼时间（角度不由 JS 算）',
    !/rotate\(\$\{|rotate\(\s*[a-zA-Z_$][\w$]*\s*\*/.test(source));

  const panel = await boot({});
  await sleep(10);
  const cssNode = collect(panel.tree, (n) => n.props?.['data-review-spin-css'] !== undefined)[0];
  check('(c) 面板把 <style> 跟着自己渲染出来（不依赖构建期产物）', cssNode !== undefined);
  const cssText = String(cssNode?.props?.children ?? '');
  check('(c) <style> 里就是那两条规则', /@keyframes review-spin/.test(cssText) && /animation: review-spin/.test(cssText), cssText.replace(/\n/g, ' '));
  check('(c) 转圈节点用 class `review-mode-spin`',
    String(spins(panel.tree)[0]?.props?.className ?? '') === 'review-mode-spin');
}

// ── 场景 5：inject 铁律不变 ───────────────────────────────
{
  const panel = await boot({});
  check('面板仍然注册在 shell.overlay（这个文件自动兜底）', panel.tree !== null);
}

// ── 场景 6：非审核模式**不许**发生心跳（按预设门控）────────
// 面板组件挂在会话级 dock 上，每个会话都会挂载它。hooks 早于 `preset !== 'review'`
// 的提前返回执行，所以**必须显式门控**，否则每个会话都每 20 秒发一条 ping。
{
  let calls = 0;
  const panel = await boot({
    preset: 'standard',
    probeMs: 20,
    execute: () => {
      calls += 1;
      return Promise.resolve({ ok: true, value: { commandId: 'c1', result: { kind: 'success', text: JSON.stringify({ ok: true, pong: true, tick: {}, scan: {} }) } } });
    },
  });
  await sleep(80);
  check('非审核模式不渲染面板', panel.tree === null, String(panel.tree));
  check('非审核模式**一次心跳都不发**（按预设门控，不给别的会话添流量）', calls === 0, `execute=${calls}`);
}

// ── 场景 7：通道通、但**审核跑不起来** —— 不许是绿的，也不许转 ────
// 用户 2026-10 亲手抓到的那一幕：对话里写着「本轮运行失败 … MISSING_CREDENTIAL」，
// 面板却同时显示「✅ 已连接 · 监控中 … 上次扫描 40 条对话」并且还在转。
// 他的原话：「API key 没有连接，它怎么自己还能在那边不断转太多了」。
{
  const facts = {
    ok: true, pong: true, hostNow: Date.now(),
    tick: { enabled: true, intervalMs: 5000, lastAt: Date.now() - 9000, ageMs: 9000, count: 12 },
    scan: { at: Date.now() - 3000, ageMs: 3000, conversations: 40, targetId: 'abc' },
    busy: false, uptimeMs: 65000,
    // 宿主诚实回话：最近一次真实 turn/end 失败了（逐字取自 session-5d5b0bb5 的 seq 19）。
    lastTurn: {
      failed: true, code: 'MISSING_CREDENTIAL',
      message: 'llm-deepseek: no API key for provider route "deepseek-official"; store DEEPSEEK_API_KEY through the credentials service (the web Models page writes it), or export DEEPSEEK_API_KEY in the launching environment',
      at: Date.now() - 8000, ageMs: 8000, turn: 1,
    },
  };
  const panel = await boot({ probeMs: 30, localMs: 1000, staleMs: 200000, facts });
  // 第一帧还没探过：状态是「连接中」，但**转圈仍在**（还没拿到任何运行结果，
  // 这时候既不能说好也不能说坏 —— 不编）。
  check('(跑不起来) 还没探过时不编结论：是「连接中」而不是「已连接」',
    statusOf(panel.tree) === 'first', String(statusOf(panel.tree)));

  await sleep(15);
  check('(跑不起来) 心跳成功后状态不是 ok 而是 fail（通道通 ≠ 系统能跑）',
    statusOf(panel.tree) === 'fail' && !/已连接 · 监控中/.test(textOf(panel.tree)),
    String(statusOf(panel.tree)));
  check('(跑不起来) **不画**转圈元素（用户原话：跑不起来就不该像在工作）',
    spins(panel.tree).length === 0, `spin nodes=${spins(panel.tree).length}`);
  check('(跑不起来) 灰点标成 off（明确「没在转」）',
    collect(panel.tree, (n) => n.props?.['data-review-spin'] === 'off').length === 1);
  check('(跑不起来) 标签说清是「跑不起来」而不是含糊的「已连接」',
    /跑不起来/.test(textOf(panel.tree)), livenessNode(panel.tree)?.props?.children?.map?.((c) => c?.props?.children).flat?.().join(' '));
  check('(跑不起来) 说出真因：provider route 没有凭据',
    /no API key for provider route/.test(textOf(panel.tree)) && /deepseek-official/.test(textOf(panel.tree)));
  check('(跑不起来) 带上错误码（用户可以直接照着搜/念）',
    /MISSING_CREDENTIAL/.test(textOf(panel.tree)));
  check('(跑不起来) 原因同时写进 DOM 属性（面板之外也能核对）',
    /no API key for provider route/.test(String(livenessNode(panel.tree)?.props?.['data-review-liveness-why'] ?? '')));
  check('(跑不起来) 不再冒充「监控中」（不许报扫描条数装作一切正常）',
    !/上次扫描 40 条对话/.test(String(livenessNode(panel.tree)?.props?.['data-review-liveness-why'] ?? '') + textOf(panel.tree)));
}

// ── 场景 8：失败被清掉之后，面板必须回到「已连接」──────────
{
  let facts = {
    ok: true, pong: true, hostNow: Date.now(),
    tick: { enabled: true, intervalMs: 5000, lastAt: Date.now(), ageMs: 0, count: 3 },
    scan: { at: Date.now(), ageMs: 0, conversations: 40, targetId: null },
    busy: false, uptimeMs: 1000,
    lastTurn: { failed: true, code: 'MISSING_CREDENTIAL', message: 'no key', at: Date.now(), ageMs: 0, turn: 1 },
  };
  const panel = await boot({
    probeMs: 25, localMs: 1000, staleMs: 200000,
    execute: () => Promise.resolve({ ok: true, value: { commandId: 'c1', result: { kind: 'success', text: JSON.stringify(facts) } } }),
  });
  await sleep(10);
  check('(恢复) 失败时是 fail', statusOf(panel.tree) === 'fail', String(statusOf(panel.tree)));
  // 下一轮跑成功了：宿主把 lastTurn 清成 null。
  facts = { ...facts, lastTurn: null };
  await sleep(45);
  check('(恢复) 宿主报「没失败」之后回到「已连接 · 监控中」并重新转起来',
    statusOf(panel.tree) === 'ok' && spins(panel.tree).length === 1,
    `${statusOf(panel.tree)} spins=${spins(panel.tree).length}`);
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
