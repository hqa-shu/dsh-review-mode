/**
 * 开场测试（2026-10 用户批准的**入口唯一化**之后）。
 *
 * 设计决定（用户原话：「OK，你先这样改」）：
 *   入口**只有**下面审核面板那三个方块 [审你自己] [审其它 DSH 会话] [审 Codex 对话]。
 *   开场**不再问「审谁」** —— 不许 `ask_user_question`、不许 `list_conversations`、
 *   不许列候选、不许讲流程。对话区从第一秒起就只留给「用户问、Agent 答」。
 *
 * 改前（**真发生过的现场失败**）：宿主 `agent/created` 推的开场要求主 Agent
 * 「第一条回复只能是 ask_user_question」，把三个方向做成可点选项，再一轮轮把候选
 * 做成选项 —— 那是和面板**重复的第二个入口**，也正因为有它，A 路的结论才会走到
 * 对话记录里、而面板空着。
 *
 * 这个测试证明：
 *   1. 审核模式的新会话仍然被唤醒一次（用 `followup`，不是 `inject`）；
 *   2. 非审核模式、已有内容的会话都不被打扰；
 *   3. 开场**只有一句话**，且指的是**面板**；
 *   4. 开场里**没有** `ask_user_question` / `list_conversations` / 候选选项循环。
 *
 * 反向变异：把旧的多步开场拼回去，同一条「开场不再要求点选项」的判据必须变红。
 */

const mod = await import(new URL('../index.js', import.meta.url).pathname);
const handlers = new Map();
const mk = (preset, seq) => ({
  id: `a-${preset}-${seq}`,
  session: { header: { id: 's', cwd: '/w' }, seq, snapshotEvents: () => [] },
  followups: [],
  followup(m) { this.followups.push(m); },
  inject() {},
});
const review = mk('review', 0);
const other = mk('standard', 0);
const busy = mk('review', 7);

mod.apply({
  logger: { warn: (...a) => console.log('  WARN', ...a.map(String)), info() {} },
  reflect: { provide: () => {}, get: () => undefined },
  effect: (fn) => fn(),
  on: (name, fn) => handlers.set(name, fn),
  sessionProjections: {
    register: () => () => {},
    stateOf: (session, key) => (key === 'agentPreset' ? session._preset : undefined),
  },
  subagents: { start: async () => ({ result: Promise.resolve({}), dispose: async () => {} }) },
  agents: { list: () => [review, other, busy], get: () => undefined, withoutInitiator: (o) => o() },
}, {});
review.session._preset = 'review';
busy.session._preset = 'review';
other.session._preset = 'standard';

const onCreated = handlers.get('agent/created');
if (onCreated === undefined) { console.log('FAIL  没有注册 agent/created'); process.exit(1); }
for (const agent of [review, other, busy]) onCreated({ agent });

const text = review.followups[0]?.content?.[0]?.text ?? '';

/** 判据：开场里**不许**出现「让主 Agent 去点选候选」的那套指令。 */
const noOptionLoop = (value) => !/ask_user_question/.test(value)
  && !/list_conversations/.test(value)
  && !/给出下面三个方向|三个方向做成|下一批（还有/.test(value);
/** 判据：开场必须把用户指到面板。 */
const pointsAtPanel = (value) => /面板/.test(value);

const checks = [
  ['审核模式会话收到了开场', review.followups.length === 1],
  ['非审核模式没被打扰', other.followups.length === 0],
  ['已有内容的会话没被打扰', busy.followups.length === 0],
  ['用的是 followup（会唤醒）不是 inject', typeof review.followup === 'function' && review.followups.length === 1],
  ['开场只有一句话（没有第二步、没有换行）', text.length > 0 && !text.includes('\n'), `${text.length} 字`],
  ['开场把用户指向审核面板', pointsAtPanel(text), text.slice(0, 80)],
  ['开场**不再**要求 ask_user_question / list_conversations / 候选选项循环',
    noOptionLoop(text), text.slice(0, 120)],
  ['开场不要求主 Agent 输出任何表格',
    !/\|.*\|/.test(text) && !/输出格式/.test(text), text.slice(0, 120)],
  ['反向变异：把旧的多步开场拼回去，同一条判据必须变红',
    noOptionLoop(text) === true
    && noOptionLoop(`${text}\n立刻调用 ask_user_question 给出下面三个方向让他选。`) === false],
];

let bad = 0;
for (const [label, pass, extra] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${extra === undefined ? '' : `  ${extra}`}`);
  if (!pass) bad += 1;
}
process.exit(bad === 0 ? 0 : 1);
