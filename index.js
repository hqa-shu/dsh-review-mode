/**
 * 冷静审核模式 — 宿主侧复审引擎。
 *
 * 职责：
 *   1. 注册 `reviewMode` 会话投影（客户端状态条读取它）。
 *   2. 在「冷静审核模式」预设的会话里，每一轮收尾（agent/turn-stopping）派一个
 *      **独立子 Agent**（spawn provider，零父上下文）复审这一轮的动作。
 *   3. 复审输入同时包含本机 Codex 桌面版最近的 rollout 动作，所以它监督的不只是
 *      本会话的 Agent，也包括用户在同一个电脑上另外开着的那个 AI。
 *   4. 复审结论通过 agent.inject() 作为「通知」进入会话 —— 不唤醒 Agent、不打断
 *      用户，只在下一次该 Agent 行动时作为上下文可用。
 *
 * 设计约束（来自 Harness 的插件规范）：
 *   - 只从既有会话事件派生状态，不新增事件类型。
 *   - 复审状态由 `agent/inbox/spliced` 折出，所以刷新/重放后仍然一致。
 *   - 只复审顶层会话：子 Agent 继承父预设，必须显式排除，否则会无限套娃。
 *   - **零第三方依赖**：从工作区安装的 bundle，其裸导入不会解析到 dsh 安装目录
 *     里的包，所以这里只用 `node:` 内置模块，schema 也自己实现最小形状校验。
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
// `remote.js` 现在只当**纯读盘函数库**用：命令 handler 复用它的这几个函数。
// 曾经在这里挂的 `ReviewRemote` 远程服务已经删掉（第三方命名空间进不了浏览器固定清单）。
import { buildTargets, currentTarget, lastReviewCard, answerFromTable } from './remote.js';
// 结论形状的**唯一来源**（零依赖模块）：三路的提示词、解析器与客户端都读它。
import {
  LANES,
  LANE_LABELS,
  TARGET_KINDS,
  codexThreadId,
  conversationEvidence,
  evidenceFromEvents,
  listCodex,
  nextReviewEdge,
  readCodex,
  setReviewDispatch,
  setTarget,
} from './reviewer.js';
// 判据与提示词在 `rubric.js` 这**一个**文件里（用户要求「有一套合适的提示词、
// 而且以后能不断加要求」）。要改复审怎么想、写成什么样，只改那个文件。
import {
  ANALYSIS_SECTIONS,
  ANALYSIS_RUBRIC,
  leadingLine,
  parseAnalysis,
  renderAnalysisFormat,
  renderAnalysisText,
  routeAdvice,
} from './rubric.js';

/**
 * 可选 SDK 探针。
 *
 * 背景：这个插件装在**工作区**里，裸导入按普通 Node 规则从**本文件所在目录**解析，
 * 所以默认摸不到 app.asar 里的 `@deepseek-ai/*`。我在插件目录放了一个 `node_modules`
 * 软链指向 asar —— Electron 的 fs 补丁能读 asar，所以这些导入**可能**就通了。
 *
 * 能不能通只有真跑起来才知道，所以这里探测一次并把结果写到文件：重启后直接读
 * `/tmp/dsh-review-sdk.json` 就知道，不用猜、也不用让用户试。
 * 探测失败**不影响任何功能** —— 现在的 schema 是手写且已验证正确的。
 */
const SDK_PROBE = {};
for (const [label, spec] of [
  ['tools', '@deepseek-ai/dsh-tools'],
  ['typert', '@deepseek-ai/dsh-typert-protocol'],
  ['scope', '@deepseek-ai/dsh-scope'],
  ['schemastery', '@deepseek-ai/schemastery'],
  ['zod', 'zod'],
  ['cordis', '@deepseek-ai/cordis'],
]) {
  try {
    const mod = await import(spec);
    SDK_PROBE[label] = { ok: true, exports: Object.keys(mod).slice(0, 14) };
  } catch (error) {
    SDK_PROBE[label] = { ok: false, why: String(error?.message ?? error).slice(0, 120) };
  }
}
// **追加**，不覆盖 —— 之前用覆盖，结果我自己的普通 Node 测试把 Electron 写的真实答案盖掉了。
// 带上 electron 标记，一眼就能分清哪条是真答案。
try {
  fs.appendFileSync('/tmp/dsh-review-sdk.jsonl', `${JSON.stringify({
    at: new Date().toISOString(),
    electron: typeof process.versions.electron === 'string' ? process.versions.electron : null,
    pluginDir: fileURLToPath(new URL('.', import.meta.url)),
    probe: SDK_PROBE,
  })}\n`);
} catch { /* 写不了就算了 */ }

/** 把一行诊断追加到固定文件 —— 现场看不见的时候，这是唯一能查的东西。 */
function trace(line) {
  try { fs.appendFileSync('/tmp/dsh-review-watch.jsonl', `${JSON.stringify({ at: new Date().toISOString(), electron: typeof process.versions.electron === 'string', ...line })}\n`); } catch { /* 写不了就算了 */ }
}

import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

/** 稳定的 Loader 身份。 */
export const name = 'review-mode';

/* ── 版本戳：**正在运行的那份代码**的身份（2026-10-03 现场失败的止血）────────
 *
 * 现场（第三轮）：DSH 进程 **15:39:03** 启动，宿主文件 **16:20–16:26** 才被改。
 * 也就是说用户重启之后跑的仍然是**旧的**那份代码，可屏幕上没有任何东西能告诉他
 * 这件事 —— 他只能一遍遍重启、一遍遍试，然后问「你这个究竟是啥原因啊」。
 *
 * 所以宿主必须能报出**它自己这一份**的身份，而不是「磁盘上现在是什么」：
 *   - `host.mtimeMs` / `hash`：进程**加载这份代码时**读到的文件 mtime 与内容 hash；
 *   - `processStartedAt`：这个 DSH 进程是什么时候起来的；
 *   - `client.mtimeMs` / `hash`：页面那一半（client.js）在磁盘上的版本；
 *   - `host.diskMtimeMs` / `client.diskMtimeMs`：**磁盘现在**的 mtime ——
 *     由监控 tick 顺手刷新（`refreshCodeIdentity`），**ping 自己一个字节都不读盘**
 *     （`test/ping-test.mjs` 用文件系统探针钉死了这条）。
 *
 * 于是面板上能直接写出 `宿主 15:12:03 · 进程 15:39:03`，并且当
 * `diskMtimeMs > mtimeMs + 容差` 时明说「盘上的已经比运行的新 —— 需要重启 DSH」。
 * 这就是那一类「我改了、你重启、还是旧的」困惑的机器判据。
 */
const HOST_FILE = fileURLToPath(import.meta.url);

/**
 * 读一个代码文件的 mtime + 短 hash。
 * @param {string} file - 绝对路径。
 * @returns {{file: string, mtimeMs: number|null, hash: string|null, diskMtimeMs: number|null}} 身份。
 */
function readCodeStamp(file) {
  try {
    const stat = fs.statSync(file);
    const mtimeMs = Math.round(stat.mtimeMs);
    const hash = createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 12);
    return { file, mtimeMs, hash, diskMtimeMs: mtimeMs };
  } catch {
    // 读不到就如实报 null —— 绝不编一个时间。
    return { file, mtimeMs: null, hash: null, diskMtimeMs: null };
  }
}

const CODE_IDENTITY = {
  processStartedAt: Date.now() - Math.round(process.uptime() * 1000),
  loadedAt: Date.now(),
  host: readCodeStamp(HOST_FILE),
  client: readCodeStamp(path.join(path.dirname(HOST_FILE), 'client.js')),
  checkedAt: Date.now(),
};

/**
 * 把「磁盘现在是什么」刷新一遍（**只 statSync，不读内容**）。
 * 调用点在监控 tick 里 —— 见 `test/ping-test.mjs`：ping 必须零文件系统调用。
 * @returns {void}
 */
function refreshCodeIdentity() {
  for (const stamp of [CODE_IDENTITY.host, CODE_IDENTITY.client]) {
    try {
      stamp.diskMtimeMs = Math.round(fs.statSync(stamp.file).mtimeMs);
      CODE_IDENTITY.checkedAt = Date.now();
    } catch { /* 读不到就保留上一次的值 */ }
  }
}

/** 宿主服务依赖：投影注册表、子 Agent 注册表、Agent 注册表。 */
export const inject = ['sessionProjections', 'subagents', 'agents'];

/** 会话投影的键名：客户端状态条读 `projectionValues.reviewMode`。 */
const PROJECTION_KEY = 'reviewMode';

/** 注入消息的 source.kind —— 投影靠它把复审结论折出来。 */
const SOURCE_KIND = 'review-mode';

/**
 * 把任意值规范成非负整数。
 * @param {unknown} value - 候选值。
 * @returns {number} 非负整数。
 */
function toCount(value) {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/**
 * 把任意值规范成字符串数组。
 * @param {unknown} value - 候选值。
 * @returns {string[]} 字符串数组。
 */
function toTextArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === 'string').slice(0, 6);
}

/**
 * 归一化一份（可能来自持久化 checkpoint 的）复审结论。
 * @param {unknown} value - 候选值。
 * @returns {object|null} 归一化后的结论。
 */
function normalizeVerdictRecord(value) {
  if (value === null || typeof value !== 'object') return null;
  const analysis = normalizeAnalysisFields(value);
  return {
    verdict: String(value.verdict ?? 'unknown'),
    lane: LANES.includes(value.lane) ? value.lane : 'me',
    // **形状由 `rubric.js` 的 ANALYSIS_SECTIONS 决定**，跟着结论一起过投影 ——
    // 客户端不自己排段落名，所以宿主与界面的段落永远同一份。
    sections: ANALYSIS_SECTIONS,
    ...analysis,
    forUser: toTextArray(value.forUser),
    forAgent: toTextArray(value.forAgent),
    good: toTextArray(value.good),
    noise: toTextArray(value.noise),
    constraints: toTextArray(value.constraints),
    codexObs: toTextArray(value.codexObs),
    nextCheck: String(value.nextCheck ?? ''),
    rerouted: toCount(value.rerouted),
    untagged: toCount(value.untagged),
    openIssues: normalizeIssueItems(value.openIssues),
    resolvedIssues: toTextArray(value.resolvedIssues),
    turn: toCount(value.turn),
    at: toCount(value.at),
    digestChars: toCount(value.digestChars),
    dropped: toTextArray(value.dropped),
    raw: String(value.raw ?? ''),
  };
}

/** 台账里最多同时追踪几条未结问题。 */
const ISSUES_KEEP = 4;
/** 轨迹最多保留多少段（游程压缩后，一段可覆盖很多轮）。 */
const TRAJECTORY_KEEP = 8;
/** 最近已解决的最多保留条数。 */
const RESOLVED_KEEP = 2;
/** 实时条目流最多保留多少条。 */
// 用户要求「只增不改」：条目**只追加**，永远不重写、不替换；这是一条**有界**环形缓冲，
// 超过上限只丢最旧的那条（60 条 × 每条约 1~2KB，checkpoint 不会失控）。
const FEED_KEEP = 60;

/**
 * 归一化一条实时条目。
 *
 * 这是「不要报告、要实时更新」的载体：每次复审只往流里追加**几行短句**，
 * 侧边浮层照着渲染。它必须短 —— 用户要一眼看懂，不是读文档。
 */
function normalizeFeedEntry(value) {
  if (value === null || typeof value !== 'object') return null;
  const analysis = normalizeAnalysisFields(value);
  return {
    at: toCount(value.at),
    turn: toCount(value.turn),
    // `review` = 自动生成的评价；`qa` = 针对某条评价的问答。同一个流，两种条目。
    kind: value.kind === 'qa' ? 'qa' : 'review',
    verdict: String(value.verdict ?? 'unknown'),
    lane: LANES.includes(value.lane) ? value.lane : 'me',
    question: shorten(String(value.question ?? ''), 200),
    sections: ANALYSIS_SECTIONS,
    ...analysis,
    text: shorten(String(value.text ?? leadingLine(analysis)), 200),
    cost: toCount(value.cost),
  };
}

/**
 * 只保留 `rubric.js` 键出的字段，防止投影状态里长出模型自创的段落。
 *
 * 这就是「形状由代码保证、不由模型的排版保证」：模型多写一段、漏写一段，
 * 归一化结果仍然是那四个锚点，缺的就留空。
 * @param {unknown} value - 候选值。
 * @returns {object} `{headline, dialog, summary, analysis, advice}`。
 */
function normalizeAnalysisFields(value) {
  const source = value !== null && typeof value === 'object' ? value : {};
  return {
    headline: shorten(String(source.headline ?? ''), 80),
    dialog: toTextArray(source.dialog).map((item) => shorten(item, 200)),
    summary: shorten(String(source.summary ?? ''), 400),
    analysis: toTextArray(source.analysis).map((item) => shorten(item, 300)),
    advice: toTextArray(source.advice).map((item) => shorten(item, 300)),
  };
}

/**
 * 归一化一条「针对评价的提问」的回答。
 *
 * 用户的原话：「点进去问答，我是针对你的评价问答……话旁左边有一个对话框，我可以问相关的内容」。
 * 它和自动评价进同一个流，但 `kind: 'qa'` 让它**一眼可分辨**。
 * @param {unknown} value - 候选值。
 * @returns {object|null} 条目，或 null。
 */
function normalizeQaEntry(value) {
  if (value === null || typeof value !== 'object') return null;
  const question = String(value.question ?? '').trim();
  const answer = String(value.answer ?? '').trim();
  if (question.length === 0 && answer.length === 0) return null;
  return {
    at: Date.now(),
    turn: toCount(value.turn),
    kind: 'qa',
    verdict: 'unknown',
    lane: LANES.includes(value.lane) ? value.lane : 'me',
    question: shorten(question, 200),
    text: shorten(answer, 300),
    sections: ANALYSIS_SECTIONS,
    headline: shorten(answer, 80),
    dialog: [], summary: '', analysis: [], advice: [],
    cost: 0,
  };
}

/**
 * 归一化复审员报出的一条问题。
 * @param {unknown} value - 候选值。
 * @returns {{text: string, carried: boolean, side: string}|null} 问题条目。
 */
function normalizeIssueItem(value) {
  if (value === null || typeof value !== 'object') return null;
  // 两端各剥一次：解析时剥一次，折叠时再剥一次。实测模型会把展示用的计数前缀
  // 抄进自己的输出，只在一处剥会漏。
  const text = stripCounterPrefix(String(value.text ?? ''));
  if (text.length === 0) return null;
  // 每条问题是一句「标签」，不是一段分析。不限长会让 4 条就撑爆记忆段并触发截断。
  return { text, carried: value.carried === true, side: value.side === 'codex' ? 'codex' : 'self' };
}

/**
 * 归一化问题清单。
 * @param {unknown} value - 候选值。
 * @returns {object[]} 问题条目。
 */
function normalizeIssueItems(value) {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeIssueItem).filter((item) => item !== null);
}

/**
 * 一条问题的匹配键：折叠空白后取前 30 个字符。
 *
 * 复审员每一轮都会重写措辞，所以不能要求逐字相同；前缀匹配足够稳定，
 * 又比模糊相似度便宜、可预测。
 * @param {string} text - 问题文本。
 * @returns {string} 匹配键。
 */
function issueKey(text) {
  return String(text ?? '')
    .replace(/^(?:【[^】]*】|\[[^\]]*\])\s*/g, '')  // 去掉被抄进来的计数前缀
    .replace(/\s+/g, '')
    .slice(0, 30);
}

/**
 * 把任意值归一化成投影状态。
 * @param {unknown} value - 候选值。
 * @returns {object} 投影状态。
 */
function normalizeState(value) {
  const source = value !== null && typeof value === 'object' ? value : {};
  const feed = Array.isArray(source.feed) ? source.feed : [];
  const trajectory = Array.isArray(source.trajectory) ? source.trajectory : [];
  const issues = Array.isArray(source.issues) ? source.issues : [];
  const resolved = Array.isArray(source.resolved) ? source.resolved : [];
  return {
    turn: toCount(source.turn),
    toolCalls: toCount(source.toolCalls),
    totalToolCalls: toCount(source.totalToolCalls),
    turnStartSeq: toCount(source.turnStartSeq),
    reviews: toCount(source.reviews),
    feed: feed.map(normalizeFeedEntry).filter((entry) => entry !== null).slice(-FEED_KEEP),
    trajectory: trajectory.map(normalizeTrajectorySegment).filter((seg) => seg !== null).slice(-TRAJECTORY_KEEP),
    issues: issues.map(normalizeTrackedIssue).filter((item) => item !== null).slice(-ISSUES_KEEP),
    resolved: resolved.map(normalizeResolvedIssue).filter((item) => item !== null).slice(-RESOLVED_KEEP),
    last: normalizeVerdictRecord(source.last),
    // 流式复审的**半成品**：复审员还在写的时候，面板就靠它一段一段长出来。
    // 最终结论落进 feed 时会被清掉（见 foldReviewIntoState），不会和完成品并存。
    stream: normalizeStream(source.stream),
    // 「正在跑」「跑失败了」也进投影 —— 面板据此把空状态、进行中、失败分开，
    // 不会再出现「审核中…」永久挂在空状态上、而答案在别处的现场失败。
    pending: normalizePending(source.pending),
    failure: normalizeFailure(source.failure),
  };
}

/**
 * 归一化一个流式半成品：形状**永远**由常量键出，模型/帧里缺什么就留空。
 * @param {unknown} value - 候选值。
 * @returns {object|null} 半成品状态，或 null。
 */
function normalizeStream(value) {
  if (value === null || typeof value !== 'object') return null;
  if (value.streaming !== true) return null;
  const analysis = normalizeAnalysisFields(value);
  return {
    lane: LANES.includes(value.lane) ? value.lane : 'me',
    verdict: String(value.verdict ?? 'unknown'),
    sections: ANALYSIS_SECTIONS,
    ...analysis,
    at: Date.now(),
  };
}

/**
 * 归一化「复审进行中」标记。
 *
 * 为什么需要它（用户现场）：面板是从投影渲染的，而投影里只有「有没有评价」。
 * 复审在跑的那几十秒里，面板和「什么都没发生」长得一模一样，于是
 * 「审核中…」被永久挂在空状态上，而结论其实在别处。有了 `pending`，
 * 面板就能把**真空**、**进行中**、**失败**、**有结果**分成四句话。
 * @param {unknown} value - 候选值。
 * @returns {object|null} `{lane,label,at}` 或 null。
 */
function normalizePending(value) {
  if (value === null || typeof value !== 'object') return null;
  return {
    lane: LANES.includes(value.lane) ? value.lane : 'me',
    label: shorten(String(value.label ?? ''), 80),
    at: toCount(value.at),
  };
}

/**
 * 归一化「复审失败」标记 —— 面板据此说出真因，而不是继续显示空状态。
 * @param {unknown} value - 候选值。
 * @returns {object|null} `{lane,label,message,at}` 或 null。
 */
function normalizeFailure(value) {
  if (value === null || typeof value !== 'object') return null;
  const message = String(value.message ?? '').trim();
  if (message.length === 0) return null;
  return {
    lane: LANES.includes(value.lane) ? value.lane : 'me',
    label: shorten(String(value.label ?? ''), 80),
    message: shorten(message, 200),
    at: toCount(value.at),
  };
}

/**
 * 归一化一段轨迹（连续同结论的轮次区间）。
 * @param {unknown} value - 候选值。
 * @returns {object|null} 轨迹段。
 */
function normalizeTrajectorySegment(value) {
  if (value === null || typeof value !== 'object') return null;
  return { from: toCount(value.from), to: toCount(value.to), verdict: String(value.verdict ?? 'unknown') };
}

/**
 * 归一化一条被追踪的问题（带「从第几轮起」和「出现几次」）。
 * @param {unknown} value - 候选值。
 * @returns {object|null} 追踪中的问题。
 */
function normalizeTrackedIssue(value) {
  const base = normalizeIssueItem(value);
  if (base === null) return null;
  return { ...base, sinceTurn: toCount(value.sinceTurn), rounds: Math.max(1, toCount(value.rounds)) };
}

/**
 * 归一化一条已解决的记录。
 * @param {unknown} value - 候选值。
 * @returns {object|null} 已解决条目。
 */
function normalizeResolvedIssue(value) {
  if (value === null || typeof value !== 'object') return null;
  const text = String(value.text ?? '').trim();
  if (text.length === 0) return null;
  return { text, atTurn: toCount(value.atTurn) };
}

/**
 * 会话投影的状态 schema。
 *
 * 投影注册表只对 schema 调用 `.parse()`，而这里本来就不需要类型系统：`normalizeState`
 * 已经保证了完整形状，所以省掉一个第三方 schema 依赖。
 */
