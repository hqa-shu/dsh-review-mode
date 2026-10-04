/**
 * 新要求的**最硬一条**：用**真的 `Session` 类**证明投递走的是合法面事件。
 *
 * 前面几个测试用的都是假会话；这个测试把 `index.js` 真实的 `appendReviewSurface()`
 * 直接接到 `@deepseek-ai/dsh-session` 的真 `Session` 上，证明：
 *
 *   1. `user/message` 被真面事件校验接受（不抛），**并且模型看得到**
 *      —— `deriveMessages()` 里真的有这条消息；
 *   2. 它**不需要** `ignorable`：它是已知事件类型（这正是不用自定义事件类型的原因）；
 *   3. 自定义事件类型**走不通**：`session.append()` 造出来的事件信封只有
 *      `{type,seq,time,data}` —— 没有 `ignorable`，而 `validateStoredEvents()`
 *      明确拒绝没有 `ignorable` 的未知类型（重启读日志会失败）。所以「加一个自己的
 *      会话事件类型」在这个构建里**做不到**，只能借用已有的、对话不渲染的面事件。
 *   4. 面事件必须带 `surfaceOp:'append'`，否则当场被拒。
 *
 * **为什么不是 `developer/message`**（2026-10 现场失败，面板的诚实活性行抓到）：
 * 它是**步事件**，shipped 的格式校验要求它带真实的 `turn`/`step`
 * （`dsh-session-format-v3-to-v4/lib/index.js:324`），而我们的评价是异步产物、
 * 投递时没有开着的 step —— 于是每次投递都被拒，报的正是
 * `developer/message turn must be a non-negative safe integer`。
 * 逐字复现与「补 turn 也不行」的证明在 `test/surface-format-test.mjs`；
 * 这里只证明**现在这条路**在真 `Session` 上是通的。
 *
 * 对话不渲染那一步的源码依据（客户端 bundle，不在本插件的 node_modules 里，
 * 所以这里引用行号而不 import）：
 *   - `dsh-client-ui-chat/lib/client.js:9267-9297` `messageDefinition.start`：
 *     `event.data.source.kind !== "user"` → `contextMessage(...)` → `kind:'context'`；
 *   - 同文件 `:7719` `isVisibleChatNode` 明确排除 `node.kind === "context"`。
 *   所以「投 user/message 就会显示在对话里」只对 `source.kind === 'user'` 成立。
 */

import { Session } from '@deepseek-ai/dsh-session';
import { validateStoredEvents } from '@deepseek-ai/dsh-session-persistence';

import { appendReviewSurface } from '../index.js';
import { ANALYSIS_SECTIONS, emptyAnalysis, fillAnalysis, renderAnalysisText } from '../rubric.js';

let failed = 0;
let passed = 0;
const check = (label, pass, extra = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  ${extra}`}`);
  if (pass) passed += 1; else failed += 1;
};

const REVIEW = {
  lane: 'me',
  turn: 3,
  sections: ANALYSIS_SECTIONS,
  ...fillAnalysis(emptyAnalysis(), {
    headline: '有漂移',
    dialog: ['你说：「课件讲了吗」'],
    summary: '在核对课件覆盖。',
    analysis: ['第二个问题跟原问题无关。'],
    advice: ['[给用户] 下一条就一句。'],
  }),
  verdict: 'drifting',
  openIssues: [],
  resolvedIssues: [],
  forUser: [],
  forAgent: [],
};

// ── 真的 Session + 真的投递函数 ───────────────────────────
const session = Session.create('surface-probe');
const agent = {
  id: 'surface-probe',
  session,
  injects: [],
  inject(m) { this.injects.push(m); },
};

let usedSurface = null;
let threw = null;
try {
  usedSurface = appendReviewSurface(agent, 'notice', REVIEW, renderAnalysisText(REVIEW));
} catch (error) { threw = error; }

check('真实的 appendReviewSurface 对真 Session 不抛', threw === null, threw === null ? '' : String(threw).slice(0, 160));
check('它走了「非对话可见」的那条路（返回 true）', usedSurface === true);
check('它没有退回 agent.inject', agent.injects.length === 0, `injects=${agent.injects.length}`);

const events = session.snapshotEvents();
const surface = events.filter((event) => event.type === 'user/message');
check('会话日志里多了一条 user/message', surface.length === 1, `→ ${surface.length} 条`);
check('它**不是** developer/message（那类必须落在开着的 step 里，我们做不到）',
  events.every((event) => event.type !== 'developer/message'));
check('形状：data 就是消息本身（role/id/content/source），source.kind 是我们的，surfaceOp 已落盘',
  surface[0]?.data?.role === 'user'
  && typeof surface[0]?.data?.id === 'string'
  && Array.isArray(surface[0]?.data?.content)
  && surface[0]?.data?.source?.kind === 'review-mode'
  && surface[0]?.surfaceOp === 'append',
  JSON.stringify([surface[0]?.data?.role, surface[0]?.data?.source?.kind, surface[0]?.surfaceOp]));

const messages = session.deriveMessages();
check('模型看得到这条消息（deriveMessages 里有它）',
  messages.some((message) => message.role === 'user'
    && JSON.stringify(message.content ?? '').includes('结论: drifting')),
  `roles=${messages.map((m) => m.role).join(',')}`);
check('投影也折得到它（applyEvent 认 source.kind=review-mode 的 user/message）',
  surface.length === 1 && surface[0].data.source.review.verdict === 'drifting');
check('**别人的** user/message（source.kind=user）不会被我们的投影折进去',
  surface[0].data.source.kind !== 'user');

// ── 自定义事件类型：走不通（这就是不用它的原因）────────────
const unknown = session.append('review-mode/entry', { verdict: 'drifting' });
check('session.append 造的事件信封里**没有** ignorable（无法标记）',
  unknown.ignorable === undefined, JSON.stringify(Object.keys(unknown)));
check('未知类型没有 ignorable → 持久化读取**拒绝**它（重启就坏）', (() => {
  try {
    validateStoredEvents({ id: 'surface-probe' }, [unknown], 'probe://log');
    return false;
  } catch (error) {
    return /not marked ignorable/.test(String(error?.message ?? error));
  }
})());

// ── 面事件的形状约束：user/message 必须带 surfaceOp（developer/message 另有角色约束）──
const noSurface = Session.create('surface-probe-3');
let surfaceError = null;
try {
  noSurface.append('user/message', {
    id: 'x2', role: 'user', source: { kind: 'review-mode' }, content: [{ type: 'text', text: 'x' }],
  });
} catch (error) { surfaceError = error; }
check('不带 surfaceOp 会被拒绝（所以我们的调用必须带它）',
  surfaceError !== null && /requires a surfaceOp/.test(String(surfaceError.message)),
  String(surfaceError?.message ?? '(没抛)'));

// 角色写错在 developer/message 上仍然当场被拒 —— 这是「不能拿 developer/message 硬塞」的旁证。
const wrongRole = Session.create('surface-probe-2');
let roleError = null;
try {
  wrongRole.append('developer/message', {
    message: { id: 'x1', role: 'user', source: { kind: 'review-mode' }, content: [{ type: 'text', text: 'x' }] },
  }, { surfaceOp: 'append' });
} catch (error) { roleError = error; }
check('developer/message 的角色写错（user）会被面事件校验当场拒绝',
  roleError !== null && /developer role must occur together|role "developer"/.test(String(roleError.message)),
  String(roleError?.message ?? '(没抛)'));

console.log(failed === 0 ? `\n全部通过（${passed} 项）` : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
