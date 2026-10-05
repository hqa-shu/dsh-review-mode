/**
 * 复审子 Agent 的工具面：**一个都不给**，而且这件事必须由测试守着。
 *
 * 现场失败（用户那次真实运行的面板报错，逐字）：
 * ```
 * 复审没有完成 —— tools.restrict() names unknown global tool "read";
 * known global tools: ask_user_question, list_conversations,
 * load_workspace_dependencies, review_conversation
 * ```
 * `index.js` 在两个派单点都写了 `toolFilter: { allow: ['read'] }`。
 * `read` 在这个预设里**根本不存在** —— 它是照着假设抄来的名字，从没人核对过。
 * 于是 `tools.restrict()` 在准备复审子 Agent 时抛错，复审一次都没跑起来，
 * 面板一直停在「审核结果 · 0 条」。
 *
 * 这个测试做四件事：
 *   A. **用真 `ToolRuntime`**（shipped 的 `@deepseek-ai/dsh-tools`）把现场报错逐字复现，
 *      并证明正确的形状是 `{ allow: [] }`：不抛、可见工具 = 0。
 *      同时证明「省略 `toolFilter`」**不是**「没有工具」—— 那会继承父预设的全部工具。
 *   B. **静态扫源码**：任何 `toolFilter` / `.restrict(` 里出现的工具名都必须是
 *      「已证实存在于该作用域」的名字；而复审子 Agent 的过滤器里**一个名字都不许有**
 *      （于是将来再抄一个不存在的名字进来，测试先红，而不是用户在面板上看到失败）。
 *   C. **端到端**：两个派单点（轮收尾 `runReview`、面板/ A 路 `runDirectedReview`）
 *      跑真插件代码；宿主的 `subagents.start` 按 shipped 的形状
 *      （`dsh-subagent/lib/index.js:522`）把捕获到的 `toolFilter` 真套到子作用域上，
 *      再断言复审真的跑完、真的落了卡片。
 *   D. 零工具之后，证据与输出格式仍然**只从提示词**进复审员；没有任何地方还指望它 `read`。
 *
 * 每一条正向断言都配一条反向变异（字面里塞回 `read` → 必须变红）。
 */

import { readFileSync } from 'node:fs';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import { createScope } from '@deepseek-ai/dsh-scope';
import { analysisReviewText } from './harness.mjs';

let failed = 0;
const check = (label, pass, extra = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  ${extra}`}`);
  if (!pass) failed += 1;
};

/**
 * 那次真实运行里**唯一**被证实存在的四个全局工具名。
 *
 * 判据（都能对上 shipped 源码，不是猜的）：
 *   - `ask_user_question`            —— 预设行 `tool-ask-user` = `@deepseek-ai/dsh-tool-ask-user`
 *                                       （`cordis.patch.yml:74-75`；包 README 那句
 *                                       「Model-facing ask_user_question tool」）。
 *   - `list_conversations` / `review_conversation` —— 本包 `reviewer.js:836` / `:969` 注册的名字。
 *   - `load_workspace_dependencies`  —— `@deepseek-ai/dsh-tool-workspace-dependencies`
 *                                       （包 README:2 逐字写着「The load_workspace_dependencies tool」）。
 * 而且这四条正是用户那次运行里 `tools.restrict()` 自己报出来的 `known global tools`。
 */
const REVIEWER_SCOPE_TOOLS = [
  'ask_user_question',
  'list_conversations',
  'load_workspace_dependencies',
  'review_conversation',
];

/** 现场那句报错，逐字（换行只在用户的面板里折行；运行时是一行）。 */
const LIVE_ERROR = 'tools.restrict() names unknown global tool "read"; '
  + 'known global tools: ask_user_question, list_conversations, load_workspace_dependencies, review_conversation';