const reviewStateSchema = {
  parse: (value) => normalizeState(value),
};

/** 允许的结论取值。 */
const VERDICTS = new Set(['on-track', 'drifting', 'off-track', 'unknown']);

/**
 * 校验并补齐配置。
 * @param {object} config - Loader 传来的原始配置。
 * @returns {object} 已规范化的配置。
 */
function resolveConfig(config) {
  const raw = config ?? {};
  const positive = (value, fallback) =>
    Number.isFinite(value) && value > 0 ? value : fallback;
  const count = (value, fallback, min) =>
    Number.isSafeInteger(value) && value >= min ? value : fallback;
  return {
    preset: typeof raw.preset === 'string' && raw.preset.length > 0 ? raw.preset : 'review',
    minToolCalls: count(raw.minToolCalls, 1, 1),
    provider: typeof raw.provider === 'string' && raw.provider.length > 0 ? raw.provider : 'spawn',
    reviewTimeoutMs: positive(raw.reviewTimeoutMs, 180000),
    eventScanLimit: count(raw.eventScanLimit, 4000, 20),
    codex: raw.codex !== false,
    codexWindowHours: positive(raw.codexWindowHours, 12),
    codexFiles: count(raw.codexFiles, 2, 1),
    codexTailBytes: count(raw.codexTailBytes, 524288, 8192),
    /**
     * 交给复审员的证据总量上限（字符）。
     *
     * 这是「省 token」的主旋钮。普通一轮的 digest 只有 2~3K 字符，远到不了上限；
     * 上限只在异常大的一轮（比如 100+ 次工具调用）上生效，那时它保证成本不失控，
     * 同时把最低优先级的段落整段丢掉、并在结尾说明丢了什么。
     */
    digestBudgetChars: count(raw.digestBudgetChars, 7000, 1500),
    /** 是否自动盯 Codex（你在那边干活，这边定时审一次）。 */
    watchCodex: raw.watchCodex !== false,
    /** 多久看一次「有没有新的用户消息」。这是**便宜的检测**，不是复审节奏。 */
    watchIntervalMs: count(raw.watchIntervalMs, 5000, 1000),
  };
}

/**
 * 截断一段文本，保留尾部。
 * @param {string} text - 原文。
 * @param {number} limit - 上限字符数。
 * @returns {string} 截断后的文本。
 */
