/**
 * 复审员必须用**主对话的模型配置**（用户 2026-10 的原话：
 * 「你就主对话用什么，审核用什么，**模型配置一样，就是上下文不一样**」）。
 *
 * 为什么要有这个测试（真发生过的失败）：
 * 用户重启 DSH 后点面板按钮，会话里出现
 *   `本轮运行失败 llm-deepseek: no API key for provider route "deepseek-official" … MISSING_CREDENTIAL`
 * —— 而**主对话本身是通的**。真因是**两条路走了不同的 provider route**：
 *   主对话 `request/header.config.provider = "deepseek-account"`（账号凭据，能用）；
 *   新会话的创建默认是 `"deepseek-official"`（要裸 `DEEPSEEK_API_KEY`，本机没有）。
 * 复审员是 `spawn` 子 Agent，而 spawn **按构造继承父 Agent 的 provider/model**
 * （shipped 源码 `dsh-subagent/lib/types/child-agent.js` 的
 * `resolveChildAgentOptions` / `parentAgentOptionsForDelegation`），
 * 所以父会话一律 `deepseek-official`，复审就一律 `MISSING_CREDENTIAL`。
 *
 * 修法：把**被复审的那条会话**的模型选择显式交给子 Agent
 * （`ctx.subagents.start(provider, { agentOptions })` —— `agentOptions` 是 spawn
 * provider 明确声明支持的能力，shipped 源码 `dsh-subagent/lib/index.js` 的
 * `assertCapabilities` 就检查它）。上下文**不共享**，只共享模型配置。
 *
 * 这个测试在两处派单上都钉死这件事：`runReview`（轮收尾）与 `watchOnce`（Codex 监控）。
 */

let failed = 0;
const check = (label, pass, extra = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  ${extra}`}`);
  if (!pass) failed += 1;
};

const REVIEW = ['结论: on-track', '| | 审我 | 审对话 | 审 Agent |', '|---|---|---|---|',
  '| ① 主题漂移 | 没漂 | 没漂 | 没漂 |',
  '| ② 局部纠结 | 没有 | 没有 | 没有 |',
  '| ③ 选择理性 | 合理 | 合理 | 合理 |',
  '| 建议 | 继续 | 继续 | 继续 |'].join('\n');

/** 造一条「主对话用 deepseek-account」的假审核会话。 */
function makeAgent(overrides = {}) {
  const appended = [];
  const session = {
    header: { id: 'review-1', cwd: '/w' },
    seq: 0,
    snapshotEvents: () => [],
    // shipped 形状：`dsh-subagent/lib/index.js:414-424` 的
    // `parentAgentOptionsForDelegation` 就是读 `session.requestHeader()?.config`。
    requestHeader: () => ({
      config: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high', maxTokens: 256000 },
      adapterDefaults: {},
    }),
    append(type, data, opts) { appended.push({ type, data, opts }); this.seq += 1; return { type, seq: this.seq, data }; },
  };
  return {
    id: 'review-1',
    // 会话创建时的 fallback 选项（shipped 读它作为 requestHeader 之前的兜底）。
    options: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' },
    session,
    appended,
    injected: undefined,
    inject(m) { this.injected = m; },
    followup(m) { this.followed = m; },
    ...overrides,
  };
}

/**
 * 起一份宿主插件，返回能手动触发 `agent/turn-stopping` 的入口。
 * @param {object} agent - 被复审的审核会话。
 * @param {object} [cfg] - 额外配置。
 * @returns {Promise<object>} `{emit, starts, mod}`。
 */