/**
 * 起一个**真**工具作用域：真 cordis Context + 真 `SystemPrompt` + 真 `ToolRuntime`，
 * 把 {@link REVIEWER_SCOPE_TOOLS} 登记成全局工具，再 mint 一个子作用域。
 * @param {string[]} names - 登记为全局工具的名字。
 * @returns {object} `{ ctx, visible(), dispose() }`。
 */
function realScope(names) {
  const root = new Context();
  // eslint-disable-next-line no-new -- 服务靠构造注册进 ctx。
  new SystemPrompt(root, { includeHarnessIdentity: false, includeRuntimeContext: false });
  const tools = new ToolRuntime(root, { mode: 'native' });
  // `restrict()` 只从注册表视图里读**名字**（`dsh-tools/lib/types/index.js:561-605`），
  // 所以这里给一个最小壳就够；要测的是名字解析，不是工具实现。
  for (const name of names) tools.layers.global.tools.insert(name, { name });
  const key = `reviewer-${Math.random().toString(36).slice(2)}`;
  const { ctx } = createScope(root, key);
  return { ctx, visible: () => [...tools.view(key).visible.keys()] };
}

/**
 * 按 shipped 的形状把过滤器套到子作用域上
 * （`dsh-subagent/lib/index.js:522`：`if (composition.toolFilter !== void 0)
 * childCtx.tools.restrict(composition.toolFilter);`）。
 * @param {object|undefined} filter - `toolFilter` 的值；`undefined` = 键不在。
 * @returns {{threw: boolean, message: string, visible: string[]}} 结果快照。
 */
function composeChild(filter) {
  const scope = realScope(REVIEWER_SCOPE_TOOLS);
  if (filter === undefined) return { threw: false, message: '', visible: scope.visible() };
  try {
    scope.ctx.tools.restrict(filter);
    return { threw: false, message: '', visible: scope.visible() };
  } catch (error) {
    return { threw: true, message: error instanceof Error ? error.message : String(error), visible: scope.visible() };
  }
}

/* ══ A. 真 ToolRuntime：复现现场报错 + 证明正确形状 ══════════════════════ */

{
  const bug = composeChild({ allow: ['read'] });
  check('A1 真 ToolRuntime 逐字复现现场报错（证明这就是那个 bug）',
    bug.threw === true && bug.message === LIVE_ERROR, bug.message);
  check('A1 反向变异：同一条判据对 `{ allow: [] }` 必须不成立（不是恒真）',
    bug.threw === true && composeChild({ allow: [] }).threw === false);

  const none = composeChild({ allow: [] });
  check('A2 `{ allow: [] }` 合法：不抛，且子作用域可见工具 = 0（= 没有工具）',
    none.threw === false && none.visible.length === 0,
    `threw=${none.threw} visible=${JSON.stringify(none.visible)}`);
  check('A2 反向变异：可见工具为 0 不是「什么都看不到」的空作用域',
    none.visible.length === 0 && composeChild(undefined).visible.length === REVIEWER_SCOPE_TOOLS.length,
    `inherit=${JSON.stringify(composeChild(undefined).visible)}`);

  const inherit = composeChild(undefined);
  check('A3 **省略 `toolFilter` 不是「没有工具」**：子 Agent 照样继承父预设的全部工具',
    inherit.threw === false && inherit.visible.length === REVIEWER_SCOPE_TOOLS.length,
    `visible=${JSON.stringify(inherit.visible)}`);

  const empty = composeChild({});
  check('A4 `{}`（allow/deny 都没有）是非法形状：`restrict` 直接抛 no-op',
    empty.threw === true && /no-op/.test(empty.message), empty.message);
}

/* ══ B. 静态扫源码：名字必须被证实，复审过滤器里一个名字都不许有 ═════════ */