function clip(text, limit) {
  const value = typeof text === 'string' ? text : String(text ?? '');
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}…(+${value.length - limit} 字符)`;
}

/**
 * 把多行文本压成一行，便于放进 bullet 列表。
 * @param {string} text - 原文。
 * @returns {string} 单行文本。
 */
function oneLine(text) {
  return (typeof text === 'string' ? text : String(text ?? ''))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 取出内容块里的文本。
 *
 * 兼容三种写法：Harness 的 `text`、Codex Responses 的 `input_text` / `output_text`、
 * 以及 Codex 事件流里的大写 `Text`。所以判据是「类型名以 text 结尾」而不是相等。
 * @param {unknown} blocks - 内容块数组。
 * @returns {string} 拼接后的文本。
 */
function contentText(blocks) {
  if (!Array.isArray(blocks)) return '';
  const parts = [];
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue;
    if (typeof block.text !== 'string') continue;
    if (!String(block.type).toLowerCase().endsWith('text')) continue;
    parts.push(block.text);
  }
  return parts.join('\n').trim();
}

/**
 * 把错误渲染成一行诊断。
 * @param {unknown} error - 抛出的值。
 * @returns {string} 诊断文本。
 */
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 把命令字段渲染成可读文本。
 * @param {unknown} command - Codex 的 `command` 字段（数组或字符串）。
 * @returns {string} 命令行文本。
 */
function commandText(command) {
  if (Array.isArray(command)) return command.map((part) => String(part)).join(' ');
  if (command === null || command === undefined) return '';
  return String(command);
}

/* ------------------------------------------------------------------ *
 * 会话 digest
 * ------------------------------------------------------------------ */

/**
 * 读取会话尾部事件。任何失败都降级为空，绝不让复审本身打断会话。
 * @param {object} session - 目标会话。
 * @param {number} limit - 回读的事件条数。
 * @returns {readonly object[]} 事件数组。
 */
function tailEvents(session, limit, fromSeq) {
  try {
    const end = Number(session.seq);
    if (!Number.isFinite(end)) return [];
    // 从这一轮的起点开始扫（而不是固定回退 N 条）。实测第 1 轮跨 751 条事件，
    // 而窗口只有 400 条，导致开头的 3 次工具失败被静默丢掉、报告成「没有失败」。
    const floor = Number.isFinite(fromSeq) && fromSeq > 0 ? fromSeq : 0;
    const from = Math.max(0, Math.max(floor, end - limit));
    const events = session.snapshotEvents(from, end);
    return Array.isArray(events) ? events : [];
  } catch {
    return [];
  }
}

/**
 * 把 JSON 字符串字面量里的转义还原成可读的一行文本。
 * @param {string} value - JSON 里的字符串内容。
 * @returns {string} 单行文本。
 */
function unescapeJsonString(value) {
  return value
    .replace(/\\n/g, ' ')
    .replace(/\\r/g, ' ')
    .replace(/\\t/g, ' ')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

/**
 * 从一段（可能被截断的）JSON 参数文本里取出一个字符串字段。
 *
 * 先试 `JSON.parse`；参数会被截断，所以解析失败是常态，这时退回正则。
 * 正因为有这条兜底，才不需要为了「能解析」而把整段参数都留着。
 * @param {string} raw - 工具参数原文。
 * @param {readonly string[]} keys - 候选字段名，按优先级排列。
 * @returns {string} 字段值；取不到时为空串。
 */
function argField(raw, keys) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object') {
      for (const key of keys) {
        const value = parsed[key];
        if (typeof value === 'string' && value.length > 0) return value;
      }
    }
  } catch {
    /* 截断的 JSON 交给下面的正则。 */
  }
  for (const key of keys) {
    const matched = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(raw);
    if (matched !== null && matched[1].length > 0) return unescapeJsonString(matched[1]);
  }
  return '';
}

/** 文件路径类工具参数里，路径可能出现的字段名。 */
const PATH_FIELDS = ['file_path', 'filePath', 'path', 'notebook_path'];
/** 命令类工具参数里，命令可能出现的字段名。 */
const COMMAND_FIELDS = ['command', 'cmd', 'script'];
/** 检索类工具参数里，被检索对象的字段名。 */
const SEARCH_FIELDS = ['pattern', 'query', 'url', 'file_path'];
/** 会改写工作区的工具。 */
const MUTATING_TOOLS = new Set(['write', 'edit', 'notebook_edit', 'multi_edit', 'apply_patch']);
/** 会执行命令的工具。 */
const SHELL_TOOLS = new Set(['bash', 'pwsh', 'shell', 'run_code']);
/**
 * 结果值得记一行摘要的工具：命令**和检索**。
 *
 * 早先只收命令，于是「概要说 grep×4、正文写『没有执行命令』」自相矛盾 ——
 * 而且同一条 grep 反复跑这件事在证据里完全看不见。检索的结果摘要正是判重复所需。
 */
const OUTCOME_TOOLS = new Set([...SHELL_TOOLS, 'grep', 'glob', 'web_search', 'web_fetch']);

/** 命令文本里出现写入/改名的迹象。 */
const SHELL_WRITE_HINT = /sed\s+-i|\btee\b|\bcp\b|\bmv\b|\brm\b|\bmkdir\b|\btouch\b|\bchmod\b|\btruncate\b|(?:^|[^>])>{1,2}\s*\S/;

/**
 * 去重后保留末尾若干条（最近的优先）。
 * @param {string[]} items - 候选条目。
 * @param {number} keep - 最多保留条数。
 * @returns {string[]} 去重后的尾部。
 */
function dedupeTail(items, keep) {
  return [...new Set(items)].slice(-keep);
}

/**
 * 从会话事件里抽出这一轮的判决材料。
 *
 * 核心原则是**计数代替罗列**。一轮里 40 次 `read` 对「有没有走偏」几乎没有信息量，
 * 但「改了哪几个文件、跑了哪些命令、哪几次失败了」差不多就是全部证据。所以除改写
 * 和命令以外的工具调用只做聚合计数，一行带过，不进提示词的正文。
 * @param {object} agent - 主 Agent。
 * @param {number} turn - 正在收尾的轮次。
 * @param {number} limit - 回读的事件条数。
 * @param {object} progress - 会话累计进度（来自 reviewMode 投影）。
 * @returns {object} digest。
 */
function buildSessionDigest(agent, turn, limit, progress) {
  const events = tailEvents(agent.session, limit, progress?.turnStartSeq);
  const counts = new Map();
  const names = new Map();
  const changes = [];
  const shellCalls = [];
  const outcomes = new Map();
  const failures = [];
  const claims = [];
  let toolCalls = 0;
  for (const event of events) {
    if (event?.type === 'tool/call' && event.data?.turn === turn) {
      const name = String(event.data.name ?? '?');
      const raw = String(event.data.arguments ?? '');
      toolCalls += 1;
      counts.set(name, (counts.get(name) ?? 0) + 1);
      if (event.data.callId !== undefined) names.set(String(event.data.callId), name);
      if (MUTATING_TOOLS.has(name)) {
        const target = argField(raw, PATH_FIELDS);
        if (target.length > 0) changes.push(`${name} → ${target}`);
      } else if (OUTCOME_TOOLS.has(name)) {
        const isShell = SHELL_TOOLS.has(name);
        const detail = argField(raw, isShell ? COMMAND_FIELDS : SEARCH_FIELDS);
        const label = detail.length > 0 ? `${isShell ? '' : `${name} `}${oneLine(detail)}` : name;
        shellCalls.push({ callId: String(event.data.callId ?? ''), command: clip(label, 120) });
      }
      continue;
    }
    if (event?.type === 'tool/result' && event.data?.turn === turn) {
      const failed = event.data.message?.isError === true || event.data.error !== undefined;
      if (!failed) {
        // 记下这条命令的**一行结果**。没有它，复审员分不清「代理没验证」和
        // 「验证了但证据里看不到输出」—— 实测这会直接在干净的轮次上制造误报。
        const id = String(event.data.message?.toolCallId ?? '');
        if (names.has(id)) {
          const line = oneLine(contentText(event.data.message?.content));
          outcomes.set(id, clip(line, 80));
        }
        continue;
      }
      const owner = names.get(String(event.data.message?.toolCallId ?? '')) ?? '?';
      const code = event.data.error?.code ?? event.data.error?.name ?? 'ERROR';
      const reason = event.data.error?.reason ?? '';
      failures.push(clip(`${owner} 失败（${code}）${reason.length > 0 ? `：${oneLine(reason)}` : ''}`, 220));
      continue;
    }
    if (event?.type === 'assistant/message' && event.data?.turn === turn) {
      const text = contentText(event.data.message?.content);
      if (text.length > 0) claims.push(clip(oneLine(text), 700));
    }
  }
  const byName = [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([toolName, count]) => `${toolName}×${count}`);
  // 用 shell 写的文件不会以 write/edit 出现。不单独拎出来，摘要就会断言
  // 「这一轮没有改写任何文件」而证据里明明有 sed -i / cat > —— 这是实测抓到的假陈述。
  // 命令/检索按「命令文本」分组折叠，但**标明次数**：把同一条命令跑 4 次压成一行会
  // 把「重复无效动作」这个要审的东西藏起来（实测因此漏报过一次）。
  const grouped = new Map();
  for (const call of shellCalls) {
    const outcome = outcomes.get(call.callId) ?? '';
    const entry = grouped.get(call.command) ?? { command: call.command, outcomes: [], count: 0 };
    entry.count += 1;
    if (entry.outcomes.length < 3) entry.outcomes.push(outcome);
    grouped.set(call.command, entry);
  }
  const commands = [...grouped.values()].slice(-10).map((entry) => {
    const first = entry.outcomes[0] ?? '';
    const shown = first.length > 0 ? first : '（证据里没有这条命令的输出）';
    const same = entry.outcomes.every((item) => item === first);
    if (entry.count > 1 && same) return `${entry.command} → ${shown}【重复 ${entry.count} 次，结果相同】`;
    if (entry.count > 1) return `${entry.command} → 重复 ${entry.count} 次，结果不一致`;
    return `${entry.command} → ${shown}`;
  });
  const shellWrites = dedupeTail(commands.filter((cmd) => SHELL_WRITE_HINT.test(cmd)), 6);
  return {
    objective: findObjective(events),
    origin: findFirstAsk(agent.session),
    progress,
    cwd: typeof agent.session.header?.cwd === 'string' ? agent.session.header.cwd : '',
    toolCalls,
    byName,
    changes: dedupeTail(changes, 14),
    shellWrites,
    commands: dedupeTail(commands, 10),
    failures: dedupeTail(failures, 8),
    claims: claims.slice(-2),
  };
}

/**
 * 找出用户最近一次真正提出的要求。
 * @param {readonly object[]} events - 会话事件。
 * @returns {string} 目标文本，找不到时为空串。
 */
function findObjective(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== 'user/message') continue;
    if (event.data?.source?.kind !== 'user') continue;
    const text = contentText(event.data?.content);
    if (text.length > 0) return clip(text, 900);
  }
  return '';
}

/**
 * 找出这个会话**最早**那次真正的用户指令。
 *
 * 判断「有没有越走越远」需要一个基准，而基准是最初那句话，不是最近那句。
 * 只读会话开头很少的几条事件，所以很便宜。
 * @param {object} session - 目标会话。
 * @returns {string} 最初的指令，找不到时为空串。
 */
function findFirstAsk(session) {
  try {
    const events = session.snapshotEvents(0, Math.min(Number(session.seq), 80));
    if (!Array.isArray(events)) return '';
    for (const event of events) {
      if (event?.type !== 'user/message') continue;
      if (event.data?.source?.kind !== 'user') continue;
      const text = contentText(event.data?.content);
      if (text.length > 0) return clip(oneLine(text), 500);
    }
  } catch {
    /* 读不到开头就算了，不是致命信息。 */
  }
  return '';
}

/* ------------------------------------------------------------------ *
 * Codex digest（本机 ChatGPT 桌面版 / Codex 的 rollout 记录）
 * ------------------------------------------------------------------ */

/**
 * 递归收集 JSONL rollout 文件。
 * @param {string} root - 起始目录。
 * @param {object[]} out - 收集结果。
 * @param {number} cap - 最多收集多少个文件。
 */
function collectRollouts(root, out, cap) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= cap) return;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      collectRollouts(full, out, cap);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    try {
      const info = fs.statSync(full);
      out.push({ file: full, mtime: info.mtimeMs, size: info.size });
    } catch {
      /* 单个文件读不到就跳过。 */
    }
  }
}

/**
 * 回读文件尾部并切行（丢掉被截断的首行）。
 * @param {string} file - 文件路径。
 * @param {number} maxBytes - 最多回读字节数。
 * @returns {string[]} 行数组。
 */
function readTailLines(file, maxBytes) {
  const handle = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(handle).size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    fs.readSync(handle, buffer, 0, length, start);
    let text = buffer.toString('utf8');
    if (start > 0) {
      const firstBreak = text.indexOf('\n');
      if (firstBreak >= 0) text = text.slice(firstBreak + 1);
    }
    return text.split('\n').filter((line) => line.trim().length > 0);
  } finally {
    fs.closeSync(handle);
  }
}

/**
 * 读取 rollout 的第一行（`session_meta`）。工作目录只出现在文件开头，
 * 而活动摘要在文件尾部，所以这两头都要读。
 *
 * 第一行可能非常大（`session_meta` 里带着完整的 base instructions），所以先按
 * 较大的缓冲读，JSON 解析失败时退回正则抽取 —— 反正只需要一个 `cwd`。
 * @param {string} file - rollout 文件路径。
 * @returns {string} Codex 的工作目录，读不到时为空串。
 */
function readRolloutCwd(file) {
  const HEAD_BYTES = 524288;
  let handle;
  let text = '';
  try {
    handle = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(HEAD_BYTES);
    const read = fs.readSync(handle, buffer, 0, buffer.length, 0);
    text = buffer.subarray(0, read).toString('utf8');
  } catch {
    return '';
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
  const firstBreak = text.indexOf('\n');
  const line = firstBreak >= 0 ? text.slice(0, firstBreak) : text;
  try {
    const record = JSON.parse(line);
    if (record?.type === 'session_meta' && typeof record.payload?.cwd === 'string') {
      return record.payload.cwd;
    }
  } catch {
    /* 第一行被截断是常态，退回正则。 */
  }
  const matched = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(line);
  return matched === null ? '' : matched[1];
}

/**
 * Codex rollout 里以 `user` 角色出现、但其实是应用自己注入的东西。
 *
 * 桌面版会把环境信息、历史回放、以及压缩后的 transcript 塞成 user 消息，
 * 直接当成「用户说的话」会毁掉复审判断。这里按开头特征把它们排掉。
 */
const CODEX_INJECTED_PREFIXES = [
  '<environment_context',
  '<external_codex_apps',
  '<user_instructions',
  '<plugin',
  '>>> RETAINED USER INSTRUCTIONS',
  '>>> TRANSCRIPT',
  'Host notice:',
  'Retained source order:',
  'The following is the Codex agent history',
];

/**
 * 判断一段 user 文本是不是应用注入而非用户真正打的字。
 * @param {string} text - 单行化之前的原文。
 * @returns {boolean} 是否应当丢弃。
 */
function isCodexInjectedText(text) {
  const head = text.trimStart();
  if (head.startsWith('[') && /^\[\d+\]\s+(user|assistant):/.test(head)) return true;
  return CODEX_INJECTED_PREFIXES.some((prefix) => head.startsWith(prefix));
}

/**
 * 解析一个 Codex rollout，抽出「它干了什么」以及「用户对它说了什么」。
 * @param {{file: string, mtime: number}} entry - 文件与修改时间。
 * @param {number} tailBytes - 最多回读字节数。
 * @returns {object|null} 活动摘要；没有可读活动时返回 null。
 */
function readRollout(entry, tailBytes) {
  let lines;
  try {
    lines = readTailLines(entry.file, tailBytes);
  } catch {
    return null;
  }
  const activity = {
    file: path.basename(entry.file),
    mtime: entry.mtime,
    cwd: '',
    asks: [],
    commands: [],
    notes: [],
    failures: [],
    exec: [],
  };
  for (const line of lines) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = record?.payload;
    if (record?.type === 'session_meta') {
      if (typeof payload?.cwd === 'string') activity.cwd = payload.cwd;
      continue;
    }
    if (record?.type === 'response_item') {
      if (payload?.type === 'custom_tool_call') {
        const text = oneLine(String(payload.input ?? ''));
        if (text.length > 0) activity.exec.push(clip(text, 300));
      } else if (payload?.type === 'message' && payload.role === 'user') {
        // 用户真正打给 Codex 的字 —— 复审的第一半材料。
        const raw = contentText(payload.content);
        if (raw.length > 0 && !isCodexInjectedText(raw)) {
          activity.asks.push(clip(oneLine(raw), 320));
        }
      }
      continue;
    }
    if (record?.type === 'event_msg') {
      const item = payload?.item;
      if (item === null || typeof item !== 'object') continue;
      if (item.type === 'CommandExecution') {
        const text = oneLine(commandText(item.command));
        if (text.length > 0) activity.commands.push(clip(text, 240));
      } else if (item.type === 'AgentMessage') {
        const text = oneLine(contentText(item.content));
        if (text.length > 0) activity.notes.push(clip(text, 400));
      } else if (item.type === 'McpToolCall') {
        const failed = item.status === 'failed' || item.result?.isError === true;
        if (failed) {
          const detail = oneLine(contentText(item.result?.content)) || 'failed';
          activity.failures.push(clip(`${item.server ?? '?'}/${item.tool ?? '?'}: ${detail}`, 220));
        }
      }
    }
  }
  const empty =
    activity.asks.length === 0 &&
    activity.commands.length === 0 &&
    activity.notes.length === 0 &&
    activity.exec.length === 0;
  if (empty) return null;
  if (activity.cwd.length === 0) activity.cwd = readRolloutCwd(entry.file);
  activity.asks = activity.asks.slice(-8);
  activity.commands = activity.commands.slice(-10);
  activity.notes = activity.notes.slice(-4);
  activity.failures = activity.failures.slice(-6);
  activity.exec = activity.exec.slice(-6);
  return activity;
}

/**
 * 汇总本机 Codex 最近的动作。
 * @param {object} cfg - 已规范化的配置。
 * @returns {{available: boolean, note: string, sessions: object[]}} Codex digest。
 */
function buildCodexDigest(cfg) {
  const empty = { available: false, note: '', asks: [], commands: [], exec: [], failures: [], notes: [], sources: [] };
  if (!cfg.codex) return { ...empty, note: '复审配置里关闭了 Codex 监督。' };
  const home = os.homedir();
  if (home.length === 0) return { ...empty, note: '无法确定用户主目录。' };
  const files = [];
  collectRollouts(path.join(home, '.codex', 'sessions'), files, 800);
  collectRollouts(path.join(home, '.codex', 'archived_sessions'), files, 800);
  if (files.length === 0) {
    return { ...empty, note: `没有在 ${path.join(home, '.codex')} 下找到 Codex 的 rollout 记录。` };
  }
  const cutoff = Date.now() - cfg.codexWindowHours * 3600 * 1000;
  let chosen = files
    .filter((entry) => entry.mtime >= cutoff)
    .sort((left, right) => right.mtime - left.mtime)
    .slice(0, cfg.codexFiles);
  if (chosen.length === 0) {
    chosen = files.sort((left, right) => right.mtime - left.mtime).slice(0, 1);
  }
  // 多个 rollout **合并**成一组列表，而不是每个文件各写一遍标题和五份清单 ——
  // 否则预算会花在重复的栏目名上，而不是花在内容上。
  const merged = { available: false, note: '', asks: [], commands: [], exec: [], failures: [], notes: [], sources: [] };
  for (const entry of chosen) {
    const activity = readRollout(entry, cfg.codexTailBytes);
    if (activity === null) continue;
    merged.asks.push(...activity.asks);
    merged.commands.push(...activity.commands);
    merged.exec.push(...activity.exec);
    merged.failures.push(...activity.failures);
    merged.notes.push(...activity.notes);
    merged.sources.push(
      `${activity.file.slice(0, 28)}… @ ${new Date(activity.mtime).toISOString().slice(5, 16)}${activity.cwd.length > 0 ? ` · ${activity.cwd}` : ''}`,
    );
  }
  if (merged.sources.length === 0) {
    return { ...empty, note: '找到了 Codex 的 rollout 文件，但没解析出可读动作。' };
  }
  merged.available = true;
  merged.asks = dedupeTail(merged.asks, 8);
  merged.commands = dedupeTail(merged.commands, 12);
  merged.exec = dedupeTail(merged.exec, 6);
  merged.failures = dedupeTail(merged.failures, 8);
  merged.notes = dedupeTail(merged.notes, 4);
  return merged;
}

/* ------------------------------------------------------------------ *
 * 复审提示词与结论解析
 * ------------------------------------------------------------------ */

/**
/**
 * 按优先级把若干段落塞进一个字符预算里。
 *
 * 这是「省 token 同时不丢判断」的核心机制。段落按重要性从高到低排列，每段自己
 * 已经有条数上限；总预算耗尽时丢掉的是**最低优先级**的段落，而不是把某段从中间
 * 截断（截断会让复审员看到半句话，比看不到更糟）。
 *
 * 被丢掉的段落会列在结尾。这一点是必需的：否则复审员会把「没提供」读成「没发生」，
 * 从而给出一个虚假的「一切正常」。
 * @param {{title: string, body: string}[]} sections - 已按优先级排好的段落。
 * @param {number} budget - 总字符预算。
 * @returns {{body: string, dropped: string[], chars: number}} 组装结果。
 */
function assembleDigest(sections, budget) {
  const kept = [];
  const dropped = [];
  let chars = 0;
  for (const section of sections) {
    let body = section.body.trim();
    if (body.length === 0) continue;
    // 每段先按自己的上限截断。这一步是必需的：实测「执行过的命令」曾长到 2488 字，
    // 把用户点名要的【B】挤出预算。只做总预算、不做分段上限，就会出现这种互相驱逐。
    const cap = section.max ?? 800;
    if (body.length > cap) body = `${body.slice(0, cap)}\n…（本段已截断，省略 ${body.length - cap} 字）`;
    const text = `${section.title}\n${body}`;
    if (chars > 0 && chars + text.length > budget) {
      dropped.push(section.title.replace(/^#+\s*/, ''));
      continue;
    }
    kept.push(text);
    chars += text.length;
  }
  let out = kept.join('\n\n');
  if (dropped.length > 0) {
    out += `\n\n（为了控制长度，这次没有提供这些段落：${dropped.join('、')}。`
      + '看不到不等于没发生 —— 如果判断需要它，就在结论里写 unknown 并说明缺哪一段，不要默认它是正常的。）';
  }
  return { body: out, dropped, chars: out.length };
}

/**
 * 把字符串数组渲染成 bullet 列表。
 * @param {readonly string[]} items - 条目。
 * @returns {string} 列表文本；没有条目时为空串。
 */
function bullets(items) {
  return items.map((item) => `- ${item}`).join('\n');
}

/**
 * 渲染交给独立复审员的完整提示词。
 *
 * 子 Agent 没有父上下文，所以这里必须自足。返回的是对象而不是字符串，因为调用方
 * 需要知道这次到底喂了多少字符 —— 那就等于这次复审的输入成本。
 * @param {object} input - 会话 digest、Codex digest、轮次与预算。
 * @returns {{text: string, digestChars: number, dropped: string[]}} 提示词与用量。
 */
function renderPrompt(input) {
  const { session, codex, turn, budget } = input;

  // ── 固定开头：身份、边界、纪律 ──────────────────────────────
  const head = [
    '你是「冷静审核模式」里的独立复审员。这项工作不是你做的，你不知道主 Agent 的推理过程，',
    '也不需要替它继续干活。你唯一的任务是：只根据下面给出的证据，指出这一轮哪里做对了、哪里是噪声、有没有走偏。',
    '你的结论会分别送给两个人：一个是这个用户，一个是干活的 Agent。所以最后要写两段不同的话。',
    '',
    '硬性要求：',
    '- 只使用下面列出的证据。不要脑补文件内容、不要假设命令成功、不要推测你看不到的上下文。',
    '- 证据不足以判断时，就在结论里写 unknown，并说明缺哪一项证据。不要为了给出结论而编造。',
    '- 下面有些段落可能因为长度限制被省略，结尾会说明省略了什么。省略不等于没有异常。',
    '- 你只负责报告。不要修改任何文件，不要执行任何破坏性命令。',
    '- 【可追溯】你的判断只能建立在下面给出的证据上。不要声称你查过磁盘、目录、配置内容或代码行号 ——',
    '  用户没法从这份复审里核对那些东西。如果你确实自己去读了文件，必须写明「（我自己读的，不在本次证据里）」',
    '  并把确定性降下来。实测最常犯的错，是擅自断言「磁盘上找不到某个文件」「配置里没有某一行」。',
    '- 【照抄计数】引用记忆里的轮次和次数时，把原话带出来，例如「（记忆：第4轮起，已1轮）」，',
    '  不要自己改写或四舍五入。实测出现过把「已1轮」写成「已连续3轮」的情况，那会让用户误判严重程度。',
    '- 【区分「缺陷」和「缺口」】「未结问题」里只放**真实缺陷**：「越约束」「把猜测说成事实」'
      + '「范围失控」「无效重复」「危险操作」「含糊指令」。**「没有 diff / 没有行号 / 没有原始输出」'
      + '这类是本次证据的局限，不是问题，不要写进未结问题** —— 它们会让清单无限膨胀，也会在'
      + '干净的轮次上制造误报。缺口写进「噪声/风险」或「约束核对」里，并标明 unknown。',
    '- 【一个必须当缺陷的例外】「**它宣称做完了/通过了/找到了，而本轮没有任何对应的验证动作**」'
      + '属于「把猜测说成事实」，是**真实缺陷**，不是缺口 —— 不要因为它没有 diff 就降级成 unknown。'
      + '同一条命令反复跑而没有新信息，也是真实缺陷。这两类实测被过度降级过，请特别留意。',
    '- 【干净就说干净】如果这一轮确实找不到真实缺陷，直接给 on-track，并写「未结问题: - 无」。'
      + '在干净的轮次上报出问题，比漏报一个问题的代价更大 —— 这个模式的全部价值建立在「它说有问题就是真有问题」上。',
    '- 【引用它的话必须逐字】要引用主 Agent 对用户说过的话，必须能在证据里逐字找到。'
      + '证据里没有那句话，就不要说它说过。实测出现过凭空指控「它宣称测试通过」而它根本没说过的情况。',
    '- 【不要串台】这个会话的目标是「本会话那个 Agent 的任务」。Codex 是同一台电脑上另一个 AI，',
    '  它自己的任务（它的话题、它的文件夹、它的代码）**不是**这个会话的目标。',
    '  除非是在判断两边有没有碰同一片文件、跑同一条命令，否则不要把 Codex 那边的事写成对用户的建议。',
    '  实测中这一条是重灾区：混在一起时，复审员会开始给用户讲另一个项目的技术问题。',
  ];

  // ── 按优先级排列的证据段落（高 → 低）────────────────────────
  const sections = [];

  // 1. 目标与规模：没有这个就无法判断任何事，永远排第一。
  const scale = [
    `正在收尾的是第 ${turn} 轮。`,
    session.objective.length > 0 ? `用户最近一次的要求：${session.objective}` : '（这个窗口里找不到用户最近的直接指令。）',
    session.origin.length > 0 ? `这个会话最早的要求：${session.origin}` : '',
    session.cwd.length > 0 ? `工作目录：${session.cwd}` : '',
    `这一轮的工具调用共 ${session.toolCalls} 次${session.byName.length > 0 ? `（${session.byName.join('、')}）` : ''}。`,
  ].filter(Boolean);
  sections.push({ title: '## 目标与规模（判断有没有越走越远的基准）', body: scale.join('\n'), max: 600 });

  // 1.5 复审员自己的记忆。
  //
  // 形式是**结构化的**，不是「历次结论的散文」：轨迹做了游程压缩（连续同结论合并成
  // 一段），未结问题是带「从第几轮起 / 已出现几轮」的清单。实测表明散文式台账在 4 轮
  // 就到 701 字、占提示词 11%，而且同一个问题被完整复述 4 遍；换成这个形式后整段
  // 大小与会话长度无关。
  const progress = session.progress ?? { totalToolCalls: 0, reviews: 0, trajectory: [], issues: [], resolved: [] };
  sections.push({ title: '## 你的记忆：轨迹 + 之前提过但没解决的问题', body: renderMemory(progress), max: 700 });

  // 2. 这一轮改了什么：最具体的产出，也最容易看出范围失控。
  // 改写可能同时来自 write/edit 和 shell（sed -i、cat >）。只报前者会漏掉一半，
  // 实测中就出现过「摘要说没有改写任何文件，而证据里有多条真实写入命令」。
  const changeLines = [];
  if (session.changes.length > 0) changeLines.push(bullets(session.changes));
  else changeLines.push('（没有检测到 write / edit 工具调用。）');
  if (session.shellWrites.length > 0) {
    changeLines.push(`${session.changes.length > 0 ? '另外' : '但'}本轮有 ${session.shellWrites.length} 条 shell 命令含写入/改名动作，改动的文件可能也在里面：`);
    changeLines.push(bullets(session.shellWrites));
  }
  sections.push({
    title: '## 这一轮改动的文件',
    body: session.changes.length === 0 && session.shellWrites.length === 0
      ? '（这一轮没有改写任何文件。）'
      : changeLines.join('\n'),
    max: 800,
  });

  // 3. 失败与异常：识破「把猜测说成事实」的最高信号，排得比命令高。
  sections.push({
    max: 700,
    title: '## 这一轮的失败与异常',
    body: session.failures.length > 0
      ? bullets(session.failures)
      : '（这一轮没有记录到工具失败。）',
  });

  // 4. 用户对 Codex 说的原话 —— 用户点名要审的第一半。
  const asksBody = codex.available
    ? (codex.asks.length > 0
      ? `${bullets(codex.asks)}\n（多半是语音输入的，可能有错字或断句问题；判断意图和指令质量，不要挑字面毛病。）`
      : '（没有读到用户对 Codex 的直接指令，可能已被应用压缩掉。）')
    : (codex.note.length > 0 ? codex.note : '（这次没有读到 Codex 的动作。）');
  sections.push({ title: '## 【A】用户对 Codex 说的指令（审它本身有没有问题）', body: asksBody, max: 800 });

  // 5. 这一轮的命令：能看出它到底验了什么。
  sections.push({
    title: '## 这一轮的命令与检索（附一行结果）',
    body: session.commands.length > 0
      ? bullets(session.commands)
      : '（这一轮没有执行命令或检索。）',
    max: 700,
  });

  // 6. Codex 自己的产出 —— 用户点名要审的第二半。
  const codexParts = [];
  if (codex.available) {
    if (codex.sources.length > 0) codexParts.push(`来源：${codex.sources.join(' | ')}`);
    if (codex.failures.length > 0) codexParts.push(`它遇到的工具失败：\n${bullets(codex.failures)}`);
    if (codex.commands.length > 0) codexParts.push(`它执行的命令：\n${bullets(codex.commands)}`);
    if (codex.notes.length > 0) codexParts.push(`它自己给出的说明：\n${bullets(codex.notes)}`);
    if (codex.exec.length > 0) codexParts.push(`它执行的脚本片段：\n${bullets(codex.exec)}`);
  } else {
    codexParts.push(codex.note.length > 0 ? codex.note : '（这次没有读到 Codex 的动作。）');
  }
  sections.push({ title: '## 【B】Codex 自己的产出（审它有没有乱做）', body: codexParts.join('\n\n'), max: 900 });

  // 7. 它最后对用户说的话：用来和上面的证据对照，看有没有夸大。
  sections.push({
    title: '## 这一轮它对用户说的话（拿它和上面的证据对照）',
    body: session.claims.length > 0 ? bullets(session.claims) : '（这一轮它没有对用户说话。）',
    max: 700,
  });

  // ── 组装（低优先级段落可能被预算丢掉）────────────────────────
  const assembled = assembleDigest(sections, budget);

  // ── 固定结尾：清单与输出格式 ────────────────────────────────
  const tail = [
    '## 复审清单',
    '1. 目标对齐：这一轮的动作是否仍然指向用户的要求？和「会话最早的要求」比，有没有悄悄换了目标或把范围滚大？',
    '2. 趋势：和上面「之前几轮的复审结论」比 —— 同一个问题是不是已经提醒过好几次却没改？是在收敛还是在放大？',
    '3. 约束核对：有没有忽略权限、路径、范围、用户明确说过的偏好？有没有把「用户没同意」当成「可以」？',
    '4. 证据质量：它有没有把猜测说成事实、把「应该可以」说成「已经通过」？上面「失败与异常」里的东西有没有被它说成顺利？',
    '5. 无效重复：有没有重复同一个没有新信息的动作？有没有为了动手而动手？',
    '6. 【A】用户给 Codex 的指令本身：够不够具体？有没有说清验收标准？前后是否矛盾？范围是不是越放越大？',
    '   如果用户说得含糊，就直接说清「哪一句、缺什么」，不要客气，但也别指责 —— 用户要的是把话说清楚，不是被评价。',
    '7. 【B】Codex 的产出：它有没有在指令含糊的情况下自己补设定？有没有把没验证的东西说成完成了？有没有踩到约束？',
    '8. 同机冲突：Codex 和本会话有没有在改同一片文件、跑同一条命令、或者得出互相矛盾的结论？',
    '9. 做对的地方：明确指出至少一条可复用的正确判断或有效验证手法，并说明为什么它是对的。',
    '',
    '## 输出格式',
    '严格按下面的格式输出，不要添加别的标题、不要加代码块、不要写前言后语。',
    '注意有两段是写给两个不同读者的。**分给谁不是文体问题，是「谁能真的动手改」**：',
    '  只有用户能决定的 → 给用户，每条**必须**以这几个类别之一开头：',
    '    [指令] 你的指令本身含糊、矛盾、缺验收标准',
    '    [授权] 这件事你还没授权',
    '    [决定] 需要你拍板选一个',
    '    [验收] 你应该去看什么才能确认',
    '  Agent 自己能改的 → 给 Agent，每条**必须**以这几个类别之一开头：',
    '    [证据] 补上缺失的验证或原始输出',
    '    [改动] 具体改哪个文件的哪件事',
    '    [范围] 缩小或停止扩张',
    '    [方法] 换个做法',
    '  类别写错了会被程序改投到正确的一边并记账，所以别猜。',
    '  同机冲突、环境事实这类两方都改不了的内容，写进「约束核对」或「Codex 观察」，不要放进这两段。',
    '  两边不要写重复的内容，也不要互相抄。',
    '',
    '本会话结论: on-track | drifting | off-track | unknown',
    '一句话: <一句话概括这一轮是否合理；如果提到趋势，把记忆里的计数原样带出来，例如「（记忆：第4轮起，已1轮）」>',
    '① 主题漂移: <这一轮有没有偏离用户的目标；偏在哪一步、哪一句话。没问题就写「无明显漂移」>',
    '② 局部纠结: <有没有在一个细节上反复打转；卡在哪、转了几轮、值不值得。没问题就写「无明显纠结」>',
    '③ 选择理性: <取舍是否合理；忽略了什么约束、成本或更简单的路。没问题就写「取舍合理」>',
    '未结问题:',
    '- [持续] <上一轮报过、这一轮你仍然看到证据的**真实缺陷**，一句话，例：界面验收路径仍缺失>',
    ' （没有真实缺陷就写「- 无」。不要把「缺 diff / 缺原始输出 / 无法核对」这类证据缺口写进来。）',
    '- [新] <这一轮新发现的问题>',
    ' （每条只写问题本身，不要带方括号里的轮次计数，也不要把这条规则说明抄进去；尽量不超过 40 字）',
    ' （最多 4 条。规则：你每轮都要把「现在仍然成立」的问题完整重写一遍；',
    '   不再报出来的会被当成「已无证据」而移除。这样它不会一轮轮累积成噪声。）',
    '已解决:',
    '- <之前报过、这一轮你确认已经修好的问题；没有就写「无」>',
    '给用户的话:',
    '- [指令] <你的指令哪里含糊、矛盾或缺验收标准；没有这类就整段写「- 无」>',
    '- [验收] <你应该去看什么才能确认这一轮真的成了>',
    '给 Agent 的话:',
    '- [证据] <它该补上什么验证或原始输出>',
    '- [改动] <它下一步具体改哪个文件的哪件事>',
    '做对的地方:',
    '- <可复用的正确判断或有效验证，说明为什么对>',
    '噪声/风险:',
    '- <无效动作、臆测、被放宽的约束；没有就写「无」>',
    '约束核对:',
    '- <逐条核对已知约束，标明是否被遵守>',
    'Codex 观察:',
    '- <【A】用户指令的问题和【B】Codex 产出的问题；没有就写「无」>',
    '建议: <一个具体动作，能直接照做>',
  ];

  const text = [...head, '', assembled.body, '', ...tail].join('\n');
  return { text, digestChars: assembled.chars, dropped: assembled.dropped };
}

/**
 * 从复审文本里取出一个单行字段。
 * @param {string} text - 复审文本。
 * @param {RegExp} pattern - 带捕获组的匹配式。
 * @returns {string} 字段值，缺失时为空串。
 */
function matchLine(text, pattern) {
  const matched = pattern.exec(text);
  return matched === null ? '' : oneLine(matched[1]);
}

/**
 * 归一化结论取值。
 * @param {string} value - 原文里的结论行。
 * @returns {string} 归一化后的结论。
 */
function normalizeVerdict(value) {
  const lowered = oneLine(value).toLowerCase();
  for (const candidate of VERDICTS) {
    if (lowered.includes(candidate)) return candidate;
  }
  if (/走偏|偏离|失控/.test(lowered)) return 'drifting';
  if (/正常|合理|对齐/.test(lowered)) return 'on-track';
  return 'unknown';
}

/**
 * 输出格式里的段落标题，用于切分列表。
 *
 * `forUser` / `forAgent` 是给两个不同读者的两段话；其余是共用的证据段落。
 */
/**
 * 受众路由规则。
 *
 * 「给谁」不是描述，是一条**可校验的规则**：每一条话必须带一个闭集里的类别标签，
 * 而每个类别只属于一个受众。判据是「谁能真的动手改」：
 *   - 只有用户能决定的（他自己的指令、他要不要授权、他要拍板的选择、他该去看什么）→ 给用户
 *   - Agent 自己能改的（补证据、改代码、收范围、换方法）→ 给 Agent
 * 标签出现在错误的一段里，引擎会**自动改投**到正确的一段，并计数。
 */
const USER_CATEGORIES = new Set(['指令', '授权', '决定', '验收']);
const AGENT_CATEGORIES = new Set(['证据', '改动', '范围', '方法']);

/**
 * 把一条 bullet 拆成「类别 + 文本」。
 * @param {string} value - bullet 文本。
 * @returns {{category: string, text: string}} 拆分结果。
 */
function splitCategory(value) {
  const matched = /^[\[【]([^\]】]{1,4})[\]】]\s*(.+)$/.exec(String(value ?? '').trim());
  if (matched === null) return { category: '', text: String(value ?? '').trim() };
  return { category: matched[1].trim(), text: matched[2].trim() };
}

/**
 * 按受众合法性分流，把投错的一段改投到另一段。
 * @param {object[]} items - 带类别的条目。
 * @param {Set<string>} allowed - 这一段允许的类别。
 * @param {Set<string>} others - 另一段允许的类别。
 * @returns {{kept: string[], moved: string[], rerouted: number, untagged: number}} 分流结果。
 */
function routeAudience(items, allowed, others) {
  const kept = [];
  const moved = [];
  let rerouted = 0;
  let untagged = 0;
  for (const item of items) {
    const { category, text } = item;
    if (text.length === 0) continue;
    const label = category.length > 0 ? `[${category}] ` : '';
    if (allowed.has(category)) { kept.push(label + text); continue; }
    if (others.has(category)) { moved.push(label + text); rerouted += 1; continue; }
    if (category.length === 0) untagged += 1;
    kept.push(label + text);
  }
  return { kept, moved, rerouted, untagged };
}

/** 输出格式里带冒号的固定行，用来切断列表段落。 */
const RESERVED_LINE = /^(本会话结论|结论|一句话|未结问题|已解决|给用户的话|给 Agent 的话|做对的地方|噪声|约束核对|Codex 观察|下一步检查点)\s*[:：]/;

/** 静默截断：问题标签用，不带「+N 字符」这种噪声。 */
function shorten(text, limit) {
  const value = String(text ?? '').trim();
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

/**
 * 剥掉复审员从记忆里抄回来的轮次计数前缀。
 *
 * 实测：提示词里用 `【第N轮起，已M轮】` 展示问题，模型会把这个格式原样抄进自己的
 * 输出，于是「同一问题」的匹配键每轮都不同，继承和反棘轮**双双失效** —— 记忆从
 * 1696 字一路涨到 2603 字并触发截断。这里在两端各剥一次。
 * @param {string} text - 候选文本。
 * @returns {string} 去掉前缀的文本。
 */
function stripCounterPrefix(text) {
  return String(text ?? '').replace(/^(?:【[^】]*】|\[[^\]]*\])\s*/g, '').trim();
}

/**
 * 解析「未结问题 / 已解决」两段。
 *
 * 这是新记忆形式的输入：复审员**每轮重写**这份清单，所以它是「当前仍然成立的问题」，
 * 而不是历史累积。不再出现的条目会被上层当作「已无证据」移除 —— 这条反棘轮规则防止
 * 一轮的误判永久污染后续所有轮次。
 * @param {string} text - 复审原文。
 * @returns {{open: object[], resolved: string[]}} 未结问题与已解决。
 */
function parseIssueSection(text) {
  const open = [];
  const resolved = [];
  let mode = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (/^未结问题/.test(line)) { mode = 'open'; continue; }
    if (/^已解决/.test(line)) { mode = 'resolved'; continue; }
    if (RESERVED_LINE.test(line)) { mode = null; continue; }
    if (mode === null) continue;
    const bullet = /^(?:[-*•]|\d+[.)])\s*(.+)$/.exec(line);
    if (bullet === null) continue;
    const value = bullet[1].trim();
    if (value.length === 0 || value === '无') continue;
    const tagged = /^\[(持续|新|已解决)\]\s*(.+)$/.exec(value);
    const body = stripCounterPrefix(tagged === null ? value : tagged[2]);
    if (tagged !== null) {
      if (tagged[1] === '已解决') { if (body.length > 0) resolved.push(shorten(body, 100)); continue; }
      if (body.length > 0) open.push({ text: shorten(body, 100), carried: tagged[1] === '持续', side: 'self' });
      continue;
    }
    if (body.length === 0) continue;
    // 模型常写「无（本会话第一次复审…）」——它不是一条已解决记录。
    if (/^[无沒没]\s*[（(。.、,，]?/.test(body) && body.length <= 60) continue;
    if (mode === 'open') open.push({ text: shorten(body, 100), carried: false, side: 'self' });
    else resolved.push(shorten(body, 100));
  }
  return { open: open.slice(0, 4), resolved: resolved.slice(0, 3) };
}

const SECTION_LABELS = [
  { key: 'forUser', label: '给用户的话' },
  { key: 'forAgent', label: '给 Agent 的话' },
  { key: 'good', label: '做对的地方' },
  { key: 'noise', label: '噪声/风险' },
  { key: 'constraints', label: '约束核对' },
  { key: 'codexObs', label: 'Codex 观察' },
];

/**
 * 按标题切出 bullet 列表。
 * @param {string} text - 复审文本。
 * @param {string} heading - 段落标题。
 * @returns {string[]} 列表项。
 */
function listSection(text, heading) {
  const out = [];
  let collecting = false;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const otherLabel = SECTION_LABELS.some(
      (entry) => entry.label !== heading && line.startsWith(entry.label),
    );
    if (line.startsWith(heading)) {
      collecting = true;
      const inline = line.slice(heading.length).replace(/^[:：]\s*/, '').trim();
      if (inline.length > 0) out.push(clip(inline, 300));
      continue;
    }
    if (!collecting) continue;
    if (otherLabel) break;
    if (RESERVED_LINE.test(line)) break;
    const bullet = /^(?:[-*•]|\d+[.)])\s*(.+)$/.exec(line);
    if (bullet !== null) {
      const value = bullet[1].trim();
      if (value.length > 0 && value !== '无') out.push(clip(value, 300));
      continue;
    }
    out.push(clip(line, 300));
  }
  return out.slice(0, 6);
}

/**
 * 把复审文本解析成结构化结论。解析失败也不会丢信息 —— `raw` 保留全文。
 * @param {string} text - 复审输出。
 * @param {number} turn - 轮次。
 * @returns {object} 结论。
 */
function parseVerdict(text, turn) {
  const raw = clip(typeof text === 'string' ? text.trim() : '', 4000);
  const verdict = {
    verdict: normalizeVerdict(matchLine(raw, /^(?:本会话结论|结论)\s*[:：]\s*(.*)$/m)),
    summary: matchLine(raw, /^一句话\s*[:：]\s*(.*)$/m),
    forUser: [],
    forAgent: [],
    good: [],
    noise: [],
    constraints: [],
    codexObs: [],
    nextCheck: matchLine(raw, /^(?:下一步检查点|建议)\s*[:：]\s*(.*)$/m),
    drift: matchLine(raw, /^[①1][.、)）]?\s*主题漂移\s*[:：]\s*(.*)$/m),
    stuck: matchLine(raw, /^[②2][.、)）]?\s*局部纠结\s*[:：]\s*(.*)$/m),
    reason: matchLine(raw, /^[③3][.、)）]?\s*选择理性\s*[:：]\s*(.*)$/m),
    advice: matchLine(raw, /^建议\s*[:：]\s*(.*)$/m),
    openIssues: [],
    resolvedIssues: [],
    rerouted: 0,
    untagged: 0,
    turn,
    at: Date.now(),
    digestChars: 0,
    dropped: [],
    raw,
  };
  for (const entry of SECTION_LABELS) verdict[entry.key] = listSection(raw, entry.label);
  const parsedIssues = parseIssueSection(raw);
  verdict.openIssues = parsedIssues.open;
  verdict.resolvedIssues = parsedIssues.resolved;
  // 受众路由：投错的自动改投，并计数，让「分给谁」变成可度量的东西。
  // 必须放在上面那个 SECTION_LABELS 循环**之后** —— 否则会被原始列表覆盖回去（实测踩过）。
  const user = routeAudience(listSection(raw, '给用户的话').map(splitCategory), USER_CATEGORIES, AGENT_CATEGORIES);
  const agent = routeAudience(listSection(raw, '给 Agent 的话').map(splitCategory), AGENT_CATEGORIES, USER_CATEGORIES);
  verdict.forUser = [...user.kept, ...agent.moved];
  verdict.forAgent = [...agent.kept, ...user.moved];
  verdict.rerouted = user.rerouted + agent.rerouted;
  verdict.untagged = user.untagged + agent.untagged;
  if (verdict.summary.length === 0 && raw.length > 0) verdict.summary = clip(oneLine(raw), 200);
  return verdict;
}

/**
 * 渲染注入给主 Agent 的通知文本 —— 这是模型实际会读到的东西。
 *
 * 只放「给 Agent 的话」这一侧；「给用户的话」是写给人的提醒，塞进模型上下文只会
 * 让它去回应不属于它的内容。
 * @param {object} verdict - 结构化结论。
 * @returns {string} 通知文本。
 */
function renderNotice(verdict) {
  const lines = [];
  lines.push('<review_notice>');
  const laneName = LANE_LABELS[verdict.lane] ?? '审我';
  // 自适应分析：有 `sections`（新格式）就整段照它排；形状来自 `rubric.js`，不是这里排的。
  if (Array.isArray(verdict.sections) && verdict.sections.length > 0) {
    lines.push(`独立复审（${laneName} · 第 ${verdict.turn} 轮）结论：${verdict.verdict}`);
    lines.push(renderAnalysisText(verdict));
    lines.push('</review_notice>');
    return lines.join('\n');
  }
  lines.push(`独立复审（${laneName} · 第 ${verdict.turn} 轮）结论：${verdict.verdict}`);
  if (verdict.summary.length > 0) lines.push(`一句话：${verdict.summary}`);
  const section = (title, items) => {
    if (items.length === 0) return;
    lines.push(`${title}:`);
    for (const item of items) lines.push(`- ${item}`);
  };
  section('给 Agent 的话', verdict.forAgent);
  const openSelf = (verdict.openIssues ?? []).filter((item) => item.side !== 'codex');
  if (openSelf.length > 0) {
    lines.push('还没解决的问题（复审员每轮重写这份清单，解决了它就会消失）：');
    for (const item of openSelf) lines.push(`- ${item.text}`);
  }
  section('约束核对', verdict.constraints);
  section('噪声/风险', verdict.noise);
  section('做对的地方', verdict.good);
  section('同机 Codex 观察', verdict.codexObs);
  if (verdict.nextCheck.length > 0) lines.push(`下一步检查点：${verdict.nextCheck}`);
  lines.push('这不是命令，但你不需要为了保持进度而忽略它。如果你认为复审判断有误，说明理由；如果你确实越过了约束或把猜测当成了事实，先修正再继续。');
  lines.push('</review_notice>');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * 插件入口
 * ------------------------------------------------------------------ */

/**
 * 安装复审引擎。
 * @param {object} ctx - 宿主插件上下文。
 * @param {object} config - 已校验的 {@link Config}。
 */
export function apply(ctx, config) {
  const cfg = resolveConfig(config);
  /** 每个 Agent 同一时刻最多一次复审。 */
  const inflight = new Map();

  // **D：删掉死的远程路径。**
  //
  // 这里曾经挂一个宿主远程服务 `reviewRemote`（`remote.js` 的 `ReviewRemote`），
  // 让面板走 `ctx.remote.reviewRemote.*`。**那条路永远通不了**，判据是 shipped 源码：
  //   - `@deepseek-ai/dsh-api-remotes/lib/client.js:13503` `const inject = ["remote"]`，
  //     紧接 `:13512-13538` 是一份**写死的 25 个贡献**，用 `ctx.remote.$mount(...)` 挂上；
  //     它的 README:75 明写「The capability set is fixed by explicit build-time value
  //     imports; the Client does not discover the Host's active Services or Remote
  //     definitions at runtime.」——手写的宿主服务进不了那份清单。
  //   - 当年的现场报错也是它：`读目录失败：cannot get property "remote" without inject`。
  // 现在面板走的是 `commands`（在固定清单里，`:4884-4942`），所以这个挂载点没有调用方了。
  // `remote.js` 本身还留着：命令 handler 复用它的 `buildTargets` / `conversationEvidence` /
  // `answerFromTable` / `lastReviewCard`（都是纯函数），`remote-test` 也直接测那个模块。

  ctx.effect(
    () =>
      ctx.sessionProjections.register({
        key: PROJECTION_KEY,
        stateSchema: reviewStateSchema,
        // v6：新增 feed —— 实时条目流，侧边浮层照着它渲染。用户要「实时更新、不要报告」，
        // 所以每次复审只追加几行短句，而不是一整份结论。
        // v7：新增 stream —— 流式复审的半成品，让面板一段一段长出来。
        //     同一版曾把结论改成「三路一起审」的固定表格；**那张表在 2026-10 被用户推翻**
        //     （「有点呆」），现在是 rubric.js 的四段自适应分析（见 FLOW.md bug 53）。
        stateVersion: 7,
        init: () => ({
          turn: 0, toolCalls: 0, totalToolCalls: 0, turnStartSeq: 0,
          reviews: 0, feed: [], trajectory: [], issues: [], resolved: [], last: null, stream: null,
          pending: null, failure: null,
        }),
        apply: (state, event) => applyEvent(state, event),
        wire: { viewSchema: reviewStateSchema, view: (state) => state },
      }),
    'review-mode.projection()',
  );

  /**
   * 这个 Agent 是否运行在冷静审核模式，且是顶层会话。
   * 子 Agent 继承父预设，必须显式排除，否则复审会无限套娃。
   * @param {object} agent - 候选 Agent。
   * @returns {boolean} 是否应该复审。
   */
  function shouldReview(agent) {
    const header = agent.session?.header;
    if (header === undefined) return false;
    if (header.origin === 'subagent') return false;
    if (header.parentSession !== undefined) return false;
    try {
      return ctx.sessionProjections.stateOf(agent.session, 'agentPreset') === cfg.preset;
    } catch {
      return false;
    }
  }

  /**
   * 当前这一轮已经发生的工具调用次数。
   * @param {object} agent - 目标 Agent。
   * @returns {number} 次数。
   */
  function toolCallsThisTurn(agent) {
    try {
      return ctx.sessionProjections.stateOf(agent.session, PROJECTION_KEY)?.toolCalls ?? 0;
    } catch {
      return 0;
    }
  }

  /* ── 一个用户动作只审一次（2026-10 用户抓到的「两边一起跳」）──────────────
   *
   * 用户原话：「我点了之后，**审核面板会跳，对话框那边也会跳，它有相冲突**」。
   * 真因是同一个回合被审了两遍：A 路（主 Agent 在回合里点名 / 面板按钮）已经派过一次
   * **directed** 复审（`runDirectedReview`，结果折进 `reviewMode` 投影 → 面板一张卡），
   * 而回合干净收尾时 `agent/turn-stopping` **又**跑一次本会话的通用复审
   * （`runReview`，整会话 digest）→ 第二张卡、第二个可见变化。
   *
   * 规则：**同一个回合里已经派过 directed 复审，这一轮收尾的通用复审就跳过。**
   * 「同一个回合」用投影里真实的 `turnStartSeq`（`turn/start` 事件的 seq）判定 ——
   * 所以「回合中间点的按钮」会被去重，而「上一个回合点的按钮 + 这个回合正常收尾」
   * 不会被误去重（token 已经前进）。
   */
  const directedTurns = new WeakMap();

  /**
   * 这个 Agent 当前回合的 token（`turn/start` 的 seq）；读不到就 null（**永不匹配**）。
   * @param {object} agent - 目标 Agent。
   * @returns {number|null} 回合 token。
   */
  function turnToken(agent) {
    try {
      const seq = Number(ctx.sessionProjections.stateOf(agent.session, PROJECTION_KEY)?.turnStartSeq);
      return Number.isFinite(seq) ? seq : null;
    } catch {
      return null;
    }
  }

  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    if (inflight.has(agent)) return;
    if (!shouldReview(agent)) return;
    // 这个回合已经由 A 路 / 面板按钮派过一次复审了 —— 收尾时绝不再审一遍。
    const token = turnToken(agent);
    if (token !== null && directedTurns.get(agent) === token) {
      directedTurns.delete(agent);
      trace({ turn, skip: 'generic-review-suppressed-by-directed', token });
      return;
    }
    if (toolCallsThisTurn(agent) < cfg.minToolCalls) return;
    // 绝不阻塞这一轮的收尾：复审在后台跑，结论稍后作为通知注入。
    ctx.agents
      .withoutInitiator(() => runReview(ctx, cfg, agent, turn, inflight, liveness))
      .catch((error) => {
        ctx.logger.warn(`review-mode: review driver failed: ${errorText(error)}`);
      });
  });

  // ── Codex 监控器：你在那边干活，这边自动审 ──────────────────
  //
  // 规则（用户 2026-10 改成「以我发问为节点」）：盯住用户点选的那条对话，
  // **它里面每多一条用户消息，就自动生成一次新评价**；没有新消息就一次都不审。
  // 定时器（默认 5 秒）只负责"发现有没有新消息"，不负责评价节奏。
  let watching = false;

  /* ── 宿主侧的**活性记录**：面板 `ping` 只读它，**不触发任何扫描** ──────────
   *
   * 用户的原话：「您那边如果一直不动……你要不弄一个一直在转的帮我显示他在连接……
   * 连接上那就在转，没有连接上就消失，不然我不知道他有没有（在工作）」。
   *
   * 面板是从 `reviewMode` 投影渲染的，而投影**只在会话事件发生时**才变 ——
   * 用户不发消息，投影就不变，面板也就不重画，于是「安静地工作」和「死了」长得一模一样。
   * 所以客户端要有一个**真的**心跳：走已经打通的 `commands` 通道调 `ping`，
   * 宿主立刻回这个快照（零模型、零读盘、零投递）。
   *
   * `lastTickAt` / `tickIntervalMs` / `conversations` 就是面板上那句
   * 「主机上次 tick …… · 间隔 …… · 上次扫描 N 条对话」的来源 ——
   * 光会转不算「在工作」，得能说出它刚刚干了什么。
   */
  const liveness = {
    startedAt: Date.now(),
    tickEnabled: cfg.watchCodex === true,
    tickIntervalMs: Number.isFinite(cfg.watchIntervalMs) ? cfg.watchIntervalMs : null,
    lastTickAt: null,
    tickCount: 0,
    scanAt: null,
    conversations: null,
    targetId: null,
    // 面板最近一次跟哪条会话打过交道（`runPanelCommand` 就地写）。
    // 监控器复审的落点优先用它 —— 保证和面板画的是同一份投影（bug 45）。
    panelSessionId: null,
    busy: false,
    /* ── 「审核到底跑不跑得起来」—— 面板的活性灯必须能说出这件事 ────────
     *
     * 用户 2026-10 抓到的那个谎：面板显示「✅ 已连接 · 监控中 · 主机心跳 9 秒前 ·
     * 上次扫描 40 条对话」，可**同一时刻**模型调用正因为 route 没有凭据而失败
     * （`本轮运行失败 llm-deepseek: no API key for provider route "deepseek-official" …
     * MISSING_CREDENTIAL`）。灯只证明了「面板命令通道答话」，却当成「系统在工作」。
     *
     * 所以活性记录里必须同时有「上一次真实的运行结果」：
     *   - `turnOutcome`：从**会话事件日志的内存快照**里折出来的最近一次
     *     `turn/end`；失败就是失败（真因判据见 `failureOfTurnEnd`）；
     *   - `modelSelection`：这条会话（**主对话**）的模型配置，面板命令时记下 ——
     *     它同时是复审员要继承的那份配置（见 `reviewerModelSelection`）。
     * 两者都只在**已经有事件发生**时更新，`ping` 自己一个字节都不读盘、不调模型。
     *
     * ⚠️ **范围**（2026-10 用户现场，见 `panelPing` 的 `lastTurn` / `history`）：
     * 会话日志是**从盘上恢复**的，所以里面既有本进程刚跑的轮次，也有**上一个进程**
     * 留下的 `turn/end`。后者不能冒充「这个面板现在跑不起来」—— 用户读到的那句
     * 「最近一次运行失败（6148 秒前）：developer/message turn must be a non-negative
     * safe integer」就是上一个进程的旧账。判据是时间：`turn/end` 的 `time` 早于
     * `startedAt`（本进程加载这个插件的那一刻）就不算当前，只作为**历史**如实报出。
     */
    modelSelection: undefined,
    turnOutcome: null,
  };

  /**
   * 记一次目录扫描的规模。**只在监控器真的扫过时调** ——
   * `panelPing` 绝不调它，否则「心跳」就变成了「每 ping 一次扫一遍盘」。
   *
   * ⚠️ 也**不是每 tick 都调**：调用点在 `resolveWatchEntry()` 里，而稳态
   * （目标没变、`watch.files` 都还在）走的是早返回分支，根本不扫盘。
   * 所以面板上「上次扫描 N 条对话」反映的是**最近一次真的扫过盘**的那一回，
   * 可能比心跳旧很多。它报的数在写入那一刻是真的（上限 1000 条），
   * 但不要把它读成「刚刚看到的」。这条已写进 FLOW.md 第 12 步的「这行事实有多旧」。
   * @param {object[]} entries - 这一次扫描出来的对话条目。
   */
  const noteScan = (entries) => {
    liveness.scanAt = Date.now();
    liveness.conversations = Array.isArray(entries) ? entries.length : null;
  };

  /* ── 流式复审：订阅复审子 Agent 的 assistant-stream ────────────────
   *
   * 用户要的是「左边右边有界面不断流式、自动生成这样一份分析」。宿主事件目录里
   * `agent/assistant-stream`（`{agent, frame}`，frame = start | chunk | end）是唯一的
   * 逐帧来源；`reviewMode` 投影只由**已提交的会话事件**折出，没有命令式的推送口，
   * 所以我们把半成品**注入父会话**（`agent.inject` → `agent/inbox/spliced` → 投影的
   * `stream` 字段），客户端照旧从投影读 —— 不需要新的客户端通道。
   *
   * 粒度是**段落**，不是字符：模型每写完一个段落就推一次（一次复审最多 5 次），
   * 而不是每帧都注入一条消息。per-frame 注入会在父会话里堆出几百条通知、
   * 也会污染 Agent 的上下文，代价远大于收益。
   */
  const streams = new Map();

  /** 已经长出内容的段落数 —— 用来判断「新的一段成型了，该推一次」。 */
  function filledSectionCount(text) {
    const parsed = parseAnalysis(text);
    return ANALYSIS_SECTIONS.filter((section) => {
      const value = parsed[section.key];
      return section.key === 'summary' ? String(value ?? '').trim().length > 0 : (Array.isArray(value) && value.length > 0);
    }).length;
  }

  /** 把一个流式半成品投递给父会话，让投影长出 `stream`，面板就能一段一段画。 */
  function pushStream(stream) {
    const parsed = parseAnalysis(stream.text);
    try {
      appendReviewSurface(stream.parent, 'stream', {
        lane: stream.lane,
        streaming: true,
        verdict: parsed.verdict,
        sections: ANALYSIS_SECTIONS,
        headline: parsed.headline,
        dialog: parsed.dialog,
        summary: parsed.summary,
        analysis: parsed.analysis,
        advice: parsed.advice,
      }, renderAnalysisText(parsed));
      trace({ stream: 'push', lane: stream.lane, sections: filledSectionCount(stream.text), chars: stream.text.length });
    } catch (error) {
      // 流式只是体验，坏了绝不影响复审本身。
      ctx.logger?.warn?.(`review-mode: stream push failed: ${errorText(error)}`);
    }
  }

  // 监听器注册在插件根作用域，收到所有 Agent 的帧；用 subagent id 过滤出我们自己的复审员。
  ctx.on('agent/assistant-stream', (payload) => {
    try {
      const stream = streams.get(payload?.agent?.id);
      if (stream === undefined) return;
      const frame = payload?.frame;
      if (frame?.type === 'start') { stream.text = ''; stream.emitted = 0; return; }
      if (frame?.type !== 'chunk') return;            // end 由 run.result 收口
      const chunk = frame.chunk;
      if (chunk?.type !== 'text-delta' || typeof chunk.text !== 'string') return;
      stream.text += chunk.text;
      const filled = filledSectionCount(stream.text);
      if (filled > stream.emitted) { stream.emitted = filled; pushStream(stream); }
    } catch (error) {
      ctx.logger?.warn?.(`review-mode: stream frame dropped: ${errorText(error)}`);
    }
  });

  /**
   * 正在盯的那条：`{id, lane, file, count}`。
   *
   * 用户的原话：「以我发问为节点吧，然后你就同步，然后自动生成一个新的评价」。
   * 所以定时器只做**便宜的存在性检测**（有没有新的用户消息），
   * 贵的那次复审只在**边沿**上跑一次 —— 不是定时的、也不问用户。
   */
  let watch = null;
  const WATCH_SCAN = 1000;

  /**
   * 解析要点名的 rollout。点选的目标缓存文件路径，之后每 tick 不再走目录。
   *
   * 返回的是**合并后的条目**（`files` 是这条对话的全部 rollout）：一条对话可能被
   * Codex 拆成几份，只盯最新那份会把「新的用户消息」数错。见 `reviewer.js` 的 `listCodex`。
   */
  function resolveWatchEntry(picked) {
    const lane = picked !== null && typeof picked === 'object' && picked.kind === 'codex'
      ? (LANES.includes(picked.lane) ? picked.lane : 'me')
      : 'me';
    if (picked !== null && typeof picked === 'object' && picked.kind === 'codex') {
      if (watch !== null && watch.id === picked.id && Array.isArray(watch.files)
        && watch.files.every((file) => fs.existsSync(file.file))) {
        return { id: picked.id, lane, files: watch.files };
      }
      const all = listCodex(WATCH_SCAN);
      noteScan(all);
      const hit = all.find((entry) => entry.id === picked.id
        || entry.threadId === picked.id
        || (Array.isArray(entry.files) && entry.files.some((file) => file.id === picked.id)));
      return hit === undefined ? null : { id: hit.id, lane, files: hit.files ?? [{ id: hit.id, file: hit.file, mtime: hit.mtime }] };
    }
    // 没点选：维持旧的兜底 —— 盯最近动过的那条对话。
    const all = listCodex(WATCH_SCAN);
    noteScan(all);
    const newest = all[0];
    return newest === undefined ? null
      : { id: newest.id, lane: 'me', files: newest.files ?? [{ id: newest.id, file: newest.file, mtime: newest.mtime }] };
  }

  /**
   * 读一条对话的全部 rollout 汇成一份活动记录。
   * @param {object[]} files - 这条对话的 rollout（旧 → 新）。
   * @param {number} tailBytes - 每个文件回读多少字节。
   * @returns {object|null} 汇总后的活动记录。
   */
  function readConversation(files, tailBytes) {
    let merged = null;
    for (const file of files) {
      const activity = readRollout({ file: file.file, mtime: file.mtime }, tailBytes);
      if (activity === null) continue;
      if (merged === null) {
        merged = { ...activity, file: files.map((f) => path.basename(f.file)).join(' + ') };
        continue;
      }
      merged.asks.push(...activity.asks);
      merged.commands.push(...activity.commands);
      merged.notes.push(...activity.notes);
      merged.failures.push(...activity.failures);
      merged.exec.push(...activity.exec);
      if (merged.cwd.length === 0) merged.cwd = activity.cwd;
      merged.mtime = activity.mtime;
    }
    return merged;
  }

  /**
   * 派一个复审员，并把它的输出折进 `reviewMode` 投影（面板渲染的就是它）。
   *
   * **这是两条派单路唯一的共同管线**：
   *   - 监控器（`watchOnce`，用户消息 +1 的边沿）；
   *   - 面板按钮（`startPanelReview`，用户点了方向 / 选了对话）。
   *
   * 为什么必须共用（真发生过的现场失败，2026-10）：按钮以前走
   * `agent.followup(提示词)`，唤醒的是**审核会话的主 Agent**，由它自己复审并把整张表
   * 写进对话 —— 那条路根本不经过投影，所以面板一直停在「审核中…」而对话里却出现了表。
   * 用户的原话：「上面的话，我提问了，你在回答我」。所以两条路都必须**由宿主直接
   * 派复审子 Agent**，结果只落到投影里。
   *
   * 三件事在这里被写死，免得只改一条、漏掉另一条：同一个 spawn 形状（含
   * `agentOptions` 的模型配置继承、`toolFilter` 零工具（见 `reviewerToolFilter`）、`parent` 是审核会话）、
   * 同一个流式认领、同一个 `parseAnalysisVerdict` + `deliver`。
   * @param {object} parent - 审核会话的 Agent（复审的 parent，也是投递目标）。
   * @param {object} job - `{lane, promptText, label}`。
   * @returns {Promise<object|null>} 折进投影的结论；复审员没吐内容时 null。
   */
  async function runDirectedReview(parent, job) {
    const lane = LANES.includes(job?.lane) ? job.lane : 'me';
    const label = job?.label ?? `审核 · ${LANE_LABELS[lane] ?? '审我'}`;
    const controller = new AbortController();
    // **复审一开跑就先在投影里立「进行中」**：面板据此区分「还没有任何评价」（真空）
    // 与「复审员正在写」（在跑）。没有这一步，用户在复审那几十秒里看到的和
    // 「什么都没发生」一模一样，而结论可能晚一步才到 —— 那正是用户抓到的现场。
    publishReviewState(parent, 'pending', { lane, label, at: Date.now() });
    /* 记下「这个回合已经审过了」：回合收尾时 `agent/turn-stopping` 的通用复审
     * 据此跳过（见 `directedTurns` / `turnToken`）。用 `turnStartSeq` 而不是时间戳，
     * 所以只对**同一个回合**生效，不会把下一个回合的复审一起吞掉。 */
    const markedTurn = turnToken(parent);
    if (markedTurn !== null) directedTurns.set(parent, markedTurn);
    let run;
    try {
      run = await ctx.subagents.start(cfg.provider, {
        label,
        prompt: [{ type: 'text', text: String(job?.promptText ?? '') }],
        parent,
        signal: controller.signal,
        // 复审员零工具（见 `reviewerToolFilter`）：证据与输出格式全在提示词里。
        toolFilter: reviewerToolFilter(),
        // 模型配置跟主对话，上下文各自独立（见 `reviewerAgentOptions`）。
        ...reviewerAgentOptions(parent, liveness),
      });
    } catch (error) {
      // 起都起不来：面板必须说「失败 + 真因」，不能继续显示空状态/进行中。
      publishReviewState(parent, 'failed', { lane, label, at: Date.now(), message: errorText(error) });
      throw error;
    }
    // 登记流式缓冲：`agent/assistant-stream` 的帧按 run.id 认领。
    const stream = { parent, lane, text: '', emitted: 0 };
    const streamId = run?.id ?? run?.localAgent?.id;
    if (streamId !== undefined && streamId !== null) streams.set(streamId, stream);
    try {
      const result = await run.result;
      const text = contentText(result?.output) || String(result?.diagnostic ?? '');
      if (text.trim().length === 0) {
        publishReviewState(parent, 'failed', { lane, label, at: Date.now(), message: '复审员没有输出任何内容' });
        return null;
      }
      // 折进记忆的那一刻，投影会把它变成面板上的一张卡片（并清掉 stream / pending / failure）。
      const parsed = parseAnalysisVerdict(text, parent.session.seq ?? 0, lane);
      deliver(ctx, parent, { ...parsed, digestChars: text.length, dropped: [] });
      return parsed;
    } catch (error) {
      publishReviewState(parent, 'failed', { lane, label, at: Date.now(), message: errorText(error) });
      throw error;
    } finally {
      if (streamId !== undefined && streamId !== null) streams.delete(streamId);
      await run.dispose().catch(() => {});
    }
  }

  /**
   * 往投影里投一条**进度**（进行中 / 失败）—— 面板据此把四态分开。
   *
   * 纪律：只走 `developer/message` 面事件（对话流不渲染）。**不退回 `agent.inject`** ——
   * 进度提示一旦落进对话记录，用户就会在「上面」看到一句系统话，而这条改动要的正是
   * 「上面只有你问我答」。宿主上下文不支持面事件时，进度提示丢掉即可，复审本身不受影响。
   * @param {object} parent - 审核会话的 Agent。
   * @param {string} form - `pending` / `failed`。
   * @param {object} review - 投影要折的负载。
   * @returns {boolean} 是否真的写进了会话事件。
   */
  function publishReviewState(parent, form, review) {
    const session = parent?.session;
    if (typeof session?.append !== 'function') return false;
    try {
      const text = form === 'pending'
        ? `（复审进行中：${review.label}）`
        : `（复审失败：${review.message}）`;
      appendReviewSurfaceOnly(parent, form, review, text);
      return true;
    } catch (error) {
      ctx.logger?.warn?.(`review-mode: could not publish review ${form}: ${errorText(error)}`);
      return false;
    }
  }

  /**
   * 面板按钮触发的复审 —— 后台跑，**不阻塞命令 handler**。
   *
   * handler 必须立刻返回 `{kind}`（`normalizeResult` 要它），所以这里只负责点火：
   * 命令马上把目录/证据还给面板，复审结果稍后由投影的变化自己让面板重画。
   * @param {object} parent - 命令的 `invocation.agent`（当前审核会话）。
   * @param {object} job - `{lane, promptText, label}`。
   * @returns {Promise<object|null>} 复审的 promise（调用方不等）。
   */
  function startPanelReview(parent, job) {
    if (parent === undefined || parent === null) return Promise.resolve(null);
    const fire = () => runDirectedReview(parent, job);
    try {
      const pending = typeof ctx.agents?.withoutInitiator === 'function'
        ? ctx.agents.withoutInitiator(fire)
        : fire();
      return Promise.resolve(pending).catch((error) => {
        ctx.logger.warn(`review-mode: panel review failed: ${errorText(error)}`);
        return null;
      });
    } catch (error) {
      ctx.logger.warn(`review-mode: panel review could not start: ${errorText(error)}`);
      return Promise.resolve(null);
    }
  }

  /**
   * A 路（主 Agent 调 `review_conversation`）的宿主入口。
   *
   * 注册到零依赖的 `reviewer.js`：预设行里的工具执行时调用它，于是 A 路和
   * **监控器 / 面板按钮**共用同一个 `runDirectedReview` —— 同一个 spawn、
   * 同一个流式认领、同一个 `parseAnalysisVerdict` + `user/message` 投递。
   * 所以「主 Agent 这一轮写了什么」不再影响评价的落点：它只影响对话区那一句。
   *
   * 返回的是一句**如实**的受理状态（工具把它 render 给模型）：
   *   - `started`：已经点火，正在生成；
   *   - `failed`：连点火都没成（没有活着的审核会话 / 证据不合法）。
   * **绝不**返回「表已落到面板」——那要等 `deliver` 真的发生，而那时工具早已返回。
   * @param {object} request - `{kind,id,lane,title,evidence,agent}`（来自工具）。
   * @returns {{status: string, note: string}} 受理状态。
   */
  function dispatchAgentReview(request) {
    const lane = LANES.includes(request?.lane) ? request.lane : 'me';
    const preferred = request?.agent;
    const parent = preferred !== undefined && preferred !== null && shouldReview(preferred)
      ? preferred
      : ctx.agents.list().find((candidate) => shouldReview(candidate));
    if (parent === undefined || parent === null) {
      return {
        status: 'failed',
        note: '没有活着的审核会话可以承载这次复审，这次**没有生成任何评价**，审核面板上也不会有东西。请如实告诉用户。',
      };
    }
    const evidence = request?.evidence;
    if (evidence === null || typeof evidence !== 'object') {
      return {
        status: 'failed',
        note: '这次没有取到可审的证据，复审没有启动；审核面板上不会有东西。请如实告诉用户。',
      };
    }
    const label = `审核 · ${LANE_LABELS[lane] ?? '审我'} · ${clip(String(evidence.title ?? request?.id ?? ''), 40)}`;
    // 点火即可，不 await —— 工具调用不该被一次复审卡住。
    startPanelReview(parent, { lane, promptText: renderEvidencePrompt(evidence, lane), label });
    return {
      status: 'started',
      note: '复审已受理：宿主复审员正在后台生成，结果**只会出现在右边的审核面板**。'
        + '这一轮回复最多一句话（例如「已交给复审员，结果在右边的审核面板」），不要复述证据、不要贴表格。',
    };
  }

  // A 路的派单钩子必须在**插件加载时**就装好：预设行里的 `review_conversation`
  // 执行时靠它把复审交给宿主（见 reviewer.js 的 `dispatchReview`）。
  setReviewDispatch((request) => dispatchAgentReview(request));

  const watchOnce = async () => {
    // **先记「宿主还活着」** —— 即使监控关了、或当下没有审核会话，这一行也照样更新，
    // 面板的 `ping` 才有东西可报（否则「连接成功」也会显示成一片空白）。
    liveness.lastTickAt = Date.now();
    liveness.tickCount += 1;
    // 版本戳的「磁盘现在是什么」在 tick 里刷新（ping 自己绝不读盘）。
    refreshCodeIdentity();
    if (!cfg.watchCodex || watching) return;
    watching = true;
    liveness.busy = true;
    try {
      const targets = ctx.agents.list().filter((agent) => shouldReview(agent));
      if (targets.length === 0) return;
      const picked = currentTarget();
      // 未选目标时保持等待，不能擅自审核另一条 Codex 对话。
      if (picked === null) { liveness.targetId = null; watch = null; return; }
      const active = resolveWatchEntry(picked);
      liveness.targetId = active?.id ?? null;
      trace({ tick: true, picked: picked?.id ?? null, watching: active?.id ?? null, targets: targets.length });
      if (active === null) return;
      if (picked !== null && picked.kind !== 'codex') {
        trace({ picked: picked.id, skipped: `暂不支持 kind=${picked.kind} 的点选（只做了 Codex）` });
        return;
      }

      // **便宜的检测**：只读这一条对话，数出「用户说了几条」。合并后的 entry 会
      // 把这条对话的每一份 rollout 都算上，所以拆成几份也不会漏掉新的那一条。
      const read = readCodex({ id: active.id, threadId: codexThreadId(active.files[active.files.length - 1].file), files: active.files });
      const switched = watch === null || watch.id !== active.id;
      const previous = switched ? undefined : watch.count;
      const edge = nextReviewEdge(previous, read.askCount);
      watch = { id: active.id, lane: active.lane, files: active.files, count: edge.count };
      // 用户**点选**了一条新对话时，0 句的对话在「审对话 / 审 Agent」两条线上也要立刻给一次评价
      // —— 因为没有「新的用户消息」这个节点可用，选择本身就是节点。
      const selectionFire = switched && active.lane !== 'me' && (read.askCount > 0 || read.otherCount > 0);
      trace({ edge: edge.fire, selectionFire, id: active.id, lane: active.lane,
        userMessages: read.askCount, otherMessages: read.otherCount });
      // **没有新的用户消息就不审** —— 绝不按定时器重复评价。
      if (!edge.fire && !selectionFire) return;
      const lane = active.lane;

      // 到了边沿才走贵的那条路：读完整 rollout 抽证据。
      const activity = readConversation(active.files, cfg.codexTailBytes);
      trace({ reviewing: active.files.map((file) => path.basename(file.file)).join(' + '), lane, asks: activity?.asks.length ?? -1, notes: activity?.notes.length ?? -1 });
      if (activity === null) return;
      // 「审我」：用户没说话就没什么可审的（这一列没有主体）。
      // 「审对话」「审 Agent」：用户没说话**照样审** —— 只要有东西可看。
      if (lane === 'me' && activity.asks.length === 0) return;
      if (lane !== 'me' && activity.asks.length === 0 && activity.notes.length === 0) return;
      // 落点必须和**面板画的**同一份投影（bug 45 的最后一处）：面板现在只画
      // 「正在主栏显示」的那条审核会话，而监控器原来按 `agents.list()` 的顺序取第一条 ——
      // 同时开着两条审核会话时，它会把结论写进你看不见的那条，面板又空着。
      // `panelSessionId` 由面板命令就地记下（见 `runPanelCommand`；面板每 20 秒一次
      // 心跳，所以只要面板开着它就是当前在看的会话）。记不到 / 会话已关 → 退回老行为。
      const parent = pickReviewParent(targets, liveness.panelSessionId);
      // 和面板按钮**同一条管线**（`runDirectedReview`）：同一个 spawn、同一个流式认领、
      // 同一个 parseAnalysisVerdict + user/message 投递。监控路的行为一个字没变。
      await runDirectedReview(parent, {
        lane,
        promptText: renderLanePrompt(activity, lane),
        label: `审核 · ${LANE_LABELS[lane] ?? '审我'}`,
      });
    } catch (error) {
      ctx.logger.warn(`review-mode: Codex watch failed: ${errorText(error)}`);
    } finally {
      watching = false;
      liveness.busy = false;
    }
  };
  const watchTimer = setInterval(() => { void watchOnce(); }, cfg.watchIntervalMs);
  ctx.effect(() => () => clearInterval(watchTimer), 'review-mode.watch()');

  /* ── 面板按钮的宿主入口：一条**会话命令** ──────────────────────────
   *
   * 为什么不继续用 `reviewRemote`：浏览器能调到的远程命名空间是**构建期写死的**。
   * 证据（shipped 源码）：
   *   - `@deepseek-ai/dsh-api-remotes/lib/client.js:13503` `const inject = ["remote"]`，
   *     紧接 `:13512-13538` 是**硬编码的 25 个生成贡献**，用
   *     `ctx.remote.$mount(contribution)` 挂上去；它的 README:75 写明
   *     「The capability set is fixed by explicit build-time value imports; the Client
   *     does not discover the Host's active Services or Remote definitions at runtime.」
   *   - `commands` **在**那份清单里（`commands.execute` / `commands.list`，
   *     `:4884-4942`），所以它是我们唯一真能用的前端→宿主通道。
   *     `dsh-agent-preset/skills/cordis-plugin-development/references/user-actions.md:8`
   *     就是这条：「such as a session command that `ctx.remote.commands.execute()` runs」。
   *
   * 服务用 `ctx.inject([...], cb)` 拿（child fiber，不进 `loader.entries()`，
   * web boot 的致命检查看不见它）——**绝不**写进顶层 `inject`。那正是把应用弄挂过的做法。
   */
  if (typeof ctx.inject === 'function') {
    ctx.inject(['commands'], (commandCtx) => {
      commandCtx.effect(() => commandCtx.commands.register({
        definitionId: '@local/dsh-review-mode#panel',
        name: 'review-mode',
        description: '审核面板的按钮入口：读目录 / 选中一条对话 / 针对评价提问 / 活性心跳',
        input: { hint: 'dir <self|dsh|codex> | pick <kind> <id> | ask <question> | ping' },
        handler: (invocation) => runPanelCommand(ctx, invocation?.agent, invocation?.rawInput, liveness, {
          // 复审**由宿主自己派**（和监控器同一条 `runDirectedReview` 管线），不唤醒主 Agent。
          startReview: (job) => startPanelReview(invocation?.agent, job),
        }),
      }), 'review-mode.command()');
    });
  }


  // 用户明确要求「一开始直接让我选，不要让我说话」。DSH 里 Agent 不会主动开口，
  // 所以由宿主在审核会话创建时用 followup()（会唤醒，和 inject 不同）推它一把。
  //
  // ⚠️ 2026-10 用户批准的**入口唯一化**：入口就是面板那三个方块，开场**不再问「审谁」**，
  // 更不许把三个方向做成 `ask_user_question` 的选项 —— 那正是和面板重复的第二个入口，
  // 也是「两条路两种落点」的根。所以开场缩成**一句话**，只是把用户指到面板；
  // 不调任何工具、不列候选、不讲流程。对话区从第一秒起就只留给「用户问、Agent 答」。
  const OPENING = '开场指令（系统发的，不要在回复里复述这一句）：只回一句'
    + '「审核模式已就绪 —— 在右边的审核面板里点一个方向，我会自动复审并监控；有问题直接在这里问我。」'
    + '然后停。不要调用任何工具，不要问我审谁，也不要把方向做成可点选项。';

  ctx.on('agent/created', ({ agent }) => {
    try {
      if (shouldReview(agent)) {
        // 只在全新的会话里开场，已经有内容就别插嘴。
        if ((agent.session.seq ?? 0) === 0) agent.followup(createUserMessage({
          content: [{ type: 'text', text: OPENING }],
          source: { kind: SOURCE_KIND, form: 'notice', summary: '审核模式开场' },
        }));
      }
    } catch (error) {
      ctx.logger.warn(`review-mode: opening message failed: ${errorText(error)}`);
    }
  });

  ctx.on('agent/disposed', ({ agent }) => {
    const controller = inflight.get(agent);
    if (controller !== undefined) {
      inflight.delete(agent);
      controller.abort(new Error('agent disposed'));
    }
  });

  ctx.effect(
    () => () => {
      for (const controller of inflight.values()) {
        controller.abort(new Error('review-mode unloaded'));
      }
      inflight.clear();
    },
    'review-mode.teardown()',
  );
}

/**
 * 把一条「复审内容消息」折进状态 —— `agent/inbox/spliced`（旧的 inject 路）
 * 与 `developer/message`（新的、对话里看不见的路）共用同一段折叠逻辑，
 * 所以两条路的状态语义不可能漂。
 * @param {object} state - 折叠前的状态。
 * @param {object} message - 带着 `source.review` 的消息。
 * @returns {object} 新状态（不关心则返回原引用）。
 */
function foldReviewMessage(state, message) {
  if (message?.source?.kind !== SOURCE_KIND) return state;
  // 流式半成品：只更新 `stream`，不进记忆、不追加 feed 卡片。
  if (message.source.form === 'stream') {
    const partial = normalizeStream(message.source.review);
    return partial === null ? state : { ...state, stream: partial };
  }
  // 「复审进行中」：只立一个标记 —— 面板据此说「进行中」而不是空状态。
  // 新的一次复审开始，会把上一次的失败清掉（失败不是永久钉在界面上的）。
  if (message.source.form === 'pending') {
    const pending = normalizePending(message.source.review);
    return pending === null ? state : { ...state, pending, failure: null };
  }
  // 「复审失败」：说出真因，清掉进行中与半成品 —— 面板不再假装在跑。
  if (message.source.form === 'failed') {
    const failure = normalizeFailure(message.source.review);
    return failure === null ? state : { ...state, failure, pending: null, stream: null };
  }
  // 「针对评价的提问」的回答：进**同一个流**，但 `kind: 'qa'` 标得清清楚楚，
  // 一眼能分辨它和自动生成的评价。
  if (message.source.form === 'qa') {
    const entry = normalizeQaEntry(message.source.review);
    return entry === null ? state : { ...state, feed: [...state.feed, entry].slice(-FEED_KEEP) };
  }
  const review = normalizeVerdictRecord(message.source.review);
  return review === null ? state : foldReviewIntoState(state, review);
}

/**
 * 一个 Agent 的会话投影纯函数。
 * @param {object} state - 当前状态。
 * @param {object} event - 已提交的会话事件。
 * @returns {object} 新状态；忽略的事件返回原引用。
 */
function applyEvent(state, event) {
  switch (event?.type) {
    case 'turn/start': {
      const turn = Number(event.data?.turn ?? 0);
      if (state.turn === turn && state.toolCalls === 0) return state;
      return { ...state, turn, toolCalls: 0, turnStartSeq: Number(event.seq ?? 0) };
    }
    case 'tool/call':
      return { ...state, toolCalls: state.toolCalls + 1, totalToolCalls: state.totalToolCalls + 1 };
    // 现在的投递路：`user/message`（生产者自有的 `source.kind`）是面事件，
    // 模型看得到，而客户端的 `isVisibleChatNode` 把 `kind:'context'` 排除在对话流之外。
    // 只认我们自己那个 `source.kind`，别人的（`kind:'user'`）一个字都不折。
    case 'user/message':
      return foldReviewMessage(state, event.data);
    // 旧日志（2026-10 之前用 `developer/message` 投的那版）仍然折得出来 ——
    // 老会话回放时面板不该突然空掉。新代码不会再写这种事件。
    case 'developer/message':
      return foldReviewMessage(state, event.data?.message);
    case 'agent/inbox/spliced': {
      const inserted = event.data?.inserted;
      if (!Array.isArray(inserted)) return state;
      let next = state;
      for (const message of inserted) next = foldReviewMessage(next, message);
      return next;
    }
    default:
      return state;
  }
}

/**
 * 读出这个会话的累计进度与历次复审结论台账。
 * @param {object} ctx - 宿主插件上下文。
 * @param {object} agent - 目标 Agent。
 * @returns {{totalToolCalls: number, reviews: number, history: object[]}} 进度。
 */
function readProgress(ctx, agent) {
  const fallback = { totalToolCalls: 0, reviews: 0, turnStartSeq: 0, trajectory: [], issues: [], resolved: [] };
  try {
    const state = ctx.sessionProjections.stateOf(agent.session, PROJECTION_KEY);
    if (state === undefined) return fallback;
    return {
      totalToolCalls: Number(state.totalToolCalls ?? 0),
      reviews: Number(state.reviews ?? 0),
      turnStartSeq: Number(state.turnStartSeq ?? 0),
      trajectory: Array.isArray(state.trajectory) ? state.trajectory : [],
      issues: Array.isArray(state.issues) ? state.issues : [],
      resolved: Array.isArray(state.resolved) ? state.resolved : [],
    };
  } catch {
    return fallback;
  }
}

/**
 * 把一份复审结论折进记忆。
 *
 * 三件事，都是为了让记忆**有界**：
 *   1. 轨迹用游程压缩 —— 连续同结论合并成一段，所以 50 轮也只有几段。
 *   2. 问题清单由复审员每轮**重写一遍**：它再次报出来就是「仍然存在」，
 *      计数 +1 并保留最初的轮次；它不再报出来就是「不再有证据」，直接移除。
 *      这条反棘轮规则很关键：否则第 2 轮的一个误判会永久污染后面所有轮次。
 *   3. 已解决只留最近 2 条，用来防止复审员回头再报同一个已修好的问题。
 * @param {object} state - 折叠前的状态。
 * @param {object} review - 本轮的结论。
 * @returns {object} 新状态。
 */
function foldReviewIntoState(state, review) {
  // 轨迹：与上一段同结论就延长，否则新开一段。
  const tail = state.trajectory[state.trajectory.length - 1];
  const trajectory = tail !== undefined && tail.verdict === review.verdict
    ? [...state.trajectory.slice(0, -1), { ...tail, to: review.turn }]
    : [...state.trajectory, { from: review.turn, to: review.turn, verdict: review.verdict }];

  // 问题清单：本轮报出来的继承「从第几轮起」并计数。
  const issues = [];
  for (const item of review.openIssues) {
    const old = state.issues.find((candidate) => issueKey(candidate.text) === issueKey(item.text));
    issues.push({
      text: item.text,
      side: item.side,
      sinceTurn: old === undefined ? review.turn : old.sinceTurn,
      rounds: old === undefined ? 1 : old.rounds + 1,
    });
  }
  // 已解决：本轮新报的追加，保留最近 2 条。
  const resolved = [
    ...state.resolved,
    ...review.resolvedIssues.map((text) => ({ text, atTurn: review.turn })),
  ].slice(-RESOLVED_KEEP);

  // 每次复审追加**一张卡片**（不是几行短句）。用户明确说过一行行往下冒太像流水账：
  // 卡片是「最新一张展开、旧的收成一行」，好扫也好读。
  const at = review.at > 0 ? review.at : Date.now();
  const card = {
    at,
    turn: review.turn,
    kind: 'review',
    verdict: review.verdict,
    lane: review.lane ?? 'me',
    question: '',
    // 自适应分析：四条内容 + 段落表跟着卡片走，客户端不自己排段落名。
    sections: Array.isArray(review.sections) ? review.sections : ANALYSIS_SECTIONS,
    headline: shorten(String(review.headline ?? ''), 80),
    dialog: toTextArray(review.dialog).map((item) => shorten(item, 200)),
    summary: shorten(String(review.summary ?? ''), 400),
    analysis: toTextArray(review.analysis).map((item) => shorten(item, 300)),
    advice: toTextArray(review.advice).map((item) => shorten(item, 300)),
    // 列表那一行只读 `text`（= 领先行），所以它必须永远有值。
    text: shorten(leadingLine(review), 200),
    cost: review.digestChars,
  };
  const fresh = [...state.feed, card];

  return {
    ...state,
    reviews: state.reviews + 1,
    feed: fresh.slice(-FEED_KEEP),
    trajectory: trajectory.slice(-TRAJECTORY_KEEP),
    issues: issues.slice(0, ISSUES_KEEP),
    resolved,
    last: review,
    // 完成品落进 feed，半成品与「进行中 / 失败」标记一起让位 —— 四态互斥，不会并存。
    stream: null,
    pending: null,
    failure: null,
  };
}

/**
 * 把记忆渲染成给复审员看的一段文本。
 *
 * 这是整个「保留设计」的落点：轨迹是压缩的、问题是带计数的、已解决是短的，
 * 所以整段的大小与会话长度**无关**（约 500 字）。
 * @param {object} progress - 会话记忆。
 * @returns {string} 记忆段落。
 */
function renderMemory(progress) {
  const lines = [];
  const trajectory = progress.trajectory ?? [];
  if (trajectory.length === 0) {
    lines.push('- （这是本会话第一次复审。）');
  } else {
    const rendered = trajectory.map((seg) => (seg.from === seg.to
      ? `第${seg.from}轮 ${seg.verdict}`
      : `第${seg.from}-${seg.to}轮 ${seg.verdict}（连续${seg.to - seg.from + 1}轮）`));
    lines.push(`- 轨迹：${rendered.join(' → ')}`);
  }
  const issues = (progress.issues ?? []).filter((item) => item.side !== 'codex');
  if (issues.length === 0) {
    lines.push('- 之前提过、现在仍然成立的问题：无。');
  } else {
    lines.push('- 之前提过、现在仍然成立的问题（每轮由你重写；不再有证据的就别写进来，它会被移除）。');
    lines.push('  方括号里的轮次计数仅供你参考，**不要**把它抄进你的输出：');
    for (const item of issues) {
      lines.push(`  · [第${item.sinceTurn}轮起，已${item.rounds}轮] ${item.text}`);
    }
  }
  const resolved = progress.resolved ?? [];
  if (resolved.length > 0) {
    lines.push(`- 最近已确认解决（不要再报）：${resolved.map((item) => item.text).join('；')}`);
  }
  lines.push(`- 累计：已复审 ${progress.reviews ?? 0} 次，累计工具调用 ${progress.totalToolCalls ?? 0} 次。`);
  lines.push('判断趋势时以「轨迹」为准：如果最近几段都是 drifting，即使这一轮单看还行，也要在结论里点明它没有收敛。');
  return lines.join('\n');
}

/**
 * 渲染复审提示词的两个入口（Codex 监控路 / 面板与 A 路）。
 *
 * 判据**不在这里**：它在 `rubric.js` 的 {@link ANALYSIS_RUBRIC} 里，
 * 这里只负责把证据摆好、再把那个格式块贴到尾巴上。这样「改判据」永远只有一个地方。
 */

/* ══════════════════════════════════════════════════════════════════════
 * 自适应分析（四段锚点 + 条数不固定）—— 判据在 `rubric.js`
 *
 * 用户 2026-10 把上一版推翻了：上一版是「每次都出同一张 3×3 表格」，
 * 用户看完的评价是「我感觉有点呆吧」，并要求改成
 * 「具体的对话 → 对话概述 → 分析（**不必按三个选项**）→ 建议（可以多一点）」。
 * 所以 `REVIEW_TABLE_ROWS` / `REVIEW_TABLE_COLUMNS` / `parseReviewTable` /
 * `renderReviewTable` 全部删除，判据与提示词搬进 `./rubric.js` 一个文件。
 *
 * 本块只做两件事：
 *   1. 把「这次点的是哪条线」说清楚（`lane` 仍然是侧重点，不再是表格的列）；
 *   2. 尾巴贴 `rubric.js` 的 {@link renderAnalysisFormat}，所以三条派单路
 *      **不可能**各自写出一个不一样的格式块。
 * ══════════════════════════════════════════════════════════════════════ */

/** 这条线的主语，用在提示词里。 */
const LANE_SUBJECT = {
  me: '用户自己说的话',
  conversation: '整条对话（用户与对面 AI 的往返）',
  agent: '对面 AI 的回答',
};

/**
 * 提示词结尾的**输出格式块** —— 所有派单路（轮收尾 / 监控器 / 面板按钮）逐字共用。
 *
 * 它必须只有一份：形状由 `rubric.js` 的 `ANALYSIS_SECTIONS` 决定。抽出来的目的
 * 就是让第二条（面板按钮）路**不可能**顺手写出一个不一样的格式块。
 * @returns {string[]} 小标题 + 结论行 + 领先行 + 四个锚点。
 */
function formatBlockLines() {
  return renderAnalysisFormat();
}

/** 提示词开头那段「你是谁、这次审什么、怎么写」—— 三条路共用。 */
function rubricPreamble(focus) {
  return [
    '你是「审核模式」的复审员。你审的是**这件事本身**，不是一张表。',
    `本次用户点选的是「${LANE_LABELS[focus]}」这条线，所以分析要从这个角度切入；其余角度有证据就写，没证据就说「证据里没有」。`,
    '',
    ANALYSIS_RUBRIC,
  ];
}

/**
 * 渲染 Codex 监控那一路的复审提示词。
 *
 * `lane` 只决定分析的切入点，**不再决定表格的哪一列**（表格已经删掉）。
 * @param {object} activity - readRollout 的结果。
 * @param {string} lane - `me` / `conversation` / `agent`。
 * @returns {string} 提示词。
 */
function renderLanePrompt(activity, lane) {
  const lines = [];
  const focus = LANES.includes(lane) ? lane : 'me';
  lines.push(...rubricPreamble(focus));
  lines.push('');
  lines.push(`## 被审的对话：Codex${activity.cwd.length > 0 ? ` · ${activity.cwd}` : ''}`);
  lines.push(`## 【审我】用户说过的话（主体：${LANE_SUBJECT.me}，最早→最新）`);
  if (activity.asks.length > 0) for (const ask of activity.asks) lines.push(`- ${ask}`);
  else lines.push('（这条对话里用户一句话都没说 —— 「具体对话」里如实写「用户没说话」）');
  lines.push('');
  lines.push(`## 【审 Agent】对面 AI 说过的话（主体：${LANE_SUBJECT.agent}，最早→最新）`);
  if (activity.notes.length > 0) for (const note of activity.notes) lines.push(`- ${note}`);
  else lines.push('（这段窗口里没有读到对面的回答）');
  lines.push('');
  lines.push(`## 【审对话】整条往返：就是上面两段的合起来（主体：${LANE_SUBJECT.conversation}）`);
  lines.push('');
  lines.push('## 背景：对面 AI 实际执行的动作');
  for (const cmd of activity.commands.slice(-8)) lines.push(`- 命令 ${cmd}`);
  for (const failure of activity.failures.slice(-4)) lines.push(`- 失败 ${failure}`);
  lines.push('');
  lines.push(...formatBlockLines());
  return lines.join('\n');
}

