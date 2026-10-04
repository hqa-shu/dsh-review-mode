/**
 * B 的证明：**宿主工具 `review_conversation` 记下用户选的那条。**
 *
 * 链路：原生可点选项（`ask_user_question`）→ Agent 调 `review_conversation`
 * → `setTarget()` 写共享状态 → `index.js` 的 Codex 监控器下次 tick 读
 * `currentTarget()` 就盯着这一条。这条链**不再需要远程 `select`**。
 *
 * 这个测试不需要重启应用：它直接跑 `reviewer.js` 的真代码，并用**真实的 ~/.codex 数据**。
 */

import { apply, currentTarget as reviewerCurrentTarget } from '../reviewer.js';
import { currentTarget as remoteCurrentTarget, setTarget as remoteSetTarget } from '../remote.js';

let failed = 0;
const check = (label, pass, extra = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
  if (!pass) failed += 1;
};

// 跑一遍预设行的 apply，把两个工具收下来。
const tools = new Map();
apply({
  effect: (fn) => fn(),
  logger: { warn() {} },
  tools: { restrict: () => () => {}, register: (def) => tools.set(def.name, def) },
});
const list = tools.get('list_conversations');
const review = tools.get('review_conversation');
check('两个工具都注册上了', list !== undefined && review !== undefined, [...tools.keys()].join(', '));

// 真实的 Codex 对话（读 3 条就够，避免测试读几十 MB）。
const listed = list.execute({ kind: 'codex', limit: 3 }).conversations;
check('list_conversations 从真实 ~/.codex 读到了候选', listed.length > 0, `→ ${listed.length} 条`);
const pick = listed[0];
check('候选带 id/kind/title', typeof pick?.id === 'string' && pick.kind === 'codex' && typeof pick.title === 'string');

// 工具执行 → 共享状态必须被写上。
const evidence = review.execute({ kind: pick.kind, id: pick.id });
const recorded = reviewerCurrentTarget();
check('review_conversation 之后 currentTarget() 记住了这条',
  recorded?.id === pick.id && recorded?.kind === 'codex',
  JSON.stringify(recorded));
check('记录带标题（取自取回的证据）', recorded?.title === evidence.title, `${recorded?.title}`);
check('记录带时间戳', Number.isFinite(recorded?.at) && recorded.at > 0, String(recorded?.at));

// remote.js 与 reviewer.js 必须是**同一份**状态 —— index.js 从 remote.js 读。
check('remote.js 的 currentTarget 与 reviewer.js 是同一份状态',
  remoteCurrentTarget() === reviewerCurrentTarget(),
  `id=${remoteCurrentTarget()?.id}`);
check('两个模块读到的 id 一致', remoteCurrentTarget()?.id === pick.id);

// remote.js 导出的 setTarget 也是同一份状态（留给面板那条路）。
const returned = remoteSetTarget({ kind: 'dsh', id: 'probe-target', title: '探针' });
check('remote.js 的 setTarget 也能写共享状态',
  returned?.id === 'probe-target' && reviewerCurrentTarget()?.id === 'probe-target',
  JSON.stringify(reviewerCurrentTarget()));
check('空 id 不覆盖原值', remoteSetTarget({ kind: 'dsh', id: '' })?.id === 'probe-target');

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
