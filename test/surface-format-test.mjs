/**
 * 投递事件的**格式合法性** —— 面板的诚实活性行抓到的那次真失败。
 *
 * 现场（用户截图，逐字）：
 *   跑不起来 · 审核失败  通道是通的，但最近一次运行失败（130 秒前）：
 *   `developer/message turn must be a non-negative safe integer · UNKNOWN`
 *
 * 真因是**格式**而不是逻辑：`developer/message` 是**步事件**（step-scoped），
 * `dsh-session-format-v3-to-v4/lib/index.js:324` 要求它带真实的 `turn`/`step`：
 *
 *   for (const field of ["turn", "step"])
 *     if (sessionFormatCount(data[field], `developer/message ${field}`) === 0)
 *       throw new SessionFormatError(`developer/message ${field} must be positive`);
 *
 * 而 `sessionFormatCount`（同包 `@deepseek-ai/dsh-session-format`）在字段不是
 * 非负安全整数时抛的正是 `${label} must be a non-negative safe integer` ——
 * label 就是上面那个 `developer/message turn`。**整句一字不差。**
 *
 * 更狠的是第二层：补上 turn/step 也救不了。同文件 `:241` 的关系表写着
 * 「`system/message`、`developer/message`、`assistant/attempt` 必须 match an open
 * turn and step」，实现是 `Relationships.accept` → `requireStep`。我们的评价是
 * **异步**产物（复审子 Agent 跑完 / 监控 tick 才投），投递时没有任何开着的 step。
 * 所以「传一个 turn 进去」不是选项，**这类事件在结构上就不能由插件带外投放**。
 *
 * 结论（这次改动）：投递换成 `user/message` + 生产者自有的 `source.kind`
 * （`review-mode`）。它同样是面事件（模型看得到），但
 *   - 不在 `STEP_EVENT_TYPES` 里 → 不需要 turn/step（同文件 `:493-497`）；
 *   - 只要求 `source.kind` 非空且 ≠ `"plugin"`（同文件 `source()`，`:125-128`）；
 *   - 客户端的 `messageDefinition.start` 对 `source.kind !== "user"` 的
 *     `user/message` 走 `contextMessage` → `kind:'context'`，
 *     而 `isVisibleChatNode` 排除 `context`
 *     （`dsh-client-ui-chat/lib/client.js:9267-9297` / `:9251-9261` / `:7719`）。
 *
 * 本测试**同时**做三件事：
 *   1. 先复现那句真报错（对旧形状）——这是「红」的原始证据；
 *   2. 用**真的 `appendReviewSurface`** 的产物过同一条规则 —— 旧代码在这里必红；
 *   3. 若本机能找到 shipped 的 `dsh-session-format-v3-to-v4`，**直接从 asar 里逐字核对**
 *      上面引的那行源码确实存在（把「引文」变成可核对的断言）。
 */

import fs from 'node:fs';

import { appendReviewSurface } from '../index.js';
import { ANALYSIS, ANALYSIS_SECTIONS, renderAnalysisText } from '../rubric.js';

let failed = 0;
let passed = 0;
const check = (label, pass, extra = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  ${extra}`}`);
  if (pass) passed += 1; else failed += 1;
};

/* ── shipped 校验规则的忠实镜像（逐字对照上面引的源码行）────────────── */

/** 非负安全整数、且不是 -0；失败时抛 shipped 那句逐字文案。 */
function sessionFormatCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

/** `assertV4DeveloperData(event)` 里对 `developer/message` 的那两行（`:321-327`）。 */
function assertDeveloperData(event) {
  const data = event?.data;
  if (event?.type !== 'developer/message') return;
  const message = data?.message;
  if (typeof message !== 'object' || message === null || message.role !== 'developer') {
    throw new Error('format v4 developer/message requires turn, step, and a developer message');
  }
  for (const field of ['turn', 'step']) {
    if (sessionFormatCount(data[field], `developer/message ${field}`) === 0) {
      throw new Error(`developer/message ${field} must be positive`);
    }
  }
}

/** 生产者自有的 source（同包 `source()`，`:125-128`）。 */
function assertProducerSource(message) {
  const source = message?.source;
  if (typeof source !== 'object' || source === null || typeof source.kind !== 'string'
    || source.kind.length === 0 || source.kind === 'plugin') {
    throw new Error('format v4 message requires a producer-owned source kind');
  }
}

/** 面事件必须带 `surfaceOp:'append'`。 */
function assertAppendSurfaceOp(event) {
  if (event?.surfaceOp !== 'append') throw new Error(`session event "${event?.type}" is surface-eligible and requires a surfaceOp marker`);
}