/**
 * 渲染**面板按钮 / A 路**的复审提示词 —— 材料来自 {@link conversationEvidence}
 * （Codex / DSH 会话）或 `evidenceFromEvents`（当前会话的内存快照）。
 *
 * 为什么不用 `renderLanePrompt`：那个读的是 Codex rollout 的活动形状
 * （`asks` / `notes` / `commands` / `failures`），而面板选中的可能是一条
 * **DSH 会话**，甚至是**当前会话自己**（它的日志可能还没落盘）。这里只认
 * `{title, cwd, youSaid, otherSaid, background}` —— 与 `conversationEvidence`
 * 同形状的那份材料，两条来源共用。
 *
 * 与监控路**只共享判据的形状**：开头用 `rubricPreamble()`、尾巴用
 * `formatBlockLines()`，两处都指向 `rubric.js`，所以判据不会因为多一条派单路而漂。
 * @param {object} evidence - `{title, cwd, youSaid, otherSaid, background, stats}`。
 * @param {string} lane - 本次点选的线。
 * @returns {string} 提示词。
 */
function renderEvidencePrompt(evidence, lane) {
  const lines = [];
  const focus = LANES.includes(lane) ? lane : 'me';
  const title = String(evidence?.title ?? '（未命名对话）');
  const cwd = String(evidence?.cwd ?? '');
  const youSaid = Array.isArray(evidence?.youSaid) ? evidence.youSaid : [];
  const otherSaid = Array.isArray(evidence?.otherSaid) ? evidence.otherSaid : [];
  const background = Array.isArray(evidence?.background) ? evidence.background : [];
  lines.push(...rubricPreamble(focus));
  lines.push('');
  lines.push(`## 被审的对话：${title}${cwd.length > 0 ? ` · ${cwd}` : ''}${typeof evidence?.stats === 'string' && evidence.stats.length > 0 ? `（${evidence.stats}）` : ''}`);
  lines.push(`## 【审我】用户说过的话（主体：${LANE_SUBJECT.me}，最早→最新）`);
  if (youSaid.length > 0) for (const ask of youSaid) lines.push(`- ${ask}`);
  else lines.push('（这条对话里用户一句话都没说 —— 「具体对话」里如实写「用户没说话」）');
  lines.push('');
  lines.push(`## 【审 Agent】对面 AI 说过的话（主体：${LANE_SUBJECT.agent}，最早→最新）`);
  if (otherSaid.length > 0) for (const note of otherSaid) lines.push(`- ${note}`);
  else lines.push('（这段窗口里没有读到对面的回答）');
  lines.push('');
  lines.push(`## 【审对话】整条往返：就是上面两段的合起来（主体：${LANE_SUBJECT.conversation}）`);
  lines.push('');
  lines.push('## 背景：对面 AI 实际执行的动作');
  for (const item of background.slice(-12)) lines.push(`- ${item}`);
  lines.push('');
  lines.push(...formatBlockLines());
  return lines.join('\n');
}