async function boot(agent, cfg = {}) {
  const starts = [];
  const handlers = new Map();
  const timers = [];
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (fn, ms) => { const id = realSetInterval(fn, ms); timers.push(id); return id; };
  const mod = await import(new URL(`../index.js?inherit=${Math.random()}`, import.meta.url).pathname);
  const ctx = {
    logger: { warn: (...a) => console.log('WARN', ...a.map(String)), info() {} },
    reflect: { provide: () => {}, get: () => undefined },
    effect: (fn) => fn(),
    on: (name, fn) => { handlers.set(name, fn); },
    sessionProjections: {
      register: () => () => {},
      // 预设 = review；工具调用计数 ≥ minToolCalls，保证复审真的会跑。
      stateOf: (s, k) => (k === 'agentPreset' ? 'review' : (k === 'reviewMode' ? { toolCalls: 3, totalToolCalls: 9 } : undefined)),
    },
    subagents: {
      start: async (name, req) => {
        starts.push({ name, req });
        return { id: 'rev-1', result: Promise.resolve({ output: [{ type: 'text', text: REVIEW }] }), dispose: async () => {} };
      },
    },
    agents: { list: () => [agent], get: () => agent, withoutInitiator: (fn) => fn() },
  };
  mod.apply(ctx, { watchCodex: false, minToolCalls: 1, ...cfg });
  for (const id of timers) clearInterval(id);
  const emit = async (name, payload) => {
    const fn = handlers.get(name);
    if (typeof fn !== 'function') return;
    await fn(payload);
  };
  return { emit, starts, mod };
}

const settle = async () => { for (let i = 0; i < 40; i += 1) await new Promise((r) => setTimeout(r, 5)); };

// ── 1. 轮收尾的复审（runReview）─────────────────────────────
{
  const agent = makeAgent();
  const { emit, starts } = await boot(agent);
  await emit('agent/turn-stopping', { agent, turn: 1 });
  await settle();

  check('轮收尾真的派了一次复审（正对照）', starts.length === 1, `starts=${starts.length}`);
  const req = starts[0]?.req ?? {};
  const options = req.agentOptions;
  check('复审派单带上了 agentOptions（spawn 支持的能力；不带就按父会话默认走）',
    options !== undefined && options !== null, JSON.stringify(options));
  check('复审的 provider = 被复审会话的 provider（deepseek-account，不是 deepseek-official）',
    options?.provider === 'deepseek-account', `provider=${String(options?.provider)}`);
  check('复审的 model = 被复审会话的 model',
    options?.model === 'deepseek-flash', `model=${String(options?.model)}`);
  check('复审的 reasoningEffort 一并继承（同一份模型配置）',
    options?.reasoningEffort === 'high', `effort=${String(options?.reasoningEffort)}`);
  check('上下文**不**共享：复审还是自己的 parent + 自己那份复审提示词',
    req.parent === agent && String(req.prompt?.[0]?.text ?? '').includes('独立复审员'),
    `parent=${req.parent === agent} ownPrompt=${String(req.prompt?.[0]?.text ?? '').includes('独立复审员')}`);
}

// ── 2. 会话还没写过 request/header 时，退回创建选项 ─────────
{
  const agent = makeAgent();
  agent.session.requestHeader = () => undefined;
  const { emit, starts } = await boot(agent);
  await emit('agent/turn-stopping', { agent, turn: 2 });
  await settle();
  const options = starts[0]?.req?.agentOptions;
  check('没有 request/header 时用会话创建选项兜底（仍是同一条 route）',
    options?.provider === 'deepseek-account' && options?.model === 'deepseek-flash',
    JSON.stringify(options));
}

// ── 3. 两边都读不到时**不许编**（宁可不传，也不传一个错的）──
{
  const agent = makeAgent();
  agent.session.requestHeader = () => undefined;
  agent.options = undefined;
  const { emit, starts } = await boot(agent);
  await emit('agent/turn-stopping', { agent, turn: 3 });
  await settle();
  check('模型配置两边都读不到时不传 agentOptions（不猜 provider）',
    starts[0]?.req?.agentOptions === undefined,
    JSON.stringify(starts[0]?.req?.agentOptions));
}

// ── 4. 两条派单路必须共用同一个「取主对话模型配置」的入口 ─────
// Codex 监控那条路（`watchOnce`）由真实定时器驱动，端到端断言放在
// `test/lane-watch-test.mjs`（它已经在等真 tick）。这里只钉住**只有一个入口**，
// 免得修了一条路、漏了另一条。
{
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const helperCalls = source.match(/reviewerAgentOptions\(/g) ?? [];
  const spawns = source.match(/ctx\.subagents\.start\(/g) ?? [];
  check('index.js 里两处 ctx.subagents.start 都在',
    spawns.length === 2, `spawns=${spawns.length}`);
  check('两处派单都经同一个模型继承入口（1 处定义 + 2 处调用）',
    helperCalls.length === 3, `reviewerAgentOptions( 出现 ${helperCalls.length} 次`);
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