/** 行准入：`assertV4RowAdmission` 对两种消息的合起来的效果。 */
function assertRowAdmission(event) {
  assertAppendSurfaceOp(event);
  if (event.type === 'developer/message') { assertDeveloperData(event); return; }
  if (event.type === 'user/message') {
    if (event.data?.role === 'developer') throw new Error('format v4 developer/message and developer role must occur together');
    assertProducerSource(event.data);
    return;
  }
  throw new Error(`unexpected surface type ${event.type}`);
}

/** 生命周期关系：`developer/message` 必须落在开着的 turn+step 里（`:241` / `:743`）。 */
function requireOpenStep(event, open) {
  if (event?.type !== 'developer/message') return;
  const data = event.data ?? {};
  if (open === null || data.turn !== open.turn || data.step !== open.step) {
    throw new Error('developer/message does not match an open turn and step');
  }
}

/* ── 1. 先复现那句真报错（旧形状 = 我们一直在投的东西）───────────────── */

const OLD_EVENT = {
  type: 'developer/message',
  surfaceOp: 'append',
  seq: 7,
  data: {
    message: {
      id: 'm1',
      role: 'developer',
      source: { kind: 'review-mode', form: 'notice' },
      content: [{ type: 'text', text: '结论: drifting' }],
    },
  },
};
let reproduced = '';
try { assertRowAdmission(OLD_EVENT); } catch (error) { reproduced = String(error.message); }
check('复现面板上那句逐字真报错（旧形状：developer/message 不带 turn/step）',
  reproduced === 'developer/message turn must be a non-negative safe integer',
  `→ ${JSON.stringify(reproduced)}`);

// 补上「真实」turn/step 也仍然不行 —— 投递时没有开着的 step（这是不能靠传参解决的原因）。
let relationshipError = '';
try { requireOpenStep({ ...OLD_EVENT, data: { ...OLD_EVENT.data, turn: 3, step: 2 } }, null); } catch (error) { relationshipError = String(error.message); }
check('即使补上 turn/step，带外投放仍然违反「必须落在开着的 step 里」',
  relationshipError === 'developer/message does not match an open turn and step',
  `→ ${JSON.stringify(relationshipError)}`);

/* ── 2. 真投递函数的产物必须过同一条规则（旧代码在这里必红）────────── */

const captured = [];
const fakeSession = {
  seq: 11,
  append(type, data, opts) { captured.push({ type, data, ...(opts ?? {}) }); return { type, seq: this.seq, data }; },
};
const fakeAgent = { id: 'a1', session: fakeSession, injects: [], inject(m) { this.injects.push(m); } };

const verdict = {
  verdict: 'drifting',
  lane: 'me',
  turn: 3,
  digestChars: 42,
  dropped: [],
  ...ANALYSIS.empty(),
};
ANALYSIS.fill(verdict, {
  headline: '范围一直在滚大',
  dialog: ['你说：「把界面也改一下」', '对面：「改好了」'],
  summary: '你在追界面验收，对面在改投影版本号。',
  analysis: ['界面这条至今没有任何验收证据。'],
  advice: ['[给用户] 说清验收标准。', '[给Agent] 补一条界面验收路径。'],
});

const usedSurface = appendReviewSurface(fakeAgent, 'notice', verdict, renderAnalysisText(verdict));

check('真 appendReviewSurface 走了面事件那条路（没退回 inject）',
  usedSurface === true && fakeAgent.injects.length === 0, `injects=${fakeAgent.injects.length}`);
check('它只 append 了一条事件', captured.length === 1, `→ ${captured.length} 条`);

let admissionError = null;
try { assertRowAdmission(captured[0]); } catch (error) { admissionError = error; }
check('**真投递的产物**过 shipped 行准入（旧代码：developer/message 不带 turn → 必红）',
  admissionError === null, admissionError === null ? `type=${captured[0]?.type}` : `→ ${admissionError.message}`);

check('投的是 user/message（不是步事件，所以没有 turn/step 要求）',
  captured[0]?.type === 'user/message', `type=${captured[0]?.type}`);
check('payload 就是消息本身（user/message 的形状是 {role,id,content,source}，不套 message）',
  captured[0]?.data?.role === 'user'
  && typeof captured[0]?.data?.id === 'string'
  && Array.isArray(captured[0]?.data?.content)
  && captured[0]?.data?.source?.kind === 'review-mode',
  JSON.stringify(Object.keys(captured[0]?.data ?? {})));
check('带 surfaceOp=append', captured[0]?.surfaceOp === 'append', String(captured[0]?.surfaceOp));
check('它**不是** developer/message（这正是旧失败的那一类）',
  captured[0]?.type !== 'developer/message');