/**
 * 解析复审的结论：领先行 + 四段自适应分析。
 *
 * 先借 `parseVerdict` 拿到共用的受众路由与原文（raw），再把 `rubric.js` 的
 * {@link parseAnalysis} 折出来的四段盖上去。**段落形状由代码保证**（四个锚点，
 * 条数不固定），模型多写一段、漏写一段都不会让形状变样。
 * 受众路由不再来自「给用户的话 / 给 Agent 的话」两段，而是从**建议**里的
 * `[标签]` 抽（{@link routeAdvice}）—— 建议本来就要求具体到人，所以标签放这儿更自然。
 * @param {string} text - 复审输出（可以是流式的一半）。
 * @param {number} turn - 轮次。
 * @param {string} lane - 本次点选的线。
 * @returns {object} 结论（带 `lane` 与四个段落）。
 */
function parseAnalysisVerdict(text, turn, lane) {
  const parsed = parseVerdict(text, turn);
  const analysis = parseAnalysis(text);
  const focus = LANES.includes(lane) ? lane : 'me';
  const routed = routeAdvice(analysis.advice);
  return {
    ...parsed,
    lane: focus,
    sections: ANALYSIS_SECTIONS,
    verdict: normalizeVerdict(analysis.verdict),
    headline: leadingLine(analysis),
    dialog: analysis.dialog,
    summary: analysis.summary,
    analysis: analysis.analysis,
    advice: analysis.advice,
    // 受众路由：模型在建议上标了 `[指令]/[证据]` 之类的标签就按闭集分派；
    // 没标的两边都算（untagged 会计数，和旧规则一致）。
    forUser: routed.forUser.length > 0 ? routed.forUser : parsed.forUser,
    forAgent: routed.forAgent.length > 0 ? routed.forAgent : parsed.forAgent,
    untagged: routed.untagged,
  };
}