/** 抽出所有 `toolFilter: { ... }` 字面量里的 allow/deny 工具名。 */
function toolFilterNames(source) {
  const names = [];
  for (const site of source.matchAll(/toolFilter\s*:\s*(\{[^}]*\})/g)) {
    for (const arr of site[1].matchAll(/\b(?:allow|deny)\s*:\s*\[([^\]]*)\]/g)) {
      for (const literal of arr[1].matchAll(/'([^']*)'|"([^"]*)"/g)) names.push(literal[1] ?? literal[2]);
    }
  }
  return names;
}

/** 抽一个顶层 `const NAME = [ 'a', 'b', … ]` 里的字符串字面量；找不到返回 null。 */
function arrayConstantNames(source, ident) {
  const match = new RegExp(`const\\s+${ident}\\s*=\\s*\\[([\\s\\S]*?)\\]`).exec(source);
  if (match === null) return null;
  return [...match[1].matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2]);
}

/**
 * 抽出所有 `.restrict({ ... })` 里 allow/deny 命名的工具名。
 * 名字可以直接是字符串数组，也可以是**顶层常量**（`deny: WORK_TOOLS`）—— 后者要解析常量，
 * 否则「名字有没有被证实」这件事就会被一个标识符绕过去。
 * @param {string} source - 源码。
 * @returns {string[]} 被命名的工具；无法解析的标识符记成 `?<ident>`（照样会被判为未证实）。
 */
function restrictNames(source) {
  const names = [];
  for (const site of source.matchAll(/\.restrict\s*\(\s*(\{[^}]*\})/g)) {
    for (const arr of site[1].matchAll(/\b(?:allow|deny)\s*:\s*(?:\[([^\]]*)\]|([A-Za-z_$][\w$]*))/g)) {
      if (arr[1] !== undefined) {
        for (const literal of arr[1].matchAll(/'([^']*)'|"([^"]*)"/g)) names.push(literal[1] ?? literal[2]);
        continue;
      }
      const resolved = arrayConstantNames(source, arr[2]);
      if (resolved === null) names.push(`?${arr[2]}`);
      else names.push(...resolved);
    }
  }
  return names;
}

const indexPath = new URL('../index.js', import.meta.url);
const reviewerPath = new URL('../reviewer.js', import.meta.url);
const indexSource = readFileSync(indexPath, 'utf8');
const reviewerSource = readFileSync(reviewerPath, 'utf8');
const indexMod = await import(indexPath.pathname);

