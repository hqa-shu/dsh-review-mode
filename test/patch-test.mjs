/**
 * 声明层自检：**入口唯一化之后**（2026-10 用户批准「OK，你先这样改」），
 * 预设应当满足：
 *   1. 入口是面板那三个方块；开场不许再让主 Agent 去点方向、列候选；
 *   2. 主 Agent **不**输出那张固定表格 —— 复审由宿主的子 Agent 做，只落在面板；
 *   3. 官方 `@deepseek-ai/dsh-tool-ask-user` 仍然挂着（用户用文字问、需要确认哪一条时
 *      Agent 还能用它），但**不再**是开场入口；
 *   4. 收工具时**不能**把 `ask_user_question` 一起收掉。
 *
 * 同时看住两条硬约束：
 *   - `cordis.patch.yml` 必须正好两行（`preset-review`, `review-mode`），
 *     且用 node_modules 里的 js-yaml 能解析；
 *   - 预设 `order` 不能撞官方占用的 1/2/3/4。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

let failed = 0;
const check = (label, pass, extra = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
  if (!pass) failed += 1;
};

// ── cordis.patch.yml 的结构 ─────────────────────────────────
const text = fs.readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8');
let doc = null;
try { doc = yaml.load(text); } catch (error) {
  check('cordis.patch.yml 能被 js-yaml 解析', false, String(error.message));
}
if (doc !== null) {
  check('cordis.patch.yml 能被 js-yaml 解析', true);
  check('顶层是一个 insert 补丁', Array.isArray(doc) && doc.length === 1 && Array.isArray(doc[0].insert));
  const rows = doc[0].insert;
  check('正好两行', rows.length === 2, rows.map((row) => row.id).join(', '));
  check('两行的 id 是 preset-review 和 review-mode',
    rows[0].id === 'preset-review' && rows[1].id === 'review-mode');

  const preset = rows[0];
  const names = (preset.config?.plugins ?? []).map((plugin) => plugin.name);
  check('预设 order = 9（不撞官方的 1/2/3/4）', preset.config?.order === 9, String(preset.config?.order));
  check('预设装了官方提问工具 @deepseek-ai/dsh-tool-ask-user',
    names.includes('@deepseek-ai/dsh-tool-ask-user'));
  check('预设装了本包的 reviewer（两个工具）',
    names.includes('@local/dsh-review-mode/reviewer'));
  check('预设装了 persona 与 agent-instructions',
    names.includes('@deepseek-ai/dsh-persona') && names.includes('@deepseek-ai/dsh-agent-instructions'));
  check('预设没有挂任何干活工具（bash/fs/write…）',
    !names.some((name) => /-tool-(bash|pwsh|fs|fs-search|web|todo|skill|subagent)/.test(name)),
    names.join(', '));

  // persona：**入口唯一化**（2026-10 用户批准的改动）。
  //
  // 旧断言（本次删掉）要求 persona 里写「第一条回复只能是 ask_user_question」「把候选做成
  // 可点的选项」「输出格式：① 主题漂移 … + 固定表格」。**那三条现在都是错的**：
  //   · 开场再让主 Agent 去点方向 = 和面板重复的第二个入口（用户明确要求删）；
  //   · 让主 Agent 自己输出固定表格 = 评价长在对话里、面板空着（用户抓到的现场失败）。
  // 用户的新要求是「只留面板那三个方块；对话区最多一句话」，所以我把它反过来断言。
  const persona = (preset.config?.plugins ?? []).find((plugin) => plugin.id === 'persona');
  const suffix = String(persona?.config?.suffix ?? '');
  /** 判据：persona 不再要求主 Agent 输出那张固定表格。 */
  const noOutputTable = (text) => !text.includes('输出格式')
    && !/\|\s*① 主题漂移\s*\|/.test(text) && !/\|\s*建议\s*\|/.test(text);
  /** 判据：persona 不再要求开场用 ask_user_question 点选。 */
  const noAskOpening = (text) => !/第一条回复.{0,24}ask_user_question/.test(text)
    && !/把候选做成可点的选项/.test(text) && !/必须用 `ask_user_question` 把候选/.test(text);
  check('persona 说清入口是面板那三个方块',
    suffix.includes('入口') && suffix.includes('审你自己') && suffix.includes('审其它 DSH') && suffix.includes('审 Codex'));
  check('persona 要求开场只回一句话（不调工具、不问审谁）',
    /只回一句/.test(suffix) && /不要调用任何工具/.test(suffix) && /不要问我审谁|不要问用户/.test(suffix));
  check('persona 不再要求开场用 ask_user_question 做可点选项', noAskOpening(suffix));
  check('persona 不再要求主 Agent 输出那张固定表格', noOutputTable(suffix));
  check('persona 要求回复最多一句话、不要复现证据或表格',
    /最多回?一句话/.test(suffix) && /不要.{0,8}贴表格|不要.{0,8}复现证据/.test(suffix));
  check('persona 点名 review_conversation（用户用文字点名时要走它）', suffix.includes('review_conversation'));
  check('persona 保留了三条审核线与三个问题的定义（复审员要用的那套）',
    suffix.includes('① 主题漂移') && suffix.includes('② 局部纠结') && suffix.includes('③ 选择理性'));
  // 反向变异：把旧的「输出格式 + 固定表格」和「第一条回复只能是 ask_user_question」
  // 拼回去，上面两条判据必须立刻变红 —— 证明它们不是恒真。
  check('反向变异：把旧表格块拼回去，noOutputTable 必须变红',
    noOutputTable(suffix) === true
    && noOutputTable(`${suffix}\n输出格式：\n| ① 主题漂移 | a | b | c |\n| 建议 | x | y | z |`) === false);
  check('反向变异：把旧开场指令拼回去，noAskOpening 必须变红',
    noAskOpening(suffix) === true
    && noAskOpening(`${suffix}\n你的第一条回复只能是 ask_user_question，把候选做成可点的选项。`) === false);
}

// ── 工具面：提问工具不能被 restrict 收掉 ────────────────────
const mod = await import(new URL('../reviewer.js', import.meta.url).pathname);
let denied = null;
mod.apply({
  effect: (fn) => fn(),
  logger: { warn() {} },
  tools: {
    restrict: (spec) => { denied = spec?.deny ?? []; return () => {}; },
    register: () => {},
  },
});
check('reviewer 声明了要收掉的工具', Array.isArray(denied) && denied.length > 0, `${denied?.length ?? 0} 个`);
check('收工具清单里**没有** ask_user_question', Array.isArray(denied) && !denied.includes('ask_user_question'));

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