/**
 * 读出**这条会话真正的模型配置**（provider / model / reasoningEffort）。
 *
 * 为什么必须显式读出来（**真发生过的失败**）：用户重启 DSH 后点面板按钮，会话里出现
 * `llm-deepseek: no API key for provider route "deepseek-official" … MISSING_CREDENTIAL`，
 * 而**主对话本身是通的** —— 两条路走了不同的 provider route：
 *   - 主对话：`deepseek-account`（账号凭据，能用）；
 *   - 新会话的创建默认：`deepseek-official`（要裸 `DEEPSEEK_API_KEY`，本机没有）。
 * 复审员是 `spawn` 子 Agent，spawn **按构造继承父 Agent 的路由**
 * （shipped 源码 `dsh-subagent/lib/types/child-agent.js` 的 `resolveChildAgentOptions`，
 * 以及同包 `lib/index.js:414-424` 的 `parentAgentOptionsForDelegation` ——
 * 它读的正是 `session.requestHeader()?.config`），所以父会话一旦是
 * `deepseek-official`，复审就必然 `MISSING_CREDENTIAL`。
 *
 * 用户的要求是「**主对话用什么，审核用什么；模型配置一样，就是上下文不一样**」，
 * 所以这里把那条会话的模型选择显式交给子 Agent（`agentOptions` 是 spawn provider
 * 声明支持的能力，`dsh-subagent/lib/index.js` 的 `assertCapabilities` 校验它）。
 * **只共享模型配置**：上下文仍然是子 Agent 自己的（prompt/parent 一个字节都不动）。
 *
 * 读法照抄 shipped：先 `session.requestHeader()?.config`（请求头一旦写过就以它为准），
 * 再退回会话创建选项 `agent.options`（`requestHeader` 在第一次请求之前是 undefined）。
 * 两边都读不到时**返回 undefined，宁可不传也不编一条错的路由**。
 * @param {object} agent - 被复审的会话对应 Agent。
 * @returns {{provider: string, model: string, reasoningEffort?: string}|undefined} 模型选择。
 */