/* ── 3. 「对话流里看不见」的那条客户端规则（形状判据，不是感觉）──────
 *
 * 这里逐字镜像 `dsh-client-ui-chat/lib/client.js` 的两段：
 *   :9267-9297 `messageDefinition.start`：`source.kind !== "user"` → contextMessage
 *   :9251-9261 `contextMessage(...)`：`kind: 'context'`
 *   :7719      `isVisibleChatNode`：排除 `kind === "context"`
 */
const chatNodeKind = (event) => (event.type === 'user/message' && event.data.source.kind !== 'user'
  ? 'context'
  : (event.type === 'user/message' ? 'user' : 'other'));
const isVisibleChatNode = (node) => node.kind !== 'context'
  || (node.content ?? []).some((block) => block.type === 'tool-addition' || block.type === 'tool-removal');

check('投出来的这条在客户端是 `kind:"context"`（不是 `user` 气泡）',
  chatNodeKind({ type: 'user/message', data: captured[0].data }) === 'context');
check('`isVisibleChatNode` 把它排除在对话流之外（所以「上面只有你问我答」仍然成立）',
  isVisibleChatNode({ kind: chatNodeKind({ type: 'user/message', data: captured[0].data }), content: captured[0].data.content }) === false);
check('正对照：普通用户消息（source.kind==="user"）仍然是可见的 —— 断言不是恒真',
  isVisibleChatNode({ kind: chatNodeKind({ type: 'user/message', data: { source: { kind: 'user' }, content: [] } }), content: [] }) === true);

/* ── 4. 和 shipped 源码逐字核对（本机装了 DSH 才做）──────────────────── */

/** 极简 asar 读取：定位一个文件并返回文本；找不到就返回 null。 */
function readFromAsar(asarPath, wanted) {
  if (!fs.existsSync(asarPath)) return null;
  let fd;
  try {
    fd = fs.openSync(asarPath, 'r');
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const dataStart = 8 + head.readUInt32LE(4);
    const jsonLength = head.readUInt32LE(12);
    const jsonBuf = Buffer.alloc(jsonLength);
    fs.readSync(fd, jsonBuf, 0, jsonLength, 16);
    const header = JSON.parse(jsonBuf.toString('utf8'));
    let found = null;
    const walk = (node, prefix) => {
      for (const [name, entry] of Object.entries(node.files ?? {})) {
        const p = `${prefix}/${name}`;
        if (entry.files) walk(entry, p);
        else if (p === wanted) found = entry;
      }
    };
    walk(header, '');
    if (found === null) return null;
    const buf = Buffer.alloc(Number(found.size));
    fs.readSync(fd, buf, 0, buf.length, dataStart + Number(found.offset));
    return buf.toString('utf8');
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

const ASAR = process.env.DSH_APP_ASAR ?? '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar';
const shipped = readFromAsar(ASAR, '/dsh/node_modules/@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js');
if (shipped === null) {
  console.log('SKIP  本机没找到 shipped 的 app.asar —— 跳过「引文逐字核对」（镜像规则仍已生效）');
} else {
  check('shipped 源码里确实有那句 turn/step 校验（引文可核对）',
    shipped.includes('sessionFormatCount(data[field], `developer/message ${field}`)'),
    'dsh-session-format-v3-to-v4/lib/index.js');
  check('shipped 源码里 user/message 不在 STEP_EVENT_TYPES 里（所以没有 turn/step 要求）',
    /const STEP_EVENT_TYPES = new Set\(\[\s*"system\/message",\s*"developer\/message",\s*"assistant\/attempt"/.test(shipped)
    && !/const STEP_EVENT_TYPES = new Set\(\[[^\]]*"user\/message"/.test(shipped));
  check('shipped 源码里确实有「必须 match an open turn and step」的关系表',
    shipped.includes('Match an open turn and step') || shipped.includes('does not match an open turn and step'));
}

/* ── 5. 新的自适应分析格式：有**明确的领先行**，且不强迫三列 ────────── */

check('分析段落有四个固定锚点（具体对话 / 对话概述 / 分析 / 建议）',
  ANALYSIS_SECTIONS.map((s) => s.title).join('|') === '具体对话|对话概述|分析|建议',
  ANALYSIS_SECTIONS.map((s) => s.title).join('|'));
check('分析条目数量不固定（不是 3 个格子的替代品）',
  verdict.analysis.length === 1 && verdict.advice.length === 2);
check('领先行就是 `headline`（master–detail 的左行只读它）',
  ANALYSIS.leadingLine(verdict) === '范围一直在滚大', ANALYSIS.leadingLine(verdict));

console.log(failed === 0 ? `\n全部通过（${passed} 项）` : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