{
  const filterSites = [...indexSource.matchAll(/toolFilter\s*:/g)].length;
  check('B1 扫描非空转：`index.js` 里确实有 4 个 `toolFilter`（整段复审、定向复审、逐条建议、提示词改写）',
    filterSites === 4, `sites=${filterSites}`);
  check('B1 扫描非空转：`reviewer.js` 里确实有 1 个代码里的 `ctx.tools.restrict(`',
    [...reviewerSource.matchAll(/ctx\.tools\.restrict\s*\(/g)].length === 1,
    `sites=${[...reviewerSource.matchAll(/ctx\.tools\.restrict\s*\(/g)].length}`);

  const names = toolFilterNames(indexSource);
  check('B2 派单点 `toolFilter` 里出现的每个名字都必须被证实存在于该作用域',
    names.every((name) => REVIEWER_SCOPE_TOOLS.includes(name)),
    `names=${JSON.stringify(names)}（已证实：${REVIEWER_SCOPE_TOOLS.join(', ')}）`);
  check('B2 反向变异：把 `{ allow: [\'read\'] }` 字面量塞进源码副本，扫描器必须查出来并判红',
    toolFilterNames(indexSource).every((n) => REVIEWER_SCOPE_TOOLS.includes(n))
    && toolFilterNames(`${indexSource}\ntoolFilter: { allow: ['read'] }`).some((n) => !REVIEWER_SCOPE_TOOLS.includes(n)),
    JSON.stringify(toolFilterNames(`${indexSource}\ntoolFilter: { allow: ['read'] }`)));

  check('B3 复审子 Agent 的过滤器**一个工具名都不许有**（零工具是设计，不是巧合）',
    names.length === 0, `names=${JSON.stringify(names)}`);
  check('B3 反向变异：同一个「一个名字都不许有」判据，对塞回 `read` 的源码必须变红',
    toolFilterNames(indexSource).length === 0
    && toolFilterNames(`${indexSource}\ntoolFilter: { allow: ['read'] }`).length === 1);

  // 四个派单点必须**共用同一个来源**，否则又会只修一条、漏掉另一条。
  const sharedCalls = [...indexSource.matchAll(/toolFilter\s*:\s*reviewerToolFilter\s*\(\s*\)/g)].length;
  const definitions = [...indexSource.matchAll(/function\s+reviewerToolFilter\s*\(/g)].length;
  check('B4 四个派单点共用同一个过滤器来源（1 处定义 + 4 处调用）',
    sharedCalls === 4 && definitions === 1, `calls=${sharedCalls} defs=${definitions}`);
  check('B4 反向变异：把其中一处换回内联字面量，共有来源的判据必须变红',
    sharedCalls === 4 && definitions === 1
    && [...`${indexSource}\ntoolFilter: { allow: ['read'] }`.matchAll(/toolFilter\s*:\s*reviewerToolFilter\s*\(\s*\)/g)].length === 4
    && [...`${indexSource.replace(/toolFilter\s*:\s*reviewerToolFilter\s*\(\s*\)/, "toolFilter: { allow: ['read'] }")}`
      .matchAll(/toolFilter\s*:\s*reviewerToolFilter\s*\(\s*\)/g)].length === 3);

  check('B5 过滤器来源本身导出了（测试能直接调它，而不是靠正则猜实现）',
    typeof indexMod.reviewerToolFilter === 'function', typeof indexMod.reviewerToolFilter);
  if (typeof indexMod.reviewerToolFilter === 'function') {
    const filter = indexMod.reviewerToolFilter();
    check('B5 它返回的就是「填了 allow 的空过滤器」（不是省略、不是 `{}`、不是 deny）',
      filter !== undefined && Array.isArray(filter.allow) && filter.allow.length === 0
      && filter.deny === undefined, JSON.stringify(filter));
    check('B5 把它套进真 ToolRuntime：不抛、可见工具 = 0',
      composeChild(filter).threw === false && composeChild(filter).visible.length === 0);
  }

  // `reviewer.js` 那一个 `.restrict(` 是有意的「尽力而为」：它 deny 的是**别的预设**里
  // 可能存在的干活工具名，在审核预设这一份作用域里无法证实，而且预设根本没挂那些工具。
  // 所以它必须留在自己的 try/catch 里（`reviewer.js:825-832` 的原话：失败绝不该外抛，
  // 否则整个预设声明注册失败、预设从选择器里消失）。这里是**如实钉住**这个豁免，
  // 而不是假装它的名字被证实了。
  {
    const at = reviewerSource.indexOf('ctx.tools.restrict(');
    const before = reviewerSource.slice(Math.max(0, at - 420), at);
    const after = reviewerSource.slice(at, at + 700);
    const guarded = before.includes('try {') && after.includes('catch (error)');
    const restrictToolNames = restrictNames(reviewerSource);
    const unverified = restrictToolNames.filter((n) => !REVIEWER_SCOPE_TOOLS.includes(n));
    check('B6 扫描器能解析 `deny: WORK_TOOLS` 这个常量（否则一个标识符就能绕过核对）',
      restrictToolNames.length === 20 && restrictToolNames.includes('bash'),
      `resolved=${restrictToolNames.length} first=${restrictToolNames[0]}`);
    check('B6 `reviewer.js` 的 `.restrict(` 名字在测试替身里**无法证实** → 它必须留在 try/catch 里（有条件的豁免）',
      guarded === true && unverified.length === restrictToolNames.length,
      `guarded=${guarded} unverified=${unverified.length}/${restrictToolNames.length}`);
    check('B6 反向变异：把 try/catch 拿掉，同一个「必须被守护」判据必须变红',
      guarded === true
      && before.replace('try {', '').includes('try {') === false);
  }
}

/* ══ C. 端到端：两个派单点真跑，宿主的 `subagents.start` 真套过滤器 ══════ */

{
  const handlers = new Map();
  const registeredCommands = new Map();
  const appended = [];
  const starts = [];
  const composeErrors = [];
  const childVisible = [];
  let projection = null;
  let projectionState = null;
  // 投影替身：`toolCalls` ≥ 门槛保证通用复审真的会跑；`turnStartSeq` 决定「本回合是否已派过
  // directed 复审」的去重 token（`directedTurns`）。C-2 会把它推到 9，免得被 C-1 的去重吃掉。
  const reviewState = { toolCalls: 3, totalToolCalls: 9, turnStartSeq: 5 };
  const timers = [];
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (fn, ms) => { const id = realSetInterval(fn, ms); timers.push(id); return id; };

  const REVIEW = analysisReviewText({
    verdict: 'drifting',
    headline: '零工具哨兵_主题漂移',
    dialog: ['你：「零工具」'],
    summary: '整条偏了。',
    analysis: ['细节上打转，同一个细节。', '没先确认口径。'],
    advice: ['[给用户] 先定口径。', '[给Agent] 先给样例。'],
  });

  const agent = {
    id: 'review-1',
    session: {
      header: { id: 'review-1', cwd: '/w' },
      seq: 7,
      requestHeader: () => ({ config: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' } }),
      snapshotEvents: () => [
        { type: 'turn/start', seq: 5, data: { turn: 1 } },
        { type: 'tool/call', seq: 6, data: { turn: 1, callId: 'c1', name: 'bash', arguments: '{}' } },
      ],
      append(type, data, opts) { appended.push({ type, data, opts }); this.seq += 1; return { type, seq: this.seq, data }; },
    },
    followups: [],
    injects: [],
    followup(m) { this.followups.push(m); },
    inject(m) { this.injects.push(m); },
  };

  const indexModule = await import(new URL(`../index.js?e2e=${Math.random()}`, import.meta.url).pathname);
  indexModule.apply({
    logger: { warn: (...a) => console.log('WARN', ...a.map(String)), info() {} },
    reflect: { provide: () => {}, get: () => undefined },
    effect: (fn) => fn(),
    on: (name, fn) => { handlers.set(name, fn); },
    inject: (names, cb) => {
      const scope = {
        names,
        effect: (fn) => fn(),
        commands: { register: (definition) => { registeredCommands.set(definition.name, definition); return () => {}; } },
      };
      cb(scope);
    },
    sessionProjections: {
      register: (def) => { projection = def; return () => {}; },
      stateOf: (s, k) => (k === 'agentPreset' ? 'review'
        : k === 'reviewMode' ? (projectionState ?? reviewState)
          : undefined),
    },
    subagents: {
      start: async (name, req) => {
        starts.push(req);
        // **shipped 的形状**：`dsh-subagent/lib/index.js:522` 只在键存在时 restrict。
        try {
          const composed = composeChild(req?.toolFilter);
          if (composed.threw) throw new Error(composed.message);
          childVisible.push(composed.visible);
        } catch (error) {
          composeErrors.push(error instanceof Error ? error.message : String(error));
          throw error;
        }
        return {
          id: `rev-${starts.length}`,
          result: Promise.resolve({ output: [{ type: 'text', text: REVIEW }], stopReason: 'completed' }),
          dispose: async () => {},
        };
      },
    },
    agents: { list: () => [agent], get: (id) => (id === agent.id ? agent : undefined), withoutInitiator: (fn) => fn() },
  }, { watchCodex: false, minToolCalls: 1 });

  const settle = async () => { for (let i = 0; i < 40; i += 1) await new Promise((r) => setTimeout(r, 5)); };
  const forms = () => appended.map((e) => e.data?.message?.source?.form ?? '').filter((f) => f !== '');
  const foldProjection = () => {
    let state = projection.init(agent.session.header, 0);
    for (const event of appended) state = projection.apply(state, { type: event.type, seq: event.seq, data: event.data });
    projectionState = state;
    return state;
  };

  // ── C-1：面板 / A 路那条 `runDirectedReview` ─────────────────────────
  const definition = registeredCommands.get('review-mode');
  check('C0 面板命令 `review-mode` 注册上了（端到端要真从它点火）', definition !== undefined);
  if (definition !== undefined) {
    starts.length = 0;
    composeErrors.length = 0;
    childVisible.length = 0;
    appended.length = 0;
    definition.handler({ agent, rawInput: 'dir self', commandId: 'cmd-1', attachments: [], signal: new AbortController().signal });
    await settle();
    check('C1 面板点火真的派了 1 次复审（不是被 toolFilter 抛错挡在门外）',
      starts.length === 1, `starts=${starts.length} composeErrors=${JSON.stringify(composeErrors)}`);
    check('C1 子作用域套过滤器时**没有抛错**', composeErrors.length === 0, JSON.stringify(composeErrors));
    check('C1 复审子 Agent 的可见工具 = 0（零工具真的生效了）',
      childVisible.length === 1 && childVisible[0].length === 0, JSON.stringify(childVisible));
    check('C1 捕获到的 `toolFilter` 就是那一个空 allow 形状',
      JSON.stringify(starts[0]?.toolFilter) === JSON.stringify({ allow: [] }),
      JSON.stringify(starts[0]?.toolFilter));
    const state = foldProjection();
    check('C1 复审跑完并落了卡片（现场症状是「从来没跑起来、面板 0 条」）',
      state.feed.length === 1, `feed=${state.feed.length}`);
    check('C1 没有投出 `failed`（现场那一句「复审没有完成 —— tools.restrict()…」）',
      !forms().includes('failed'), forms().join(',') || '（没有事件）');

    // ── D：零工具之后，证据与格式块仍然只从提示词进 ─────────────────
    const prompt = String(starts[0]?.prompt?.[0]?.text ?? '');
    check('D1 复审员仍然从提示词拿到**输出格式块**（零工具后它唯一的依据）',
      /输出格式/.test(prompt) && /具体对话/.test(prompt) && /对话概述/.test(prompt)
      && /分析/.test(prompt) && /建议/.test(prompt),
      prompt.split('\n')[0]);
    check('D1 复审员仍然从提示词拿到**证据段**（三路主体都在）',
      /【审我】/.test(prompt) && /【审 Agent】/.test(prompt) && /【审对话】/.test(prompt)
      && /针对性分析|具体对话/.test(prompt));
    check('D1 提示词里没有一句要求它去 `read` / 调工具（零工具不欠它任何东西）',
      !/调用\s*`?read`?|用\s*`?read`?|read\s*工具/.test(prompt), prompt.split('\n')[2] ?? '');
  }

  check('C2 不注册无目标的通用轮收尾派单（由已选目标消息边沿驱动）', !handlers.has('agent/turn-stopping'));

  // ── C-3：反向变异 —— 同一套端到端判据对历史那个错名字必须变红 ────────
  {
    const buggy = composeChild({ allow: ['read'] });
    check('C3 反向变异：把 `read` 塞回过滤器，同一套「不抛、零工具」判据必须变红',
      buggy.threw === true && buggy.message === LIVE_ERROR,
      buggy.message);
    check('C3 反向变异：`composeChild` 对正确形状返回的确实不是错误',
      composeChild({ allow: [] }).threw === false && composeChild({ allow: [] }).visible.length === 0);
  }

  for (const id of timers) clearInterval(id);
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