function reviewerModelSelection(agent) {
  const pick = (source) => {
    if (source === null || typeof source !== 'object') return undefined;
    const provider = typeof source.provider === 'string' && source.provider.length > 0 ? source.provider : undefined;
    const model = typeof source.model === 'string' && source.model.length > 0 ? source.model : undefined;
    if (provider === undefined || model === undefined) return undefined;
    const effort = typeof source.reasoningEffort === 'string' && source.reasoningEffort.length > 0 ? source.reasoningEffort : undefined;
    return { provider, model, ...effort === undefined ? {} : { reasoningEffort: effort } };
  };
  try {
    const logged = pick(agent?.session?.requestHeader?.()?.config);
    if (logged !== undefined) return logged;
  } catch { /* 读不到就退回创建选项 */ }
  try {
    return pick(agent?.options);
  } catch {
    return undefined;
  }
}

/**
 * 从一条 `turn/end` 事件里取出「这一轮失败了没有」。
 *
 * 判据与 shipped 客户端**逐字相同**（两边必须看到同一件事，否则又是灯在说谎）：
 * `dsh-client-ui-chat/lib/client.js` 的 `failureFrom()`（该文件 `:9819-9836`）读
 * `event.data.reason`，只有当 `reason.kind === 'error'` 时取 `reason.error`
 * 的 `message` / `code` —— 就是它把 `MISSING_CREDENTIAL` 渲染成
 * 「本轮运行失败」那一行（同文件 `:1287-1306` 的 `TurnErrorItem`，
 * 文案在 `:5526` `"message.turnError": "本轮运行失败"`）。
 *
 * `turn/end` 由 `dsh-agent-loop/lib/index.js:1017-1030` 发出：
 * 失败时 `reason = {kind:'error', error: LlmError.failure ?? {message, code:'UNKNOWN'}}`。
 * @param {object} event - 一条会话事件。
 * @returns {object|null} `{at, turn, code, message}`，或 null（这一轮没失败）。
 */
function failureOfTurnEnd(event) {
  if (event?.type !== 'turn/end') return null;
  const reason = event.data?.reason;
  if (reason?.kind !== 'error') return null;
  const failure = reason.error ?? {};
  return {
    at: Number.isFinite(event.time) ? event.time : Date.now(),
    turn: Number(event.data?.turn ?? 0),
    code: typeof failure.code === 'string' && failure.code.length > 0 ? failure.code : 'UNKNOWN',
    message: String(failure.message ?? '').slice(0, 240),
  };
}

/**
 * 时钟容差：`turn/end` 的 `time` 比本进程的 `startedAt` 早**几毫秒**仍然算当前。
 *
 * 为什么需要它：`startedAt` 是插件 `apply()` 那一刻记的，而真实跑完一轮的时间戳
 * 可能就在它前一瞬（测试夹具、重启后第一条事件、时钟粒度）。没有容差的话，
 * 一次**刚刚发生**的失败会被误判成「上一个进程的旧账」——那就从「拿旧账冒充当前」
 * 翻到了反面的「把当前失败藏起来」，同样是在骗人。2 秒足够盖住这些边界，
 * 又远远小于用户现场那条 6148 秒（≈1.7 小时）的旧失败。
 */
const TURN_FAILURE_CLOCK_TOLERANCE_MS = 2000;

/**
 * 把折出来的 `turn/end` 结论分成**当前**与**历史**两档。
 *
 * 会话日志是重启后从盘上恢复回来的，所以 `turnOutcome` 既可能是本进程刚跑的轮次，
 * 也可能是**上一个进程**留下的旧账。只有前者能驱动「跑不起来」这一态；
 * 后者仍然是事实，作为 `history` 如实报出（**不隐藏**），但绝不当成当前状态。
 *
 * 范围取「本进程」而不是「本会话」或「固定时间窗」，理由：
 *   - 本会话的范围太大 —— 会话可以活好几个进程、好几天，把上个进程的失败算进来
 *     正是用户读到的那句假话；
 *   - 固定时间窗（比如 30 分钟）会引入第二种谎：本进程里 31 分钟前真的失败过、
 *     之后一次都没跑，它却报绿；
 *   - 「本进程」正好是「这一份代码、这一批内存状态」的生命周期，也是版本戳那一行
 *     已经在报的事实，用户能对上。
 * @param {object|null} failure - `liveness.turnOutcome`。
 * @param {number|null} startedAt - 本进程加载插件的时间戳。
 * @param {number} now - 现在。
 * @returns {{current: object|null, history: object|null}} 两档。
 */
function splitTurnOutcome(failure, startedAt, now) {
  if (failure === null || typeof failure !== 'object') return { current: null, history: null };
  const at = Number.isFinite(failure.at) ? failure.at : null;
  const inProcess = at !== null && (startedAt === null || at >= startedAt - TURN_FAILURE_CLOCK_TOLERANCE_MS);
  const shaped = {
    failed: true,
    code: String(failure.code ?? 'UNKNOWN'),
    message: String(failure.message ?? ''),
    at,
    ageMs: at === null ? null : Math.max(0, now - at),
    turn: Number.isFinite(failure.turn) ? failure.turn : null,
  };
  if (inProcess) return { current: shaped, history: null };
  // 旧账：明说它属于**上一个进程**（`stale:true`），面板据此换一句话说它。
  return { current: null, history: { ...shaped, stale: true } };
}

/**
 * 折一次会话事件日志，把「最近一次真实的 `turn/end` 结论」记进 `liveness`。
 *
 * 为什么不能靠 `agent/turn-stopping`：**失败的那一轮根本不发这个事件** ——
 * `dsh-agent-loop/lib/index.js:998-1004` 只在回合干净收尾时发 `turn-stopping`，
 * 而模型失败走的是同文件 `:1008-1034` 的 catch，直接落到 `turn/end`。
 * 所以只能在真正要报活性的时候按需折一次。
 *
 * 成本纪律（`ping` 必须**零成本**，见 `test/ping-test.mjs`）：
 *   - 只用**内存快照** `session.snapshotEvents()`（`dsh-session/lib/index.js:1376-1382`
 *     读的是已经冻结在内存里的 `this.log`，**不碰文件系统**）；
 *   - 从上次折到的位置往后扫，所以每次的代价是「新增几条就折几条」；
 *   - 折出来的只是 `{at, turn, code, message}` —— **不进对话记录、不投递、不唤醒**。
 * @param {object} agent - 要折的 Agent（可以是 undefined）。
 * @param {object} liveness - 宿主活性记录。
 * @returns {void}
 */
function noteTurnOutcome(agent, liveness) {
  if (liveness === null || typeof liveness !== 'object') return;
  try {
    const session = agent?.session;
    if (session === undefined || session === null) return;
    const events = session.snapshotEvents();
    if (!Array.isArray(events)) return;
    const from = Number.isFinite(liveness.outcomeFoldAt) ? liveness.outcomeFoldAt : 0;
    for (let i = Math.max(0, from); i < events.length; i += 1) {
      const event = events[i];
      // 只有**收口的那一条**才改结论：一轮成功会把上一轮的失败清掉，
      // 否则一个历史错误会把灯永久钉红（那又是另一种说谎）。
      if (event?.type === 'turn/end') liveness.turnOutcome = failureOfTurnEnd(event);
    }
    liveness.outcomeFoldAt = events.length;
  } catch { /* 折不出来就说「不知道」，绝不因为活性统计把宿主搞挂 */ }
}

/**
 * 复审子 Agent 的工具面：**一个都不给**。
 *
 * 复审员的活是**照提示词里已经嵌好的证据写四段自适应分析**：不读文件、不搜、不调任何东西。
 * 所以它的过滤器必须**填成空 allow**，而不是写某个工具名 —— 随手抄一个名字进来就是
 * 2026-10 那次现场失败：`index.js` 两个派单点都写了 `{ allow: ['read'] }`，
 * 而 `read` 在这个预设里根本不存在（真实的全局工具只有
 * `ask_user_question` / `list_conversations` / `load_workspace_dependencies` / `review_conversation`），
 * 于是 `tools.restrict()` 在准备子 Agent 时抛错、复审一次都没跑起来、面板停在「0 条」。
 *
 * 形状为什么是 `{ allow: [] }`（判据都是 shipped 源码 + `test/tool-filter-test.mjs` 用真
 * `ToolRuntime` 跑出来的）：
 *   - **省略 `toolFilter` 不是「没有工具」**：`@deepseek-ai/dsh-subagent/lib/index.js:522`
 *     是 `if (composition.toolFilter !== void 0) childCtx.tools.restrict(composition.toolFilter);`
 *     —— 键不在就一次 `restrict` 都不调，子 Agent 照样继承父预设的工具面。
 *   - `{}`（allow/deny 都没有）直接抛：`@deepseek-ai/dsh-tools/lib/types/index.js:495-497`
 *     「tools.restrict({}) is a no-op」。
 *   - `{ allow: [] }` 合法且**真的收干净**：同文件 `:188-195` 的 `admits()` 对每个继承来的
 *     名字都判 `allow.has(name) === false` → 全部不可见；`:546-556` 又说明过滤器只作用于
 *     **继承**来的那一层、不动子 Agent 自己那一层，所以不会顺手砍掉它的结构化输出机制。
 *
 * **两个派单点（{@link runReview} 的轮收尾、{@link runDirectedReview} 的面板 / A 路）必须共用这一个**
 * —— 否则又会像那次一样只改一条、漏掉另一条。
 * @returns {{allow: string[]}} 空 allow 过滤器（每次给一份新对象，不共享可变状态）。
 */
export function reviewerToolFilter() {
  return { allow: [] };
}

/**
 * 复审派单的公共选项：**上下文不共享，模型配置共享**。
 *
 * 两个派单点（轮收尾的 `runReview`、Codex 监控的 `watchOnce`）都用它，免得只修一条、
 * 漏掉另一条 —— 那种漏法在 2026-10 真发生过一次。
 * @param {object} agent - 被复审（或触发面板命令）的会话对应 Agent。
 * @param {object} [liveness] - 宿主活性记录；面板命令里**主对话**的模型选择记在它上面。
 * @returns {object} 要么 `{}`（读不到，不猜），要么 `{agentOptions:{provider,model,…}}`。
 */
function reviewerAgentOptions(agent, liveness) {
  // 面板命令那一路：命令是**主对话自己**发出来的，所以它的模型选择比监控器
  // `agents.list()` 里挑出来的那条更权威 —— 用户点的就是当前这条会话。
  // 优先级：主对话（面板命令记下的）> 被复审的那条 > 不传。
  const recorded = liveness !== null && typeof liveness === 'object' ? liveness.modelSelection : undefined;
  const selection = (recorded !== undefined && recorded !== null ? recorded : undefined)
    ?? reviewerModelSelection(agent);
  if (selection === undefined || selection === null) return {};
  return { agentOptions: { ...selection } };
}

/**
 * 跑一次独立复审，并把结论作为通知注入主 Agent。
 * @param {object} ctx - 宿主插件上下文。
 * @param {object} cfg - 已规范化的配置。
 * @param {object} agent - 被复审的主 Agent。
 * @param {number} turn - 轮次。
 * @param {Map<object, AbortController>} inflight - 在飞的复审表。
 * @param {object} [liveness] - 宿主活性记录（面板命令记下的主对话模型选择在里面）。
 * @returns {Promise<void>} 复审结束后兑现。
 */
async function runReview(ctx, cfg, agent, turn, inflight, liveness) {
  const controller = new AbortController();
  inflight.set(agent, controller);
  const timer = setTimeout(() => {
    controller.abort(new Error(`review timed out after ${cfg.reviewTimeoutMs}ms`));
  }, cfg.reviewTimeoutMs);
  try {
    const progress = readProgress(ctx, agent);
    const session = buildSessionDigest(agent, turn, cfg.eventScanLimit, progress);
    const codex = buildCodexDigest(cfg);
    const prompt = renderPrompt({ session, codex, turn, budget: cfg.digestBudgetChars });
    if (controller.signal.aborted) return;
    const run = await ctx.subagents.start(cfg.provider, {
      label: `冷静审核 · 第 ${turn} 轮`,
      prompt: [{ type: 'text', text: prompt.text }],
      parent: agent,
      signal: controller.signal,
      // 复审员零工具：拿着 digest 判断，不需要写权限，也不该顺手改东西，更不该去读文件。
      toolFilter: reviewerToolFilter(),
      // **模型配置和主对话一样**（用户原话「主对话用什么，审核用什么」）；
      // 上下文不共享 —— prompt / parent 仍然只属于这个子 Agent。
      ...reviewerAgentOptions(agent, liveness),
    });
    try {
      const result = await run.result;
      const text = contentText(result?.output) || String(result?.diagnostic ?? '');
      if (text.trim().length === 0) {
        ctx.logger.warn(`review-mode: turn ${turn} produced an empty review`);
        return;
      }
      deliver(ctx, agent, {
        ...parseVerdict(text, turn),
        // 这次复审实际喂了多少字符 —— 等于这次复审的输入成本，状态条会显示它。
        digestChars: prompt.digestChars,
        dropped: prompt.dropped,
      });
    } finally {
      await run.dispose().catch(() => {});
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      ctx.logger.warn(`review-mode: review of turn ${turn} failed: ${errorText(error)}`);
    }
  } finally {
    clearTimeout(timer);
    if (inflight.get(agent) === controller) inflight.delete(agent);
  }
}

/**
 * 「审你自己」这一路要的材料：**当前这个会话**。
 *
 * 用 `agent.session.snapshotEvents()`（内存快照）而不是 `~/.dsh/sessions` 里的日志：
 * 刚建的会话可能还没落盘，而用户点的就是「你和 DSH 的这个会话」。
 * @param {object} agent - 审核会话的 Agent。
 * @param {string} lane - 审核线。
 * @returns {object} `{lane, promptText, label}`。
 */
function selfReviewJob(agent, lane) {
  const events = (() => {
    try { return agent?.session?.snapshotEvents() ?? []; } catch { return []; }
  })();
  const evidence = evidenceFromEvents(events, lane);
  return {
    lane,
    promptText: renderEvidencePrompt(evidence, lane),
    label: `审核 · ${LANE_LABELS[lane] ?? '审我'} · 本会话`,
  };
}

/**
 * `dir <self|dsh|codex>`：给目录，**并且**（只有 `self`）立刻派一次复审。
 *
 * 改前的做法（**真发生过的现场失败**）：宿主 `agent.followup(提示词)` 唤醒主 Agent
 * 去做复审 —— 结果整张表长在对话里，面板一直空着。现在复审**由宿主自己派**
 * （`startReview` → `runDirectedReview`，和监控器同一条管线），结果折进投影，
 * 面板渲染；对话区只负责「用户问、Agent 答」。
 *
 * `dsh` / `codex` 这一层只是目录：用户还要在里面点一条，所以复审发生在 `pick`。
 * @param {string} kindArg - `self` / `dsh` / `codex`。
 * @param {function} [startReview] - 宿主注入的点火器（不阻塞 handler）。
 * @returns {object} 命令结果（`text` 是目录 JSON，客户端解析后自己画）。
 */
function panelDir(agent, kindArg, startReview) {
  const kind = TARGET_KINDS.includes(kindArg) ? kindArg : 'codex';
  if (kind === 'self') {
    const lane = LANES.includes(currentTarget()?.lane) ? currentTarget().lane : 'me';
    const events = agent?.session?.snapshotEvents?.() ?? [];
    const evidence = evidenceFromEvents(events, lane);
    setTarget({ kind: 'self', id: String(agent?.id ?? agent?.session?.header?.id ?? ''), title: evidence.title, lane });
    if (typeof startReview === 'function') startReview(selfReviewJob(agent, lane));
    return { kind: 'success', text: JSON.stringify({ kind, self: true, evidence, selected: currentTarget(), total: 0, recent: [], groups: [] }) };
  }
  const directory = buildTargets({ kind, limit: 200 });
  return { kind: 'success', text: JSON.stringify(directory) };
}

/**
 * `pick <kind> <id>`：记下目标 + **由宿主立刻派复审**（不再让主 Agent 去做）。
 *
 * 关键：这里调的是 `reviewer.js` 的 `setTarget()` —— 和 Agent 侧
 * `review_conversation` 工具写**同一份模块级状态**，所以面板点的和工具点的
 * 监控器读到的永远是一条。返回证据 JSON 给面板左栏。
 * @param {string} kindArg - `self` / `dsh` / `codex`。
 * @param {string} idArg - 对话 id。
 * @param {function} [startReview] - 宿主注入的点火器。
 * @returns {object} 命令结果（`text` 是 `{ok, evidence}` JSON）。
 */
function panelPick(kindArg, idArg, startReview) {
  const kind = TARGET_KINDS.includes(kindArg) ? kindArg : 'codex';
  const id = typeof idArg === 'string' ? idArg : '';
  if (id.length === 0) return { kind: 'error', text: 'pick 需要对话 id' };
  const lane = LANES.includes(currentTarget()?.lane) ? currentTarget().lane : 'me';
  const evidenceKind = kind === 'codex' ? 'codex' : 'dsh';
  let evidence;
  try {
    evidence = conversationEvidence(evidenceKind, id, lane);
  } catch (error) {
    return { kind: 'error', text: `取证据失败：${errorText(error).slice(0, 160)}` };
  }
  setTarget({ kind, id, title: evidence?.title ?? id, lane });
  if (typeof startReview === 'function') {
    startReview({
      lane,
      promptText: renderEvidencePrompt(evidence, lane),
      label: `审核 · ${LANE_LABELS[lane] ?? '审我'} · ${clip(evidence?.title ?? id, 40)}`,
    });
  }
  return { kind: 'success', text: JSON.stringify({ ok: true, evidence }) };
}

/**
 * `ask <question>`：针对**已有评价**提问 —— 在最近一张表的对应行里定位答案。
 * 回答走 `form:'qa'` 的投递（面板看得见、对话不渲染），与自动评价一眼可分。
 * @param {object} ctx - 宿主插件上下文。
 * @param {object} agent - 目标 Agent。
 * @param {string} question - 用户的问题。
 * @returns {object} 命令结果（`text` 就是回答）。
 */
function panelAsk(ctx, agent, question) {
  const text = String(question ?? '').trim();
  if (text.length === 0) return { kind: 'error', text: 'ask 需要问题' };
  if (agent === undefined || agent === null) return { kind: 'error', text: '没有活着的审核会话' };
  const last = lastReviewCard(ctx, agent);
  const answer = answerFromTable(text, last);
  /* 回答**以命令的同步回执为准**：面板拿到 `text` 就直接画在你打字的框下面，
   * 不依赖任何异步通道（bug 54：旧实现把回执丢掉，只指望面事件落地，于是
   * 「那条通道一断 = 屏幕上一个字都没有」）。
   *
   * 这里的投递仍然要做 —— 它让**模型**在下一个 step 看得到这条问答，
   * 也让它进 `reviewMode` 投影的 `feed`（流里那份正式记录）。
   * 但投递结果必须**如实反映**在日志里，不许再静默吞掉。 */
  let delivered = false;
  try {
    delivered = appendReviewSurface(agent, 'qa', {
      question: text,
      answer,
      lane: LANES.includes(currentTarget()?.lane) ? currentTarget().lane : 'me',
      turn: Number(last?.turn ?? 0),
      headline: String(last?.headline ?? ''),
    }, `问：${text}\n→ ${answer}`);
  } catch (error) {
    ctx.logger?.warn?.(`review-mode: 问答投递失败（回答仍然随命令回执回给面板）：${errorText(error).slice(0, 160)}`);
  }
  if (delivered !== true) {
    ctx.logger?.warn?.('review-mode: 问答没有走面事件（退化路径），面板改用命令回执显示这条回答');
  }
  return { kind: 'success', text: answer };
}

/**
 * `ping`：前端 → 宿主通道的**活性探测**。zero-cost 到苛刻：
 * **不调模型、不派子 Agent、不读 `~/.codex`、不写会话事件、不唤醒 Agent、不写 trace**。
 *
 * 只回一个**内存快照**（`liveness`），所以它几微秒就返回；面板据此判断
 * 「连接中 / 已连接 · 监控中 / 未连接」。事实来自监控器的最近一次真实 tick，
 * 不是 ping 现算的 —— 否则每 ping 一次就扫一遍盘，成本就回来了。
 *
 * 注意：**绝不 `await` 任何东西**。ping 一挂起，面板的 4 秒硬超时就说「未连接」，
 * 而其实通道是通的 —— 那就把「连接正常但宿主忙」误报成断线。
 * @param {object} liveness - 宿主侧的活性记录（在 `apply` 里创建）。
 * @returns {object} `{kind:'success', text}`，`text` 是活性快照 JSON。
 */
function panelPing(liveness) {
  const now = Date.now();
  const snapshot = liveness !== null && typeof liveness === 'object' ? liveness : {};
  const lastTickAt = Number.isFinite(snapshot.lastTickAt) ? snapshot.lastTickAt : null;
  const scanAt = Number.isFinite(snapshot.scanAt) ? snapshot.scanAt : null;
  // 「最近一次运行结果」按**本进程**分档：当前 / 历史（见 splitTurnOutcome）。
  const outcome = splitTurnOutcome(
    snapshot.turnOutcome,
    Number.isFinite(snapshot.startedAt) ? snapshot.startedAt : null,
    now,
  );
  return {
    kind: 'success',
    text: JSON.stringify({
      ok: true,
      pong: true,
      hostNow: now,
      // 监控器那一侧：最后一次 tick 是什么时候、间隔多少、已经 tick 了几次。
      tick: {
        enabled: snapshot.tickEnabled === true,
        intervalMs: Number.isFinite(snapshot.tickIntervalMs) ? snapshot.tickIntervalMs : null,
        lastAt: lastTickAt,
        ageMs: lastTickAt === null ? null : Math.max(0, now - lastTickAt),
        count: Number.isFinite(snapshot.tickCount) ? snapshot.tickCount : 0,
      },
      // 最近一次真实扫描的规模 —— 面板上「上次扫描 N 条对话」就是它。
      scan: {
        at: scanAt,
        ageMs: scanAt === null ? null : Math.max(0, now - scanAt),
        conversations: Number.isFinite(snapshot.conversations) ? snapshot.conversations : null,
        targetId: typeof snapshot.targetId === 'string' && snapshot.targetId.length > 0 ? snapshot.targetId : null,
      },
      busy: snapshot.busy === true,
      // 面板最近打过交道的那条会话（复审落点优先用它，见 `pickReviewParent`）。
      panelSessionId: typeof snapshot.panelSessionId === 'string' && snapshot.panelSessionId.length > 0
        ? snapshot.panelSessionId
        : null,
      selection: currentTarget(),
      uptimeMs: Number.isFinite(snapshot.startedAt) ? Math.max(0, now - snapshot.startedAt) : null,
      /* ── **版本戳**（2026-10-03 现场失败的止血）─────────────────────
       *
       * 面板底部要能写出 `宿主 15:12:03 · 进程 15:39:03`，让用户**一眼**看出
       * 「正在跑的这份代码」是不是比磁盘上的旧，而不是重启一次猜一次。
       * 全部是模块加载时算好的常量（`CODE_IDENTITY`）；`diskMtimeMs` 由监控 tick
       * 刷新，所以 **ping 一个字节都不读盘**（`test/ping-test.mjs` 的 fs 探针守着）。
       */
      identity: {
        processStartedAt: CODE_IDENTITY.processStartedAt,
        loadedAt: CODE_IDENTITY.loadedAt,
        checkedAt: CODE_IDENTITY.checkedAt,
        host: { ...CODE_IDENTITY.host },
        client: { ...CODE_IDENTITY.client },
      },
      /* ── **这一条是这次修复的核心** ────────────────────────────────
       *
       * 只回「通道答话了」是不够的：用户抓到的正是「灯是绿的、还在转，
       * 而模型调用因为 route 没凭据而失败」。所以 ping 必须同时回
       * **最近一次真实运行的结果**：
       *   `lastTurn` = **本进程**里最近一次 `turn/end` 的结论（null = 没失败 / 还没跑过）。
       * 判据与 shipped 客户端渲染「本轮运行失败」那条用的是同一条事件
       * （`dsh-client-ui-chat/lib/client.js` 的 `failureFrom()`，见 `failureOfTurnEnd`）。
       * 面板据此把状态降级成「已连接 · 跑不起来」——**不转圈、明说原因**。
       *
       * **范围**（2026-10 用户现场）：会话日志是重启后从盘上恢复的，里面还有
       * **上一个进程**的 `turn/end`。用户读到的那句
       * `通道是通的，但最近一次运行失败（6148 秒前）：developer/message turn must be
       * a non-negative safe integer · UNKNOWN` 就是拿旧账冒充当前状态。现在按
       * `startedAt` 分档（见 {@link splitTurnOutcome}）：
       *   - 本进程里的失败 → `lastTurn`（驱动「跑不起来」）；
       *   - 更早的失败 → `history`（`stale:true`），**照样报出来**，
       *     面板换一句「上一次运行 / 不在本进程」的话说它，不用 `fail` 冒充。
       */
      lastTurn: outcome.current,
      history: outcome.history,
    }),
  };
}

/**
 * 监控器复审的落点：**优先面板最近打过交道的那条会话**，否则退回列表里的第一条。
 *
 * 为什么需要它（bug 45 的最后一处）：面板只画「正在主栏显示」的那条审核会话，而监控器
 * 原来固定取 `agents.list()` 的第一条。同时开着两条审核会话时，监控器会把结论写进
 * 你看不见的那条 —— 面板又是空的（用户最老的那句：「现在你还是在审核面板那边还是什么都没有」）。
 *
 * `preferredId` 由 `runPanelCommand` 就地记下（面板每 20 秒一次心跳，所以面板开着时
 * 它就是当前在看的会话）。会话已经关掉 / 从没记过 → 原样退回 `targets[0]`。
 * @param {object[]} targets - `shouldReview` 过滤后的审核会话。
 * @param {string|null} preferredId - 面板最近打过交道的会话 id。
 * @returns {object|undefined} 复审的 parent。
 */
function pickReviewParent(targets, preferredId) {
  const list = Array.isArray(targets) ? targets : [];
  if (typeof preferredId === 'string' && preferredId.length > 0) {
    const hit = list.find((agent) => agent?.id === preferredId);
    if (hit !== undefined) return hit;
  }
  return list[0];
}

/**
 * 面板会话命令的实现 —— `ctx.remote.commands.execute()` 落到这里。
 *
 * 命令名与语法见 `client.js` 的 `COMMAND` / `cmdLine`。**任何分支都不许抛**：
 * 抛出去就是一条 `command/done: error`，面板只会看到失败。
 * @param {object} ctx - 宿主插件上下文。
 * @param {object} agent - 命令的接收 Agent（审核会话自己）。
 * @param {string} rawInput - 命令名之后的原文。
 * @param {object} [liveness] - 宿主侧的活性记录，供 `ping` 回快照。
 * @param {object} [deps] - `{startReview}`：宿主注入的复审点火器。
 * @returns {object} `{kind:'success'|'error', text}`。
 */
function runPanelCommand(ctx, agent, rawInput, liveness, deps) {
  const parts = String(rawInput ?? '').trim().split(/\s+/).filter((part) => part.length > 0);
  const verb = parts[0] ?? '';
  try {
    // 面板命令就是**主对话自己的**动作，所以顺手记一件事实：这条会话的模型配置
    // —— 复审员要继承它（用户：「主对话用什么，审核用什么」）。放在这里是因为
    // `invocation.agent` 就是当前这条会话，比监控器 `agents.list()` 里挑的那条更准。
    if (liveness !== null && typeof liveness === 'object' && agent !== undefined && agent !== null) {
      const selection = reviewerModelSelection(agent);
      if (selection !== undefined) liveness.modelSelection = selection;
      // 面板在跟**哪条会话**打交道 —— 监控器的复审要落回同一份投影（bug 45）。
      liveness.panelSessionId = agent.id;
    }
    if (verb === 'ping') {
      // 心跳同时要回答「审核到底跑不跑得起来」：把最近一次 `turn/end` 的结论折进
      // 快照。**失败的那一轮不发 `agent/turn-stopping`**（见 `noteTurnOutcome`），
      // 所以只能在这里按需折；只读内存快照，零文件系统调用。
      noteTurnOutcome(agent, liveness);
      return panelPing(liveness);
    }
    if (verb === 'dir') return panelDir(agent, parts[1], deps?.startReview);
    if (verb === 'pick') return panelPick(parts[1], parts[2], deps?.startReview);
    if (verb === 'ask') return panelAsk(ctx, agent, parts.slice(1).join(' '));
    return { kind: 'error', text: `未知的面板动词：${verb || '(空)'}` };
  } catch (error) {
    return { kind: 'error', text: `面板指令失败：${errorText(error).slice(0, 160)}` };
  }
}

/**
 * 深度冻结一个对象图，同时放过 AbortSignal。
 *
 * 与 `@deepseek-ai/dsh-llm` 的 `createUserMessage` 内部行为一致；这里自己实现，
 * 是为了让本插件保持零第三方依赖（工作区安装的 bundle 解析不到 dsh 的包）。
 * @param {unknown} value - 待冻结的值。
 * @param {WeakSet<object>} [seen] - 已访问集合，用于打断环。
 * @returns {unknown} 同一个值。
 */
function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof AbortSignal) return value;
  if (seen.has(value)) return value;
  seen.add(value);
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key], seen);
  return value;
}

/**
 * 构造一条冻结的 user 角色消息。
 * @param {{content: object[], source: object}} input - 内容与来源标记。
 * @returns {object} 不可变消息。
 */
function createUserMessage(input) {
  return deepFreeze(structuredClone({ ...input, role: 'user', id: randomUUID() }));
}

/**
 * 把结论投递给父会话 —— 用 inject 的语义（**不唤醒**、不打断），
 * 但走**对话记录里看不见**的那条面事件（见 {@link appendReviewSurface}）。
 * @param {object} ctx - 宿主插件上下文。
 * @param {object} agent - 目标 Agent。
 * @param {object} verdict - 结构化结论。
 * @returns {boolean} 是否走了「对话里看不见」的那条路。
 */
function deliver(ctx, agent, verdict) {
  if (ctx.agents.get(agent.id) !== agent) { trace({ dropped: 'agent 已不在', id: String(agent.id) }); return false; }
  try {
    return appendReviewSurface(agent, 'notice', verdict, renderNotice(verdict));
  } catch (error) {
    ctx.logger.warn(`review-mode: could not deliver the review notice: ${errorText(error)}`);
    return false;
  }
}

/**
 * 投递一条复审内容 —— **面板看得见，对话记录里看不见**。
 *
 * 这条是这次改动的核心。以前用 `agent.inject(userMessage)`：那条消息会被 Agent
 * 在下一个 step 收进 `user/message` 面事件，于是**评价直接长在对话记录里**，
 * 而面板（读 `reviewMode` 投影）反而空着。用户的原话：
 * 「我希望的是就是你审核的结果……输出在下面（审核那边），上面的话，我提问了，
 * 你在回答我」。所以评价必须走一条「投影折得到、对话不渲染」的路。
 *
 * 选中的是 **`user/message` + 生产者自有的 `source.kind`**（不是 `developer/message`）。
 * 这是 2026-10 一次性修掉两个真失败之后的结论，判据全部来自 shipped 源码：
 *
 * **为什么不能用 `developer/message`（真发生过，面板的诚实活性行抓到）**
 *   它是**步事件**（step-scoped），必须带真实的 `turn`/`step`：
 *   - `dsh-session-format-v3-to-v4/lib/index.js:324`
 *     `sessionFormatCount(data[field], \`developer/message ${field}\`)` ——
 *     `turn`/`step` 缺失/非非负安全整数时抛出的正是面板上那句
 *     `developer/message turn must be a non-negative safe integer`；
 *   - 同文件 `:241` 的表（生命周期关系）写死「`system/message`、`developer/message`、
 *     `assistant/attempt` 必须 match an open turn and step」；实现是同文件
 *     `Relationships.accept` → `requireStep`（`:743` / `:735` 附近）。
 *   而我们的评价是**异步**产物（复审子 Agent 跑完、监控 tick），投递时**没有任何开着的 step**
 *   —— 实测（真 `restoreReleasedV4Artifact`）：补上 turn/step 也仍然报
 *   `developer/message does not match an open turn and step`。
 *   即：这条事件类型在结构上就不可能由插件在带外投放。继续传 `undefined` 只会让
 *   整个会话在下次读盘时被格式校验拒绝。
 *
 * **为什么 `user/message` 既合法、又不在对话流里显示、模型还看得到**
 *   1. 它是 5 个**面事件**之一，模型看得到：`dsh-session/lib/index.js:154-160`
 *      （SURFACE_EVENT_TYPES）；`user/message` 的 payload 就是消息本身
 *      （`{role,id,content,source}`），append 必须带 `surfaceOp:'append'`
 *      （`dsh-session/lib/types/surface.js` 的 `surfaceOpOf`）。
 *   2. **不是步事件**：`dsh-session-format-v3-to-v4/lib/index.js` 的 `STEP_EVENT_TYPES`
 *      只有 `system/message` / `developer/message` / `assistant/attempt`，所以
 *      `user/message` 没有 `turn`/`step` 要求（同文件 `assertV4DeveloperData:315-330`
 *      只对 `developer/message` 校验 turn/step）。
 *   3. 只要求 `source.kind` 是**生产者自有**且非空、且不等于 `"plugin"`：
 *      同文件 `source()`（`:125-128`）。我们的 `source.kind = 'review-mode'`。
 *   4. **对话记录里看不见**：`dsh-client-ui-chat/lib/client.js:9267-9297`
 *      的 `messageDefinition.start` —— 只要 `event.data.source.kind !== "user"`，
 *      节点就是 `contextMessage` → `kind:'context'`（同文件 `:9251-9261`）；
 *      而 `:7719` 的 `isVisibleChatNode` 明确排除 `kind === "context"`
 *      （除非内容带 `tool-addition`/`tool-removal` 块，我们没有）。
 *      所以「投 `user/message` 就会出现在对话里」只对 `source.kind === "user"` 成立。
 *   5. 我们的投影照折：`applyEvent` 的 `user/message` 分支只认 `source.kind === SOURCE_KIND`。
 *
 * 会话没有 `append`（测试替身 / 老宿主上下文）时**退回 `agent.inject`** ——
 * 那条路会让评价出现在对话里，但功能不丢。返回 true 表示走了非对话可见的路。
 * @param {object} agent - 目标 Agent。
 * @param {string} form - `notice` / `stream` / `qa` / `panel`。
 * @param {object} review - 投影要折的负载。
 * @param {string} text - 模型会读到的正文。
 * @returns {boolean} 是否走了非对话可见的那条路。
 */
function appendReviewSurface(agent, form, review, text) {
  const message = createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: SOURCE_KIND,
      form,
      summary: form === 'stream'
        ? `复审流式 · ${LANE_LABELS[review?.lane] ?? ''}`
        : `冷静审核 ${review?.verdict ?? ''} · 第 ${review?.turn ?? 0} 轮`,
      review,
    },
  });
  const session = agent?.session;
  if (typeof session?.append === 'function') {
    try {
      // `user/message` 的 payload 就是消息本身（不像 developer/message 要包在 `message` 里）。
      session.append('user/message', message, { surfaceOp: 'append' });
      trace({ deliver: 'user-message', form, seq: Number(session.seq ?? 0) });
      return true;
    } catch (error) {
      // 面事件被拒（比如恰好撞上并发的替换）不能让复审内容丢掉 —— 退回 inject。
      trace({ deliver: 'user-message-failed', form, why: errorText(error).slice(0, 140) });
    }
  }
  agent.inject(message);
  trace({ deliver: 'inject(transcript-visible)', form });
  return false;
}

/**
 * 投递一条**进度**（`pending` / `failed`）—— 和 {@link appendReviewSurface} 同一条
 * `developer/message` 面事件路，但**绝不退回 `agent.inject`**。
 *
 * 为什么单独一个函数：`appendReviewSurface` 的 fallback 是为了「结论不能丢」；
 * 进度提示没有这个必要 —— 它一旦落进 `user/message` 就会显示在对话记录里，
 * 而这次改动要求「上面只有你问我答」。所以宿主会话不支持面事件时，直接不投。
 * @param {object} agent - 目标 Agent。
 * @param {string} form - `pending` / `failed`。
 * @param {object} review - 投影要折的负载。
 * @param {string} text - 模型会读到的正文（一句话）。
 * @returns {boolean} 是否真的 append 成功。
 */
function appendReviewSurfaceOnly(agent, form, review, text) {
  const session = agent?.session;
  if (typeof session?.append !== 'function') return false;
  const message = createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: SOURCE_KIND,
      form,
      summary: form === 'pending' ? '冷静审核 · 复审进行中' : '冷静审核 · 复审失败',
      review,
    },
  });
  session.append('user/message', message, { surfaceOp: 'append' });
  trace({ deliver: 'user-message', form });
  return true;
}

// 给 `test/surface-test.mjs` 复用：用**真的 `Session` 类**验证这条投递真的被
// 面事件校验接受、真的对模型可见。只加具名导出，不改这个模块作为插件的行为
// （Loader 仍然只看 name/inject/apply）。
export { appendReviewSurface, applyEvent, pickReviewParent };
