/**
 * 「审核模式」的客户端：一个专为审核做的面板。
 *
 * 三个状态，**全程靠点，不打字**：
 *
 *   状态 1  选方向      [审你自己] [审其它 DSH] [审 Codex]
 *   状态 2  选对话      Codex 侧边栏式目录（项目 → 对话，最近动过的排最上）
 *   状态 3  看结论      左「问」= 你当时的原话，右「答」= ①②③ + 建议
 *
 * 数据从哪来：**一条宿主会话命令** `/review-mode <动词> …`，走
 * `ctx.remote.commands.execute(sessionId, line, [])`（见 `index.js` 的
 * `registerPanelCommand`，以及 `remote.js` 里被它复用的读盘逻辑）。
 * 选目录是**纯读文件、零模型** —— 这是省 token 的关键：点一下直接拿目录，
 * 不像以前那样把"列对话"绕模型转一圈（≈1857 token/轮）。
 *
 * 结论（含流式半成品）从 `reviewMode` 会话投影读，宿主用**非对话可见**的
 * `user/message` 面事件（`source.kind = 'review-mode'`）喂它 —— 客户端的
 * `isVisibleChatNode` 把 `source.kind !== 'user'` 的用户消息归成 `kind:'context'`
 * 并排除在对话流之外，所以评价只长在面板上、不落进对话记录（也不会像
 * `developer/message` 那样因为缺 `turn`/`step` 而被会话格式校验拒绝）。
 * 为什么不是我们自己的 `reviewRemote`：见 {@link commandService}。
 *
 * 约束：不 import 任何 Harness 客户端包，只依赖 react 与主题 token。
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-review-mode',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    /** 插件上下文（在 apply 里存下来，组件里调远程用）。 */
    let pluginCtx = null;

    /**
     * **这一页是什么时候加载的**（模块求值的那一刻）。
     *
     * 页面这一半也要有自己的版本戳（2026-10-03 现场失败：宿主和页面都可能是旧的）。
     * 浏览器读不到自己文件的 mtime，所以本页报**加载时间**；宿主把它磁盘上
     * client.js 的 mtime 一起报回来（`ping` 的 `identity.client.diskMtimeMs`），
     * 两者一比就能当场判定「这个页面跑的是旧代码，需要刷新」。
     * 测试可以用 `window.__reviewPageStartedAt` 把「页面是什么时候加载的」钉死。
     */
    const PAGE_STARTED_AT = (() => {
      try {
        const override = Number(globalThis.window?.__reviewPageStartedAt);
        if (Number.isFinite(override) && override > 0) return override;
      } catch { /* 用真实加载时间 */ }
      return Date.now();
    })();

    /** 版本戳的容差：相差不到半秒算同一次编辑（避免刚写完就报「要重启」）。 */
    const STAMP_TOLERANCE_MS = 500;

    /**
     * 远程调用的硬超时（毫秒）。
     *
     * 它不是替代品，只是安全网：万一某个命名空间在宿主侧没挂上，
     * `remote.targets(...)` 返回的 Promise **永不 settle、也不 reject**，
     * 面板就会永远停在「读目录…」。只有超时能把它变成一句人话。
     * 测试可以用 `window.__reviewRemoteTimeoutMs` 缩短它。
     */
    const REMOTE_TIMEOUT_MS = (() => {
      try {
        const override = Number(globalThis.window?.__reviewRemoteTimeoutMs);
        if (Number.isFinite(override) && override > 0) return override;
      } catch { /* 用默认 */ }
      return 4000;
    })();

    /** 读取一个可被测试覆盖的正数毫秒值。 */
    const msOverride = (key, fallback) => {
      try {
        const value = Number(globalThis.window?.[key]);
        if (Number.isFinite(value) && value > 0) return value;
      } catch { /* 用默认 */ }
      return fallback;
    };

    /**
     * **本地时钟**：每秒重画一次，只用来重算「上次成功心跳过去多久了」。
     * 它是纯本地的 —— 每 tick **不发任何宿主请求**（那正是「不能每帧 re-render」的反面）。
     */
    const LOCAL_TICK_MS = msOverride('__reviewLocalTickMs', 1000);

    /**
     * **真心跳的间隔**：几十秒一次，走已打通的 `commands` 通道调 `/review-mode ping`。
     * 不是每秒 —— 心跳要便宜到可以永远开着。
     */
    const PROBE_INTERVAL_MS = msOverride('__reviewProbeIntervalMs', 20000);

    /**
     * 心跳的**保鲜期**：最后一次成功超过它，面板就判定「未连接」并让转圈**消失**。
     * 依据是本地时钟，所以宿主机彻底没反应（promise 永不 settle 之外的情况，
     * 比如标签页被节流、通道悄悄断了）也能在几十秒内看出来。
     */
    const STALE_MS = msOverride('__reviewStaleMs', Math.round(PROBE_INTERVAL_MS * 2.5));

    /**
     * 转圈的动画**全部是 CSS**，不是 JS 逐帧改样式。
     *
     * 为什么必须是 CSS：面板是从 `reviewMode` 投影渲染的，用户不发消息时投影**根本不
     * 变化**，React 一次都不重画。若靠 `setInterval` + `setState` 每帧转角，转圈会在
     * 数据安静时停住 —— 那正好是用户最需要看到「它还活着」的时候。
     * CSS animation 由合成器独立推进，和 React 重画完全解耦。
     */
    const SPIN_CSS = [
      '@keyframes review-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }',
      '.review-mode-spin { animation: review-spin 1s linear infinite; }',
      '@media (prefers-reduced-motion: reduce) { .review-mode-spin { animation-duration: 3s; } }',
    ].join('\n');

    /**
     * 状态的名字与颜色（用户原话：「连接上那就在转，没有连接上就消失」）。
     * `spin:false` 就是「转圈不存在」—— 未连接 / 跑不起来时**不画**那个元素，
     * 而不是让它继续转。
     *
     * `fail` 是 2026-10 用户亲手抓到的那个谎补上的第四态：**通道是通的，但审核
     * 一次都跑不起来**（那次是 `deepseek-official` 这条 route 没有凭据，
     * 会话里写着「本轮运行失败 … MISSING_CREDENTIAL」）。这时灯绝不能是绿的、
     * 更不能转 —— 那会让人以为一切正常而根本不去查。
     */
    const LIVENESS = {
      first: { label: '连接中…', color: '--dsw-alias-label-secondary', spin: true, hint: '首次心跳还没回来' },
      ok: { label: '已连接 · 监控中', color: '--dsw-alias-state-success-primary', spin: true, hint: '' },
      fail: { label: '跑不起来 · 审核失败', color: '--dsw-alias-state-error-primary', spin: false, hint: '' },
      down: { label: '未连接', color: '--dsw-alias-state-error-primary', spin: false, hint: '' },
    };

    /**
     * 「有新结果」信号的存储键前缀 —— **唯一需要记的东西是「看过几条」**，
     * 而它是纯客户端的：`localStorage` 里按会话存一个数字。
     *
     * 为什么这样够（用户原话：「如果发现更新，他是不是有变一下提示一下，
     * 或者说一下最新的是啥」）：
     *   - 新评价已经折在 `reviewMode` 投影里了（`feed`），所以「有没有新的」=
     *     `feed 里评价条数 − 上次看过的条数`，**不需要任何宿主往返、不需要模型**；
     *   - 「看过」由三种真的看到的事件写回：点信号、展开面板、把结果区滚回顶部；
     *   - 写回 `localStorage` 所以刷新页面后还算数 —— 只是数字，没有内容外传。
     */
    const SEEN_KEY = 'review-seen';

    /**
     * **只读探测**一个服务名，永不抛、永不要求它存在。
     *
     * 这是「不改变行为地记录浏览器到底拿到了什么」的实现：
     *   - 首选 cordis 文档里的 `ctx.get('name')` —— 「Read a service from the store
     *     without the inject requirement」。shipped 客户端插件就是这么探测的：
     *     `dsh-client-ui-conversation/lib/client.js:14171` `ctx.get("productAnalytics")?.track(...)`。
     *   - 没有 `ctx.get`（测试替身 / 老上下文）才退回属性访问，**每个名字单独 try** ——
     *     cordis 对没 inject 的服务是抛异常，一个 throw 会吞掉整行诊断。
     * 它**不可能**影响启动：`undefined` 就是 `undefined`，不进 `inject`、不建依赖。
     * @param {string} name - 服务名，例如 `remote` / `remote.commands`。
     * @returns {{value: unknown, error: unknown}} 读到的值或错误。
     */
    function probeService(name) {
      if (typeof pluginCtx?.get === 'function') {
        try { return { value: pluginCtx.get(name), error: null }; } catch (error) { return { value: undefined, error }; }
      }
      try {
        const remote = pluginCtx?.remote;
        if (name === 'remote') return { value: remote, error: null };
        if (remote === undefined || remote === null) return { value: undefined, error: null };
        return { value: remote[name.slice('remote.'.length)], error: null };
      } catch (error) {
        return { value: undefined, error };
      }
    }

    /**
     * 面板上那一行诊断 —— 用户可以直接念出来报告：浏览器究竟看到了什么。
     * 有它就不需要开发者工具也能定位是哪一层断了。
     *
     * 现在的四个探针是有依据的：`remote` 本身有 shipped 源码证明
     * （`dsh-api-gateway/lib/client.js:1595` `super(ctx, "remote")`）；
     * `remote.commands` / `remote.agentPresets` 是官方客户端插件真实使用过的
     * **正对照**；`remote.reviewRemote` 是我们自己的命名空间，**预期永远是 undefined**
     * ——它就是当年把应用弄挂的那个名字。四个都只读，看一眼就知道是哪一层断的。
     * @returns {string} 一行诊断。
     */
    function diagnose() {
      const remote = probeService('remote');
      const commands = probeService('remote.commands');
      const presets = probeService('remote.agentPresets');
      const review = probeService('remote.reviewRemote');
      const has = (probe) => probe.value !== undefined && probe.value !== null;
      const base = `诊断 ctx.remote=${has(remote) ? '有' : '无'}`
        + ` · commands=${has(commands) ? '有' : '无'}`
        + ` · agentPresets=${has(presets) ? '有' : '无'}`
        + ` · reviewRemote=${has(review) ? '有' : '无'}`
        + ` · typeof=${typeof review.value}`;
      const failed = [remote, commands, presets, review].find((probe) => probe.error !== null && probe.error !== undefined);
      if (failed === undefined) return base;
      return `${base} · 取不到：${String(failed.error?.message ?? failed.error).slice(0, 70)}`;
    }

    /**
     * 给任意 Promise 加硬超时，并把三种结局（成功 / 报错 / 超时）折成同一个形状，
     * 调用方永远不用写 `.then().catch()` 去想「要是它不理我怎么办」。
     * @param {unknown} value - 远程方法返回的东西（可能是 thenable，也可能不是）。
     * @param {string} label - 方法名，只用于日志。
     * @returns {Promise<object>} `{status: 'ok'|'error'|'timeout', value?, error?}`。
     */
    function withTimeout(value, label) {
      return new Promise((resolve) => {
        let settled = false;
        const finish = (outcome) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(outcome);
        };
        const timer = setTimeout(() => {
          finish({ status: 'timeout', label, ms: REMOTE_TIMEOUT_MS });
        }, REMOTE_TIMEOUT_MS);
        Promise.resolve(value).then(
          (result) => finish({ status: 'ok', value: result }),
          (error) => finish({ status: 'error', error, label }),
        );
      });
    }

    /**
     * 取客户端能调的那个**宿主入口**：`remote.commands`。
     *
     * 为什么是它（而不是我们自己的 `reviewRemote`）：浏览器能调到的远程命名空间
     * 是**构建期写死的一份清单**，第三方插件补不进去。清单在
     * `@deepseek-ai/dsh-api-remotes/lib/client.js:13512` 起（25 个生成出来的贡献），
     * `commands.execute` / `commands.list` 在 `:4884-4942`。
     * 那行源码里 `inject = ["remote"]` 与固定数组就是证据。
     * @returns {object|undefined} `commands` 远程服务（可能 undefined）。
     */
    function commandService() {
      const probe = probeService('remote.commands');
      if (probe.value !== undefined && probe.value !== null) return probe.value;
      // 兜底：`ctx.get` 的隔离作用域理论上可能看不到这个命名空间服务，
      // 而属性访问能拿到。两条路都**不改变 inject**，所以都安全。
      try { return pluginCtx?.remote?.commands; } catch { return undefined; }
    }

    /**
     * 调一条**宿主会话命令** —— 面板唯一的前端→宿主通道。
     *
     * 参数形状直接照 shipped 客户端插件（`@deepseek-ai/dsh-client-ui-commands/lib/client.js:1069`）：
     *
     *     const result = await this.ctx.remote.commands.execute(session.sessionId, line, attachments);
     *
     * 返回值是一个结果信封：`{ok:true,value:{commandId,result:{kind,text}}}` /
     * `{ok:false,error:{code,message}}` / `{ok:true,value:undefined}`（未知命令）。
     * 命令不存在 / 抛错 / 超时**全都变成可显示的结果**，绝不把面板挂在那里。
     * @param {string} sessionId - 目标会话 id（审核会话自己）。
     * @param {string} line - 完整命令行，例如 `/review-mode dir codex`。
     * @returns {Promise<object>} {@link withTimeout} 的形状（或 `{status:'missing'}`）。
     */
    function callCommand(sessionId, line) {
      const commands = commandService();
      if (commands === undefined || commands === null || typeof commands.execute !== 'function') {
        return Promise.resolve({ status: 'missing', label: line });
      }
      let value;
      try { value = commands.execute(sessionId, line, []); } catch (error) { return Promise.resolve({ status: 'error', error, label: line }); }
      return withTimeout(value, line);
    }

    /**
     * 把一次命令调用的结局翻成 `{ok, text, why}`。
     * @param {object} outcome - {@link callCommand} 的结果。
     * @param {string} line - 原始命令行（报错时带上）。
     * @returns {{ok: boolean, text: string, why: string}} 结果。
     */
    function commandResult(outcome, line) {
      if (outcome.status !== 'ok') return { ok: false, text: '', why: remoteNote(outcome, '面板指令') };
      const envelope = outcome.value;
      if (envelope === null || typeof envelope !== 'object' || envelope.ok !== true) {
        return { ok: false, text: '', why: `面板指令被拒：${String(envelope?.error?.message ?? envelope?.error?.code ?? '未知错误').slice(0, 120)}` };
      }
      if (envelope.value === undefined) return { ok: false, text: '', why: `宿主不认识这条指令：${line}` };
      const result = envelope.value.result;
      if (result?.kind === 'error') return { ok: false, text: String(result.text ?? ''), why: String(result.text ?? '命令失败').slice(0, 120) };
      return { ok: true, text: String(result?.text ?? ''), why: '' };
    }

    /**
     * 把一次远程调用的结局翻译成面板上的一句短话。**绝不返回空**，
     * 否则界面就会退回「读目录…」那种卡住的样子。
     * @param {object} outcome - {@link callCommand} 的结果。
     * @param {string} what - 中文动作名，例如「读目录」。
     * @returns {string} 一句话。
     */
    function remoteNote(outcome, what) {
      if (outcome.status === 'timeout') {
        return `${what}超时：${outcome.ms} 毫秒没有返回，说明这条远程通道没打通。`
          + '改用对话里的可点选项选目标 —— 那条路走的是原生提问界面，不经过这里。';
      }
      if (outcome.status === 'missing') {
        return `远程服务不可用（${diagnose()}）。改用对话里的可点选项选目标。`;
      }
      if (outcome.status === 'error') {
        // 报错也要给出路：FLOW.md 第 11 步要求「任何远程调用…否则变成一句人话，
        // 并提示改用对话里的可点选项」。以前这里只丢一句原始报错，用户不知道还有那条路。
        return `${what}失败：${String(outcome.error?.message ?? outcome.error).slice(0, 120)}`
          + '。改用对话里的可点选项选目标 —— 那条路走的是原生提问界面，不经过这里。';
      }
      return `${what}返回了空结果。`;
    }

    /** 界面文案。 */
    const TEXT = {
      title: '审核',
      collapse: '收起',
      expand: '展开',
      lead: '选一个对话，我来审你 —— 只审你，不评它。',
      back: '← 返回',
      loading: '读目录…',
      evidence: '读证据…',
      empty: '这一类里没有可审的对话。',
      filter: '筛选原话…',
      noMatch: '没有匹配的原话。',
      qHead: '问 · 你当时说的话',
      aHead: '答 · 审核结论（具体对话 / 概述 / 分析 / 建议）',
      // **四态四句话，绝不互相冒充**（用户现场：空状态里写着「审核中…」一直不动，
      // 而评价其实写在上面 —— 用户分不清「还没开始」「正在跑」「失败了」「有结果」）。
      empty: '还没有评价 —— 点下面任一个方向，它会自己开始、自己长出来。',
      pending: '复审进行中…复审员正在写，结果只落在这一区（不在上面的对话里）。',
      failed: '复审没有完成 —— ',
      streaming: '生成中…',
      askPlaceholder: '旁边问一句（落在下面的流里）…',
      ask: '问',
      asked: '你问的',
      hint: '拖动左边缘可以调宽度',
    };

    /** 三个方向。 */
    const DIRECTIONS = [
      { label: '审你自己', note: '你和 DSH 的这个会话', kind: 'self' },
      { label: '审其它 DSH 会话', note: 'DSH 里别的历史会话', kind: 'dsh' },
      { label: '审 Codex 对话', note: '你在 ChatGPT 桌面版 / Codex 里的对话', kind: 'codex' },
    ];

    /**
     * 面板会话命令的命令名 —— 宿主在 `index.js` 里用**同一个名字**注册
     * （`ctx.inject(['commands'], scope => scope.commands.register({name: 'review-mode', …}))`）。
     */
    const COMMAND = 'review-mode';

    /**
     * 拼一条面板指令。动词表（宿主侧 `runPanelCommand` 实现）：
     *   - `dir <self|dsh|codex>`  用户点了方向 → 返回目录 JSON；`self` 还会由宿主立刻派复审；
     *   - `pick <kind> <id>`      用户点了某条对话 → 记下目标、开始复审、返回证据 JSON；
     *   - `ask <question>`        针对已有评价提问 → 返回回答文本。
     * @param {string} verb - 动词。
     * @param {...string} args - 参数。
     * @returns {string} 完整命令行。
     */
    const cmdLine = (verb, ...args) => `/${COMMAND} ${verb}${args.length === 0 ? '' : ` ${args.join(' ')}`}`.trim();

    /** 宿主用命令文本回传 JSON（目录 / 证据）；解析失败就是 null，调用方给一句人话。 */
    const parseJson = (text) => {
      try { return JSON.parse(String(text)); } catch { return null; }
    };

    /**
     * 段落表的**兜底**：正常路径上宿主会把 `rubric.js` 的 `ANALYSIS_SECTIONS`
     * 随卡片一起投过来（`record.sections`），客户端照它画。这里只是防止
     * 老卡片（这次改动之前落进会话日志的那种）没有 `sections` 时界面空掉。
     * **改判据不要改这里** —— 改 `rubric.js`。
     */
    const FALLBACK_SECTIONS = [
      { key: 'dialog', title: '具体对话' },
      { key: 'summary', title: '对话概述' },
      { key: 'analysis', title: '分析' },
      { key: 'advice', title: '建议' },
    ];

    /** 结论 → 颜色与中文。 */
    const VERDICT = {
      'on-track': { color: '--dsw-alias-state-success-primary', label: '未走偏' },
      drifting: { color: '--dsw-alias-state-warn-primary', label: '有漂移' },
      'off-track': { color: '--dsw-alias-state-error-primary', label: '已走偏' },
      unknown: { color: '--dsw-alias-state-idle-primary', label: '待确认' },
    };

    /* 面板是**右侧的一列**（`shell.overlay` 里固定右边），所以调的是**宽度**，
     * 不再是高度 —— 宽高两套常量都留在这里，读代码的人一眼能看出这次版式搬了家。 */
    const MIN_W = 260;
    const MAX_W = 720;
    const DEFAULT_W = 380;
    /** 面板最多占视口宽度的多少 —— 窄窗口下不许把对话列（含 composer）吃光。 */
    const MAX_RESERVE_RATIO = 0.45;

    /**
     * **预留一列**的 CSS（用户 2026-10：「界面直接覆盖在问答框上……很多都会被挡」）。
     *
     * 机制：shell 的 frame 是一个 CSS grid（`dsh-client-ui-layout/lib/client.js:320`
     * 的 `gridTemplateColumns: '<sidebar>px minmax(<rb>px,1fr) minmax(0px,<rbmax>px)'`），
     * 它的三个 track 都是**内容盒**里的。所以在 frame 上加一条 `padding-right`
     * 就等于在第 3 条 track 右边再留一条空 track —— 中间的 `1fr`（对话列 + composer + 发送键）
     * 会被**真的挤窄**，而不是被浮层盖住。`sidebar` 是固定 px track，不受影响。
     *
     * 为什么用 `!important`：frame 的 `grid-template-columns` 由 React 写在**行内 style**
     * 上，行内样式压过普通样式表规则；我们只加 `padding-right`（React 不动它），
     * 但为了在任何 React 重画之后都成立，仍然标 `!important`。
     * 为什么用 `box-sizing:border-box`：否则 padding 会把 frame 撑出视口。
     * 变量 `--review-reserved-w` 由下面那条 effect 写在 frame 自己身上。
     */
    const RESERVE_CSS = '[data-review-reserved]{box-sizing:border-box !important;'
      + 'padding-right:var(--review-reserved-w,0px) !important}';

    /** 一行小字。 */
    const line = (key, text, color, size) => h('div', {
      key,
      style: { color: `var(${color})`, fontSize: size ?? 12.5, lineHeight: '19px', wordBreak: 'break-word' },
    }, text);

    /* ── 渲染积木（模块作用域：状态 1/2 的常驻结果区和状态 3 的右栏共用）── */

    /** 「标签 + 内容」一行。 */
    function qaLine(key, label, value, color) {
      return h('div', { key, style: { display: 'flex', gap: 8, marginTop: 3 } }, [
        h('span', { key: 'l', style: { flex: 'none', width: 72, color: `var(${color})`, fontSize: 12 } }, label),
        h('span', {
          key: 'v',
          style: { color: 'var(--dsw-alias-label-primary)', fontSize: 12.5, lineHeight: '19px', wordBreak: 'break-word' },
        }, value),
      ]);
    }

    /**
     * **自适应分析块**：段落与段落名都由宿主的 `rubric.js` 给（`record.sections`），
     * 客户端**不自己排段落名**，所以「改判据只改一个文件」在界面上也成立。
     * 条数不固定：有几条画几条，空段落直接不画。
     */
    function analysisBlock(record, sections, tone, key = 'analysis') {
      const list = Array.isArray(sections) && sections.length > 0 ? sections : FALLBACK_SECTIONS;
      return h('div', {
        key,
        'data-review-analysis': '1',
        style: { marginTop: 4, display: 'flex', flexDirection: 'column', gap: 6 },
      }, list.map((section) => {
        const value = record?.[section.key];
        const items = section.key === 'summary'
          ? (String(value ?? '').trim() === '' ? [] : [String(value).trim()])
          : (Array.isArray(value) ? value.map((item) => String(item)).filter((item) => item.trim() !== '') : []);
        if (items.length === 0) return null;
        return h('div', { key: `s-${section.key}`, 'data-review-section': String(section.key) }, [
          h('div', {
            key: 'h',
            style: { color: `var(${tone.color})`, fontSize: 11.5, fontWeight: 600, marginBottom: 1 },
          }, String(section.title ?? section.key)),
          ...items.map((item, index) => h('div', {
            key: `i${index}`,
            style: { color: 'var(--dsw-alias-label-primary)', fontSize: 12.5, lineHeight: '18px', wordBreak: 'break-word' },
          }, item)),
        ]);
      }).filter(Boolean));
    }

    function insightsBlock(record) {
      const items = Array.isArray(record?.analysis) ? record.analysis.slice(0, 4) : [];
      if (items.length === 0) return null;
      return h('div', { key: 'insights', 'data-review-insights': String(items.length) }, items.map((item, index) => {
        const parts = String(item).split('｜');
        const title = parts.length > 1 ? parts[0] : parts[0].split('。')[0];
        const details = parts.slice(1);
        const suggestion = String(record?.advice?.[index] ?? '');
        return h('details', {
          key: `insight-${record?.at ?? 'stream'}-${index}`,
          'data-review-insight': String(index + 1),
          style: { marginTop: 6, padding: '8px 10px', borderRadius: 8, background: ROW_ZEBRA[index % ROW_ZEBRA.length], fontSize: 12.5, lineHeight: '19px' },
        }, [
          h('summary', { key: 'title', style: { cursor: 'pointer', overflowWrap: 'anywhere' } }, [
            h('span',{key:'label',style:{fontWeight:600}},`${index + 1}. ${title}`),
            suggestion ? h('div', { key: 'suggestion', style: { marginTop: 4, fontSize:11.5, color:'var(--dsw-alias-label-secondary)' } }, `建议：${suggestion}`) : null,
          ]),
          details.length === 0 ? h('div',{key:'legacy',style:{marginTop:6}},String(item)) : null,
          ...details.map((text, i) => h('div', { key: `d${i}`, style: { marginTop: 6, overflowWrap: 'anywhere' } }, text)),
          details.length === 0 && record?.dialog?.length ? h('div', { key: 'evidence', style: { marginTop: 6 } }, `原话：${record.dialog.join('；')}`) : null,
        ].filter(Boolean));
      }));
    }

    /**
     * 一张评价卡片的正文：**流式半成品优先**（复审员还在写就一段段长出来），
     * 否则画最新一条的「结论 + 领先行 + 四段分析」。
     *
     * 没有结果时**不是**笼统一句「审核中…」，而是按投影里的真实状态分四句：
     *   - `stream` 有半成品 → 「生成中…」+ 已经长出来的段落；
     *   - `pending` 立着      → 「复审进行中…」（宿主真的在跑）；
     *   - `failure` 立着      → 「复审没有完成 —— <真因>」；
     *   - 三个都没有、也没有旧卡片 → 「还没有评价」（真空，指引用户点方向）。
     * 面板状态标签（`data-review-state`）与这里同源，测试与用户看到的是同一个判据。
     * @param {object|null} latest - 最新一条评价卡片。
     * @param {object|null} stream - 投影里的流式半成品。
     * @param {object|null} pending - 投影里的「复审进行中」标记。
     * @param {object|null} failure - 投影里的「复审失败」标记。
     * @param {object} tone - 结论配色与中文。
     * @returns {object} 渲染节点。
     */
    function answerBlock(latest, stream, pending, failure, tone) {
      const live = stream !== null && stream !== undefined;
      const record = live ? stream : latest;
      const sections = record?.sections ?? FALLBACK_SECTIONS;
      const hasContent = record !== null && record !== undefined
        && sections.some((section) => {
          const value = record?.[section.key];
          return section.key === 'summary' ? String(value ?? '').trim() !== '' : (Array.isArray(value) && value.length > 0);
        });
      /** 没有卡片可画时的那一句 —— 四态各说各的。 */
      const statusLine = () => {
        if (pending !== null && pending !== undefined) {
          return line('pending', TEXT.pending, '--dsw-alias-label-secondary');
        }
        if (failure !== null && failure !== undefined) {
          return line('failed', `${TEXT.failed}${String(failure.message ?? '')}`, '--dsw-alias-state-error-primary');
        }
        if (latest === null) return line('empty', TEXT.empty, '--dsw-alias-label-secondary');
        return null;
      };
      if (live && hasContent) {
        // 半成品已经在长了 —— 「生成中…」本身就是进行中，不必再叠一句 pending。
        return h('div', { key: 'live' }, [
          line('liveh', TEXT.streaming, '--dsw-alias-label-tertiary', 11.5),
          analysisBlock(record, sections, tone, 'liveanalysis'),
          pending !== null && pending !== undefined ? null : statusLine(),
        ].filter(Boolean));
      }
      const body = (latest === null || latest === undefined) ? [] : [
        h('div', {
          key: 'v',
          style: { display: 'flex', gap: 6, alignItems: 'center', color: `var(${tone.color})`, fontWeight: 600, marginBottom: 2 },
        }, [
          h('span', { key: 'd', 'aria-hidden': true, style: { width: 6, height: 6, borderRadius: '50%', background: `var(${tone.color})` } }),
          h('span', { key: 't' }, tone.label),
        ]),
        // 领先行（`headline`）—— 和左栏那一行是同一句话，右栏给足空间。
        latest.headline === undefined || latest.headline === ''
          ? null
          : qaLine('hl', '一句话', latest.headline, tone.color),
        analysisBlock(latest, sections, tone, 'cardanalysis'),
      ].filter((node) => node !== null && node !== undefined);
      const status = statusLine();
      if (body.length === 0 && status !== null) return status;
      return h('div', { key: 'card' }, [...body, status].filter(Boolean));
    }

    /** 评价清单里每一行的**固定高度** —— 等高才扫得动（用户要的就是这个）。 */
    const ROW_H = '22px';

    /**
     * **斑马纹**：左栏清单相邻两行交换背景，边界一眼可见。
     *
     * 用户原话（2026-10）：「你每一条你可以每一条就换个颜色或者什么这样子交替的，
     * 不然的话我不知道你每一条哪里结束」。
     *
     * 只用**主题 token**，绝不写死颜色 —— 浅色/深色主题是两套完全不同的值
     * （`--dsw-alias-interactive-bg-hover` 在浅色是 `#2631480f`、在深色是 `#ffffff14`），
     * 写死 `#eee` 必然在其中一边错。`transparent` 不是颜色，是「这一行不着色」，
     * 所以交替的一半就是它；真正上色的那一半必须是 token，且**两行交替**而不是都刷一层。
     *
     * 为什么是 `interactive-bg-hover`：它就是 shipped 列表用来铺行的那层极淡底色
     * （`dsh-client-ui-chat` 的轨迹表 `tr:hover` 用的同一条），深浅两边都有定义，
     * 且足够淡、不会和「选中色」（`interactive-bg-hover-solid`，不透明）抢。
     */
    const ROW_ZEBRA = [
      { tag: 'even', background: 'transparent' },
      { tag: 'odd', background: 'var(--dsw-alias-interactive-bg-hover)' },
    ];

    /** 本地问答回显最多留几条（和投影那条流一样是**有界**的，不随会话长度长）。 */
    const ASK_ECHO_KEEP = 8;

    /**
     * 一行时间（`HH:MM`）。没有时间戳（测试替身 / 老卡片）就不画这一段。
     * @param {unknown} at - 毫秒时间戳。
     * @returns {string} `HH:MM` 或空串。
     */
    function rowClock(at) {
      const ms = Number(at);
      if (!Number.isFinite(ms) || ms <= 0) return '';
      try { return new Date(ms).toTimeString().slice(0, 5); } catch { return ''; }
    }

    /**
     * **一条评价 = 一行**（master–detail 的左边那一列）。
     *
     * 用户 2026-10 的原话：「审核跳出来这个话，我觉得你要把它分成一条一条，
     * 然后每条就显示前面的一个部分，不然的话这样子你有的长有的短。」
     * 所以这一行只放**前导部分**：时间 · 结论标签 · **领先行**（`rubric.js` 的
     * `leadingLine()`）；单行、截断、等高。
     * 完整分析在右边（{@link resultsBlock} 的 detail 栏），点这一行就换过去；
     * **再点同一行 = 取消选中**（回到「跟随最新」）—— 这样「进去一条」永远有回头路，
     * 不必依赖顶栏那个返回键（见下面的视图模型）。
     * @param {object} card - 一条评价（投影 `feed` 里的元素）。
     * @param {number} index - 它在评价清单里的下标。
     * @param {boolean} selected - 是不是当前选中的那条。
     * @param {function(number): void} onSelect - 点这一行时把右栏换成它。
     * @returns {object} 一个可点的单行。
     */
    function evaluationRow(card, index, selected, onSelect) {
      const tone = VERDICT[card?.verdict] ?? VERDICT.unknown;
      // **领先行**：宿主 `rubric.js` 的 `leadingLine()` 折出来的那句（卡片上是
      // `headline`，老卡片退回 `text`/`summary`）。左栏只读它，所以永远有值。
      const leading = String(card?.headline ?? card?.text ?? card?.summary ?? '').replace(/\s+/g, ' ').trim();
      const clock = rowClock(card?.at);
      const full = `${clock === '' ? '' : `${clock} · `}${tone.label}${leading === '' ? '' : ` · ${leading}`}`;
      // 斑马纹：按**行下标**取，所以选中/取消选中不会让条纹跳来跳去（用户要的是稳定边界）。
      const stripe = ROW_ZEBRA[index % ROW_ZEBRA.length];
      return h('button', {
        key: `row${index}`,
        type: 'button',
        'data-review-row': String(index),
        'data-review-row-selected': selected ? String(index) : undefined,
        // 奇偶写进 DOM：测试据此断言「真的交替」，排查时也不用去猜哪一行上了色。
        'data-review-row-zebra': stripe.tag,
        title: full,
        // 再点同一行 = 取消选中，回到「跟随最新」。所以「点进一条评价」永远退得出来。
        onClick: () => onSelect(selected ? null : index),
        style: {
          display: 'flex', alignItems: 'center', gap: 6,
          boxSizing: 'border-box', width: '100%', height: ROW_H, minHeight: ROW_H, maxHeight: ROW_H,
          margin: 0, padding: '0 6px', border: 'none', borderRadius: 6,
          // 选中色优先；没选中时走斑马纹（相邻行不同）。
          background: selected ? 'var(--dsw-alias-interactive-bg-hover-solid)' : stripe.background,
          cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
          whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden',
        },
      }, [
        clock === '' ? null : h('span', {
          key: 'c', style: { flex: 'none', color: 'var(--dsw-alias-label-tertiary)', fontSize: 10.5, fontVariantNumeric: 'tabular-nums' },
        }, clock),
        h('span', {
          key: 'v', style: { flex: 'none', color: `var(${tone.color})`, fontWeight: 600, fontSize: 11.5 },
        }, tone.label),
        h('span', {
          key: 'd',
          style: {
            flex: '1 1 auto', minWidth: 0, color: 'var(--dsw-alias-label-primary)', fontSize: 11.5,
            whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden',
          },
        }, leading),
      ].filter(Boolean));
    }

    /**
     * 问答条目（`kind:'qa'`）—— 和自动评价**同一个流**，但样式不同
     * （左边框 + 「问答」小标题），所以用户永远能分辨两者。
     *
     * 参数是**已经配好对**的 `{question, answer}` 列表（见 `qaEntries`）：
     * 投影里的问答与命令回执的本地回显在这里合流、去重，所以这个函数不关心来源。
     * 它画在**你打字的那个框下面**（左栏），而不是另一栏的底部 —— 用户提问之后
     * 眼睛就在那里，「答在别处、还要滚过去找」等于没答（bug 54）。
     * @param {{question: string, answer: string}[]} entries - 问答条目。
     * @param {string} [key] - React key 前缀。
     * @returns {object|null} 条目块；没有条目时 null。
     */
    function qaBlock(entries, key = 'qalist') {
      const list = Array.isArray(entries) ? entries : [];
      if (list.length === 0) return null;
      return h('div', { key, 'data-review-qa-list': '1', style: { marginTop: 6 } }, [
        line(`${key}h`, '问答（针对评价，手动问的）', '--dsw-alias-label-tertiary', 11.5),
        ...list.slice(-6).map((entry, index) => h('div', {
          key: `${key}${index}`,
          'data-review-qa': '1',
          style: {
            marginTop: 3, paddingLeft: 6,
            borderLeft: '2px solid var(--dsw-alias-border-l1)',
          },
        }, [
          line(`${key}q${index}`, `问：${String(entry?.question ?? '')}`, '--dsw-alias-label-secondary'),
          line(`${key}a${index}`, `→ ${String(entry?.answer ?? '')}`, '--dsw-alias-label-primary'),
        ])),
      ]);
    }

    /**
     * 面板命令在对话流里的专用视图 —— **什么都不画**（返回 `null`）。
     *
     * 为什么还要注册它：任何会话命令都会留下 `command/run` + `command/done` 两个
     * log-only 事件（`dsh-commands/lib/index.js:334` / `:341`），对话流会为它渲染一个
     * 命令节点（`dsh-client-ui-chat/lib/client.js:6808-6816` 的 `CommandNodeView`），
     * 并按命令名到 `conversation.chat.commandview` 这个 keyed 插槽找专用视图；
     * **找不到就用 `GenericCommandCard` 兜底**，把 `command/done.text` 整段画出来
     * —— 我们的 `dir` / `pick` 把目录/证据编码成 JSON 放在那里，那是给面板解析的。
     *
     * 改前这里画一句「审核 · 读对话目录」之类的小字。**那句话就是用户抓到的现场**：
     * 「我点了之后你的这个对话框又在乱动了……我如果只点就在审核那边操作，
     * 它不应该跳出任何问题」。每点一次、而且**每 20 秒一次活性 ping**，上面那条对话
     * 就多出一行；命令节点还会把对话列推一下。
     *
     * 现在返回 `null`：命令节点只剩 `CommandNodeView` 的那个空 `callRow`
     * （`dsh-client-ui-chat/lib/client.js:6134-6146`），没有可读内容、没有高度，
     * 也没有 `agent.inject` / `followup`（投递只走 `developer/message` 面事件，
     * 对话流不渲染它）。所以「在审核那边操作」在对话区里是**零可见变化**。
     *
     * 只依赖 `slots`（已证实必然存在的服务），注册失败不影响面板。
     * @returns {null} 永远什么都不画。
     */
    function ReviewCommandLine() {
      return null;
    }

    /**
     * 审核面板。
     * @param {object} props - 插槽提供的标准 props。
     * @returns {object|null} 面板；非审核模式时为 null。
     */
    function ReviewPanel(props) {
      const useSessions = typeof props.useSessions === 'function'
        ? props.useSessions
        : (selector) => selector({ byId: {} });
      /* 会话从哪来：`shell.overlay` 是 **root 作用域**，standard props 里没有
       * `sessionId`（目录里 shell.overlay 的 standardProps 只有 useSessions /
       * useSessionStatus / useSessionRetainInfo …）。所以会话**自己认** ——
       * 但只认**正在主栏显示的那一条**：`retainedBy.mainView > 0`。
       * 这是 shipped 源码判「当前会话」的同一形状：
       *   - `dsh-client-ui-cordis/lib/client.js:741`
       *     `Object.values(state.byId).find((session) => (session.retainedBy.mainView ?? 0) > 0)?.id`
       *   - `dsh-client-ui-layout/lib/client.js:60`、`dsh-client-ui-session/lib/client.js:283`
       * 也都是这一句。
       *
       * **priority 是反过来的**（2026-10 用户亲手抓到）：以前「找不到正在显示的
       * 那条就退回任意一条审核会话，绝不让面板消失」—— 于是
       *   1. 选了别的模式，右边照样跳出一列（用户原话：「为什么我没有选那个模式，
       *      它右边也会跳出来？」）；
       *   2. 面板读的 `reviewMode` 投影不是你正在看的那份 —— 复审结果落在别处，
       *      面板**一直空着**（用户原话：「现在你还是在审核面板那边还是什么都没有」）。
       * 现在的规则只有一句：**审核模式才出现，别的模式一个字都不出现**；
       * 认不出正在显示哪条 → 什么都不画（隐形是对的，在别的会话里冒出来是错的）。
       * 会话作用域的插槽（老 dock / 测试）给了 `sessionId` 就直接用，行为一字不变。 */
      const viewSessionId = useSessions((state) => {
        const byId = state?.byId ?? {};
        for (const [id, snapshot] of Object.entries(byId)) {
          if (Number(snapshot?.retainedBy?.mainView ?? 0) > 0) return id;
        }
        return undefined;
      });
      const sessionId = (typeof props?.sessionId === 'string' && props.sessionId.length > 0)
        ? props.sessionId
        : viewSessionId;
      const preset = useSessions((state) => state.byId?.[sessionId]?.projectionValues?.agentPreset);
      const projection = useSessions((state) => state.byId?.[sessionId]?.projectionValues?.reviewMode);

      const [open, setOpen] = React.useState(true);
      const [depth, setDepth] = React.useState(0);        // 0 选方向 · 1 选对话 · 2 看结论
      const [kind, setKind] = React.useState(null);
      const [tree, setTree] = React.useState(null);
      const [note, setNote] = React.useState('');
      const [picked, setPicked] = React.useState(null);
      /** master–detail 左边被点中的那一行的下标；`null` = 跟着最新一条走。 */
      const [selected, setSelected] = React.useState(null);
      const [width, setWidth] = React.useState(() => {
        try {
          const saved = Number(window.localStorage?.getItem('review-panel-width'));
          if (Number.isFinite(saved) && saved >= MIN_W) return Math.min(MAX_W, saved);
        } catch { /* 退回默认 */ }
        return DEFAULT_W;
      });
      const dragging = React.useRef(null);
      /** 面板根节点 —— 用来沿 DOM 往上找 shell 的 frame，把「预留一列」写上去。 */
      const reserveRef = React.useRef(null);
      /** 结果区节点 —— 点信号时把它滚回顶部（「最新那条」就在最上面）。 */
      const bodyRef = React.useRef(null);
      /**
       * **「看过几条」**：客户端本地状态（并写进 `localStorage`）。
       *
       * 用一个 `{key, count}` 而不是裸数字：`sessionId` 变了（同一个 dock
       * 换了会话）时，`key !== seenKey` 会当场退回该会话自己存的值 ——
       * 不需要一个会 `setState` 的 effect（那种 effect 在测试的极小 React 里
       * 会同步递归重画，真实 React 里也纯属多余）。
       */
      const seenKey = `${SEEN_KEY}:${sessionId}`;
      const readSeenCount = () => {
        try {
          const value = Number(window.localStorage?.getItem(seenKey));
          return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
        } catch { return 0; }
      };
      const [seen, setSeen] = React.useState(() => ({ key: seenKey, count: readSeenCount() }));
      const seenCount = seen.key === seenKey ? seen.count : readSeenCount();
      /** 左栏「问」的筛选词 —— FLOW.md 第 10 步状态 3 的「＋筛选」。 */
      const [saidFilter, setSaidFilter] = React.useState('');
      /**
       * 左边那个对话框：**针对已有的评价**提问（「为什么这么说」「② 展开讲讲」）。
       * 它不驱动复审、不重置流；回答由宿主命令同步带回（`{kind:'success', text}`），
       * 同时宿主会把它投成一条 `kind:'qa'` 面事件进投影的流。
       *
       * **回答以命令回执为准**（bug 54）。用户现场原话：「还有话我那边问话，
       * 现在还是显示不任何」；`/tmp/dsh-review-watch.jsonl` 里 `ask` 之后
       * 一条投递记录都没有 —— 那条正在跑的宿主还用旧的 `developer/message` 投递，
       * 而它结构上就投不出去（见 bug 50）。旧实现把回执丢掉、只等面事件落地，
       * 于是通道一断就是「输入框清空、命令成功、屏幕上一个字都没有」。
       * 现在回执立刻变成一条本地问答条目（{@link asked}），面事件落地后按问题去重。
       */
      const [askDraft, setAskDraft] = React.useState('');
      /**
       * **本地问答回显**：命令回执带回来的回答，在面事件落地之前先顶上。
       *
       * 有界（{@link ASK_ECHO_KEEP} 条）、只在内存里；投影里出现同一条问答之后
       * 就用投影那份（屏幕上永远只有一份，见 `qaEntries` 的去重）。
       */
      const [asked, setAsked] = React.useState([]);
      const submitAsk = () => {
        const text = String(askDraft ?? '').trim();
        if (text.length === 0) return;
        setAskDraft('');
        const command = cmdLine('ask', text);
        callCommand(sessionId, command).then((outcome) => {
          const res = commandResult(outcome, command);
          if (!res.ok) { setNote(res.why); return; }
          const answer = String(res.text ?? '').trim();
          // 空回答不画空条目（那是假条目）—— 但也不该静默，如实说一句。
          if (answer.length === 0) { setNote('宿主没有给出回答（问答条目也不会出现在流里）。'); return; }
          setNote('');
          setAsked((prev) => [...prev, { question: text, answer }].slice(-ASK_ECHO_KEEP));
        });
      };

      React.useEffect(() => {
        const onMove = (event) => {
          const start = dragging.current;
          if (start === null) return;
          // 拖**左边缘**：鼠标往左（clientX 变小）＝面板变宽。
          setWidth(Math.max(MIN_W, Math.min(MAX_W, start.width + (start.x - event.clientX))));
        };
        const onUp = () => {
          if (dragging.current === null) return;
          dragging.current = null;
          try { window.localStorage?.setItem('review-panel-width', String(width)); } catch { /* 无所谓 */ }
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        return () => {
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
        };
      }, [width]);

      /* ── 预留一列：**面板不覆盖对话列，而是把对话列挤窄** ────────────────────
       *
       * 用户 2026-10 的两个抱怨是同一个根因：
       *   1.「界面直接覆盖在问答框上，如果问答输入的话，很多都会被挡」——浮层压着 composer；
       *   2.「通过原本的这个问答框问的时候，他就是直接卡顿住」——被压住的 composer
       *      收到的指针事件（点、IME 光标定位、发送键）落在**我们这一层**上，
       *      所以「点了没反应 / 输入卡住」。
       * 所以这里不做「覆盖」，做「占位」：沿 DOM 往上找到 shell 的 frame
       * （`[data-shell-overlay]` 的父节点，见 `dsh-client-ui-layout/lib/client.js:344-346`
       * 把 overlay 挂在 frame 里），把上面那条 `RESERVE_CSS` 用到的变量写在它身上。
       * 找不到 frame（老宿主 / 测试替身）就什么都不做 —— 面板仍然工作，只是没有预留。
       */
      React.useEffect(() => {
        const node = reserveRef.current;
        if (node === null || node === undefined || typeof node.closest !== 'function') return undefined;
        const frame = node.closest('[data-shell-overlay]')?.parentElement
          ?? (typeof document !== 'undefined' ? document.querySelector('[data-shell-overlay]')?.parentElement : null)
          ?? null;
        if (frame === null || frame === undefined || frame.style === undefined) return undefined;
        const reserved = open ? Math.min(width, Math.round((window.innerWidth || 1280) * MAX_RESERVE_RATIO)) : 0;
        const apply = () => {
          frame.setAttribute('data-review-reserved', '1');
          frame.setAttribute('data-review-reserved-w', String(reserved));
          frame.style.setProperty('--review-reserved-w', `${reserved}px`);
        };
        apply();
        window.addEventListener('resize', apply);
        return () => {
          window.removeEventListener('resize', apply);
          frame.style.removeProperty('--review-reserved-w');
          frame.removeAttribute('data-review-reserved');
          frame.removeAttribute('data-review-reserved-w');
        };
      }, [open, width, sessionId]);

      /* ── 活性：**真的探一次**，不是装饰 ────────────────────────────────
       *
       * 用户的原话：「您那边如果一直不动……你要不弄一个一直在转的帮我显示他在连接……
       * 连接上那就在转，没有连接上就消失，不然我不知道他有没有（在工作）」。
       *
       * 面板渲染自 `reviewMode` 投影；用户不发消息 → 没有会话事件 → 投影不变 →
       * 面板一次都不重画。所以「安静地在干活」和「已经死了」看起来一模一样。
       * 这里补三样东西：
       *   1. 一个**真的**心跳：走已经打通的 `commands` 通道调 `/review-mode ping`，
       *      宿主立刻回一个内存快照（零模型、零读盘、零投递）；
       *   2. 一个**本地时钟**（每秒一次 `setState`，**不发任何宿主请求**）—— 用来把
       *      「最后一次成功心跳过去多久」重算出来，超过保鲜期就让状态自己去「未连接」；
       *   3. 转圈**用 CSS animation**，所以投影几个月不变它也照转（见 {@link SPIN_CSS}）。
       */
      const [probe, setProbe] = React.useState({ status: 'first', at: 0, why: '', facts: null });
      const [clock, setClock] = React.useState(() => Date.now());

      // 本地时钟 —— 纯本地，每 tick 只有一次 setState，**没有宿主调用**。
      //
      // 2026-10 卡顿排查（用户原话「我通过原本的这个问答框问的时候，他就是直接卡顿住」）：
      // 这条 effect 以前只要在审核模式就**永久 1Hz** 跑，于是整个面板（含左栏清单、
      // 右栏分析、两个输入框）每秒重画一次 —— 与正在打字的 composer 抢同一帧。
      // 现在按**真的需要**门控：
      //   - 面板收起 → 不跑（收起时只留一条小字，没有「N 秒前」要重算）；
      //   - 心跳不是 `ok` → 不跑（`first`/`down`/`fail` 三种文案**都不含时间**，
      //     见 liveTone() 的实现，重算也画不出不同的字）；
      //   - 只有「已连接 · 监控中」这一态才需要把「N 秒前」重算 → 才起定时器。
      // 这不是把功能关掉：`ok` 且展开时行为一字不变；它只是把**无谓的重画**去掉了。
      React.useEffect(() => {
        if (preset !== 'review') return undefined;
        if (!open) return undefined;
        if (probe.status !== 'ok') return undefined;
        const id = setInterval(() => setClock(Date.now()), LOCAL_TICK_MS);
        return () => clearInterval(id);
      }, [preset, open, probe.status]);

      // 真心跳 —— 立刻一次，之后每 `PROBE_INTERVAL_MS` 一次（几十秒）。
      // `callCommand` 自带 4 秒硬超时，所以**永远不会**挂在这里。
      // 同样按预设门控：非审核模式一次都不许发（不给别的会话添流量）。
      React.useEffect(() => {
        if (preset !== 'review') return undefined;
        let alive = true;
        const beat = () => {
          const command = cmdLine('ping');
          callCommand(sessionId, command).then((outcome) => {
            if (!alive) return;
            const res = commandResult(outcome, command);
            if (!res.ok) {
              setProbe({ status: 'down', at: Date.now(), why: res.why, facts: null });
              return;
            }
            const facts = parseJson(res.text);
            if (facts === null || facts.pong !== true) {
              setProbe({ status: 'down', at: Date.now(), why: '心跳回复看不懂（通道只通了一半）。', facts: null });
              return;
            }
            setProbe({ status: 'ok', at: Date.now(), why: '', facts });
          });
        };
        beat();
        const id = setInterval(beat, PROBE_INTERVAL_MS);
        return () => { alive = false; clearInterval(id); };
        // 会话或预设变了就重新探；其余依赖都是常量，不需要进依赖表。
      }, [sessionId, preset]);

      // 选方向 → 一条宿主命令：给目录；`self` 还会**由宿主自己派一次复审**。
      //
      // 用户的原话：「我点进去，你就自动开始审查，并且监控，然后就显示在审核的那个版当中，
      // 开始自动输出」。以前宿主是用 `agent.followup` 唤醒**主 Agent** 去复审 ——
      // 结果整张表长在对话记录里，面板一直停着（真发生过）。现在宿主直接派复审子 Agent，
      // 结果折进 `reviewMode` 投影，面板自己重画（见 `index.js` 的 `startPanelReview`）。
      //
      // 命令不存在 / 超时 / 报错都要**立刻变成一句话**，不能静默，
      // 更不能永远停在「读目录…」。
      const chooseDirection = (value) => {
        setKind(value);
        setDepth(1);
        setSelected(null);
        setTree(null);
        setNote(TEXT.loading);
        const command = cmdLine('dir', value);
        callCommand(sessionId, command).then((outcome) => {
          const res = commandResult(outcome, command);
          if (!res.ok) {
            setTree(null);
            setNote(res.why);
            return;
          }
          const result = parseJson(res.text);
          if (result === null || typeof result !== 'object') {
            setTree(null);
            setNote('读目录返回了空结果（面板指令通道可能只通了一半）。');
            return;
          }
          setTree(result);
          setNote('');
          if (result.self === true) {
            setPicked({ item: { kind: 'self', id: result.selected?.id, title: '本会话' }, conversation: result.evidence });
            setDepth(2);
          }
        });
      };

      // 选对话 → 一条宿主命令：记下目标、**由宿主派复审**、回证据。
      // 选中的「记录」以前由宿主工具 `review_conversation` 做；现在面板这条路走
      // `review-mode pick`，宿主在同一个 handler 里调 `setTarget()` —— 两条路写同一份状态。
      // 复审结果只走 `reviewMode` 投影（面板），不写进对话。
      const chooseConversation = (item) => {
        setPicked({ item, conversation: null });
        setDepth(2);
        setSelected(null);
        setNote(TEXT.evidence);
        const command = cmdLine('pick', item.kind, item.id);
        callCommand(sessionId, command).then((outcome) => {
          const res = commandResult(outcome, command);
          if (!res.ok) {
            setNote(res.why);
            return;
          }
          const result = parseJson(res.text);
          setPicked({ item, conversation: result?.evidence ?? null });
          setNote('');
        });
      };

      if (preset !== 'review') return null;

      /* ── 活性结论：**由本地时钟算出来**，不需要投影变化，也不需要新数据 ────
       *
       * 四种状态（用户原话：连接上就转，没连上就消失）：
       *   first  连接中            —— 还在等第一次成功的心跳（转，中性色）
       *   ok     已连接 · 监控中   —— 最近一次心跳成功，且**最近一次真实运行没失败**
       *   fail   跑不起来 · 审核失败 —— 通道答话了，但宿主报出最近一次运行失败
       *                              （`lastTurn.failed`）。**不转**，并说出到底哪里错。
       *   down   未连接            —— 最近一次失败，或成功已经**过期**（不转，一句话原因）
       *
       * 「过期」这一条就是本地时钟存在的理由：即使一个心跳请求都没回来（通道悄悄断了、
       * 标签页被节流），几十秒后它也会自己变成「未连接」，不会一直假装在转。
       *
       * `fail` 优先于 `first`：页面刚刷新时还没探过，但宿主上一次心跳已经把失败
       * 报回来了 —— 那种情况下必须先把失败说清楚，不能先转一个「连接中…」。
       */
      const probeAge = probe.at === 0 ? null : Math.max(0, clock - probe.at);
      const stale = probe.status === 'ok' && probeAge !== null && probeAge > STALE_MS;
      // 宿主的诚实回话：`lastTurn` 是最近一次真实 `turn/end` 的结论。
      const failed = probe.status === 'ok' && probe.facts?.lastTurn?.failed === true;
      const liveStatus = probe.status === 'down' || stale ? 'down' : (failed ? 'fail' : probe.status);
      const liveTone = { ...(LIVENESS[liveStatus] ?? LIVENESS.first) };
      if (liveStatus === 'ok') liveTone.label = probe.facts?.selection
        ? (probe.facts?.tick?.enabled === false ? '已连接 · 监控关闭' : '已连接 · 已选目标')
        : '已连接 · 等待选择';
      /** 毫秒 → 一句人话（不足一秒就说毫秒，测试里的短保鲜期才读得懂）。 */
      const spanText = (ms) => (ms < 1000 ? `${Math.round(ms)} 毫秒` : `${Math.round(ms / 1000)} 秒`);
      const liveWhy = probe.status === 'down'
        ? (probe.why === '' ? '心跳失败。' : probe.why)
        : (stale ? `最后一次成功心跳是 ${spanText(probeAge)}前，超过 ${spanText(STALE_MS)}没成功。` : '');
      const agoText = (ms) => (ms === null || !Number.isFinite(ms) ? '—' : (ms < 1500 ? '刚刚' : `${Math.round(ms / 1000)} 秒前`));
      /**
       * 「跑不起来」时到底哪里错 —— 面板直接把宿主报的那句原话（和错误码）说出来，
       * 用户不用去翻对话日志、更不用猜。
       * @param {object} lastTurn - ping 回来的 `lastTurn`。
       * @returns {string} 一句人话。
       */
      const failureText = (lastTurn) => {
        const code = String(lastTurn?.code ?? '').trim();
        const message = String(lastTurn?.message ?? '').trim();
        const when = Number.isFinite(lastTurn?.ageMs) ? `（${agoText(lastTurn.ageMs)}）` : '';
        if (message === '') return `通道是通的，但最近一次运行失败了${when}${code === '' ? '' : ` · ${code}`}`;
        return `通道是通的，但最近一次运行失败${when}：${message}${code === '' ? '' : ` · ${code}`}`;
      };
      const liveFacts = () => {
        if (liveStatus === 'down') return liveWhy;
        if (liveStatus === 'fail') return failureText(probe.facts?.lastTurn);
        if (liveStatus === 'first') return '首次心跳还没回来（正在连接宿主）。';
        const facts = probe.facts ?? {};
        const tick = facts.tick ?? {};
        const scan = facts.scan ?? {};
        const parts = [];
        parts.push(tick.lastAt === null || tick.lastAt === undefined
          ? '主机还没 tick 过'
          : `主机心跳 ${agoText(clock - tick.lastAt)}`);
        if (Number.isFinite(tick.intervalMs)) parts.push(`间隔 ${Math.round(tick.intervalMs / 1000)}s`);
        if (tick.enabled === false) parts.push('监控已关');
        if (Number.isFinite(scan.conversations)) parts.push(`上次扫描 ${scan.conversations} 条对话`);
        return parts.join(' · ');
      };

      const cards = Array.isArray(projection?.feed) ? projection.feed : [];
      // 问答条目（`kind:'qa'`）和自动评价在**同一个流**里，但「最新一张评价」只能在评价里取，
      // 否则刚问完一句，右栏那条评价的完整分析就被一条问答顶掉了。
      const reviews = cards.filter((card) => card?.kind !== 'qa');
      const latest = reviews.length > 0 ? reviews[reviews.length - 1] : null;
      /* ── 问答条目：投影里的 + **命令回执的本地回显**（bug 54）────────────────
       *
       * 投影里那份是正式记录（宿主 `appendReviewSurface(agent,'qa',…)` 投的
       * `user/message`，模型也看得到）；本地回显是命令同步带回来的回答，
       * 在面事件落地之前先显示 —— 否则那条异步通道一断，用户就是「什么都不显示」。
       * 去重按**问题原文**：投影里已经有了同一条，回显立刻撤掉，
       * 所以屏幕上任何时刻都只有一份（不会先左边冒一条、再右边冒一条）。
       */
      const projectedQa = cards.filter((card) => card?.kind === 'qa')
        .map((card) => ({ question: String(card?.question ?? ''), answer: String(card?.text ?? '') }));
      const qaEntries = [
        ...projectedQa,
        ...asked.filter((echo) => !projectedQa.some((entry) => entry.question.trim() === echo.question.trim())),
      ].slice(-6);
      /* master–detail 的**选中项**（用户 2026-10 的要求：左边一条一行，右边显示选中那条的分析）。
       * 默认 = 最新一条；`selected` 只在点过某一行之后才有值。
       * 投影的 `feed` 是**有界环形缓冲**（最多 60 条，超界丢最旧），所以下标可能失效
       * —— 越界/失效就收回最新一条，绝不指向不存在的卡片。 */
      const selectedIndex = (selected === null || !Number.isInteger(selected) || selected >= reviews.length)
        ? (reviews.length > 0 ? reviews.length - 1 : -1)
        : Math.max(0, selected);
      const selectedCard = selectedIndex >= 0 ? reviews[selectedIndex] : null;

      /* ── 「有新结果」信号 ─────────────────────────────────────────────
       *
       * 用户原话：「如果发现更新，他是不是有变一下提示一下，或者说一下最新的是啥」。
       * 要解决的是**一次真的错过**：面板常被收起、或被滚到看不见的地方，
       * 用户在看上面的对话；新评价悄悄落进投影时屏幕上什么变化都没有。
       *
       * 判据只有一条、而且是纯本地的：`新 = feed 里评价条数 − 上次看过的条数`。
       * 所以它**零模型、零宿主往返、零对话污染**（这三件事都由投影 + localStorage 保证）。
       * 说给用户听的是**最新那一条是什么**（结论标签 + ① 主题漂移那句），
       * 多于一条时前面带上条数 —— 只报数字会让人还得自己去找。
       */
      const acknowledge = (count) => {
        setSeen({ key: seenKey, count });
        try { window.localStorage?.setItem(seenKey, String(count)); } catch { /* 存不了就只在这次会话里记住 */ }
      };
      const unseen = Math.max(0, reviews.length - Math.min(seenCount, reviews.length));
      const gistOf = (item) => {
        if (item === null || item === undefined) return '';
        const label = (VERDICT[item.verdict] ?? VERDICT.unknown).label;
        const detail = String(item.headline ?? item.text ?? item.summary ?? '').trim();
        return detail === '' ? label : `${label} · ${detail}`;
      };

      // ── 状态 1：三个方向按钮 ─────────────────────────────
      const bodyPick = () => h('div', { key: 'pick' }, [
        line('lead', TEXT.lead, '--dsw-alias-label-primary'),
        h('div', { key: 'row', style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
          DIRECTIONS.map((direction) => h('button', {
            key: direction.label,
            type: 'button',
            'data-review-direction': direction.kind,
            title: direction.note,
            onClick: () => chooseDirection(direction.kind),
            style: {
              flex: '1 1 auto', minWidth: 130, padding: '8px 10px', cursor: 'pointer',
              borderRadius: 8, border: '1px solid var(--dsw-alias-border-l1)',
              background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)',
              fontSize: 12.5, textAlign: 'left', fontFamily: 'inherit',
            },
          }, [
            h('div', { key: 'l', style: { fontWeight: 600 } }, direction.label),
            h('div', { key: 'n', style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 11.5, marginTop: 2 } }, direction.note),
          ]))),
      ]);

      // ── 状态 2：Codex 式目录 ─────────────────────────────
      const bodyList = () => {
        if (note !== '') return line('note', note, '--dsw-alias-label-secondary');
        if (tree === null) return line('note', TEXT.loading, '--dsw-alias-label-secondary');
        const recent = Array.isArray(tree.recent) ? tree.recent : [];
        const groups = Array.isArray(tree.groups) ? tree.groups : [];
        if (recent.length === 0 && groups.length === 0) return line('note', TEXT.empty, '--dsw-alias-label-secondary');
        // 逐层 push，避免深层嵌套括号出错（这里已经错过一次）。
        const nodes = [];
        const rowButton = (row, indent, key) => h('button', {
          key,
          type: 'button',
          'data-review-target': row.id,
          onClick: () => chooseConversation(row),
          title: `${row.label ?? row.title} · ${row.age ?? ''}`,
          style: {
            display: 'flex', gap: 8, width: '100%', textAlign: 'left', cursor: 'pointer',
            margin: '1px 0', padding: `3px 8px 3px ${indent}px`, borderRadius: 6,
            border: 'none', background: 'transparent', fontFamily: 'inherit',
            color: 'var(--dsw-alias-label-primary)', fontSize: 12.5,
          },
        }, [
          h('span', { key: 't', style: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, row.label ?? row.title),
          h('span', { key: 'a', style: { flex: 'none', color: 'var(--dsw-alias-label-tertiary)', fontSize: 11.5 } }, row.age ?? ''),
        ]);
        if (recent.length > 0) {
          nodes.push(line('recentHead', '最近', '--dsw-alias-label-tertiary', 11.5));
          for (const row of recent.slice(0, 6)) nodes.push(rowButton(row, 10, `r-${row.id}`));
        }
        if (groups.length > 0) {
          nodes.push(line('groupHead', '项目', '--dsw-alias-label-tertiary', 11.5));
          for (const group of groups) {
            const children = [h('div', {
              key: 'g',
              style: { display: 'flex', alignItems: 'center', gap: 6 },
            }, [
              h('span', { key: 'i', 'aria-hidden': true }, '📁'),
              h('span', { key: 'n', style: { fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, group.project),
              h('span', { key: 'c', style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 11.5 } }, String(group.count)),
            ])];
            for (const conversation of group.conversations) {
              children.push(rowButton({ ...conversation, label: conversation.title }, 22, conversation.id));
            }
            nodes.push(h('div', { key: group.project, style: { marginTop: 4 } }, children));
          }
        }
        return h('div', { key: 'list' }, nodes);
      };

      /* ── 结果区：**master–detail**（用户 2026-10 的要求）─────────────────
       *
       * 用户原话：
       *   1.「审核跳出来这个话，我觉得你要把它分成一条一条，然后每条就显示前面的
       *      一个部分，不然的话这样子你有的长有的短。」
       *   2.「然后每条是不是右边又应该有对应的相关的评价分析呢？」
       *
       * 所以：
       *   - 左栏（`data-review-col="q"`）= **一条评价一行**的清单（{@link evaluationRow}：
       *     时间 · 结论标签 · **领先行**，单行、截断、**等高**），扫得动；
       *   - 右栏（`data-review-col="a"`，`data-review-detail="<i>"`）= **选中那条**的完整分析：
       *     结论 + 领先行 + **四段自适应分析**（具体对话 / 对话概述 / 分析 / 建议，
       *     段落表来自宿主 `rubric.js` 的 `sections`，条数不固定）；
       *   - 点左边某一行 → 右边换成那一条；**再点同一行取消选中**（回到「跟随最新」）。
       * 全部留在右边这一列浮层里，不新开第二个界面；也不写进上面那条对话。
       *
       * 这一块**不看 depth**：一进来（状态 1）就画，每来一条评价自动重画（数据来自
       * `reviewMode` 投影，是会话日志折出来的，不是客户端自己攒的）。状态 3（depth 2）
       * 只是多带上「你当时说的话」+ 针对评价的对话框。
       */
      const resultsBlock = ({ withEvidence }) => {
        const tone = VERDICT[selectedCard?.verdict] ?? VERDICT.unknown;
        // 流式半成品优先：复审员还在写的时候，右栏就照它一行一行画。
        const stream = projection?.stream ?? null;
        // 进行中 / 失败也来自投影（宿主真的立过标记），不是客户端猜的。
        const pending = projection?.pending ?? null;
        const failure = projection?.failure ?? null;
        const live = stream !== null && stream !== undefined;
        const generating = live || (pending !== null && pending !== undefined);
        const heading = `审核结果 · ${reviews.length} 条${generating ? '（正在生成…）' : ''}`;
        /* 四态标签：真空 / 进行中 / 失败 / 有结果。测试与用户看到的是同一个判据，
         * 所以「空状态文案在不该出现的时候出现」不可能再悄悄溜过去。 */
        const phase = live ? 'streaming'
          : (pending !== null && pending !== undefined ? 'pending'
            : (failure !== null && failure !== undefined ? 'failed' : (latest === null ? 'empty' : 'ready')));
        // 半成品只属于**最新**那条：选了更早的一条时，右栏画那条已经定稿的分析。
        const streamForSelected = selectedIndex === reviews.length - 1 ? stream : null;
        const rows = reviews.map((card, index) => evaluationRow(card, index, index === selectedIndex, setSelected));
        const rowsColumn = h('details', {
          key: 'rows', 'data-review-col': 'q',
          style: { flex: '0 0 40%', minWidth: 0, overflowY: 'auto', overscrollBehavior: 'contain' },
        }, [
          h('summary', {key:'rowsh', style:{cursor:'pointer',fontSize:11.5}}, `历史评价 · ${reviews.length} 次`),
          ...rows,
        ].filter(Boolean));
        const detailColumn = h('div', {
          key: 'detail', 'data-review-col': 'a', 'data-review-detail': String(selectedIndex),
          style: { flex: '1 1 auto', minWidth: 0, overflowY: 'auto', paddingRight: 6 },
        }, [
          h('div', {
            key: 'ahrow',
            style: { display: 'flex', alignItems: 'center', gap: 6 },
          }, [
            line('ah', TEXT.aHead, '--dsw-alias-label-tertiary', 11.5),
            // 「看最新」= 从某一条评价的详情**明确退回到跟随最新**。
            // 它就是「返回」在 results 这一层里的对应物（见上面的视图模型）。
            selectedIndex >= 0 && selectedIndex !== reviews.length - 1
              ? h('button', {
                  key: 'latest', type: 'button', 'data-review-latest': '1',
                  title: '回到最新一条',
                  onClick: () => setSelected(null),
                  style: {
                    flex: 'none', whiteSpace: 'nowrap', marginLeft: 'auto',
                    padding: '1px 7px', borderRadius: 6, cursor: 'pointer',
                    border: '1px solid var(--dsw-alias-border-l1)',
                    background: 'var(--dsw-alias-bg-layer-2)',
                    color: 'var(--dsw-alias-label-primary)',
                    fontSize: 11, fontFamily: 'inherit',
                  },
                }, '看最新')
              : null,
          ].filter(Boolean)),
          line('insight-head', '洞察 · 点击一条展开依据和做法', '--dsw-alias-label-tertiary', 11.5),
          streamForSelected || pending || !selectedCard
            ? answerBlock(null, streamForSelected, pending, failure, tone)
            : insightsBlock(selectedCard),
          // 问答条目**不在这边**：它长在左栏那个提问框下面（bug 54），
          // 否则回答会掉在右栏一长段分析的最底下、滚不到就以为「什么都没显示」。
        ]);
        // 状态 3 也要能显示远程失败的原因 —— 以前这里不渲染 note，
        // 于是「取证据」失败时界面什么都不说。
        const noteLine = withEvidence && note !== '' ? line('rnote', note, '--dsw-alias-label-secondary') : null;
        return h('div', {
          key: 'feed',
          'data-review-feed': String(reviews.length),
          'data-review-state': phase,
          style: {
            marginBottom: 8, paddingBottom: 6,
            borderBottom: '1px solid var(--dsw-alias-border-l1)',
          },
        }, [
          noteLine,
          h('div', {
            key: 'md', 'data-review-master': '1',
            style: { display: 'flex', flexDirection: 'column', gap: 10 },
          }, [detailColumn, rowsColumn, withEvidence ? evidenceBlock() : null]),
        ].filter(Boolean));
      };

      /**
       * 左栏（评价清单下面）的「问 · 你当时说的话」+ 筛选 + 针对评价的对话框。
       *
       * 只在状态 3（取到证据之后）画。用户原话：「话旁左边有一个对话框」——
       * 所以它留在**左栏**（`data-review-col="q"` 里），和评价清单同一列。
       * @returns {object} 左栏的证据 + 提问区。
       */
      const evidenceBlock = () => {
        const allSaid = picked?.conversation?.youSaid ?? [];
        const needle = saidFilter.trim().toLowerCase();
        const said = needle === ''
          ? allSaid
          : allSaid.filter((text) => String(text).toLowerCase().includes(needle));
        const askBox = () => h('div', { key: 'ask', style: { marginTop: 8, borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: 6 } }, [
          line('ah2', '问 · 针对这条评价', '--dsw-alias-label-tertiary', 11.5),
          h('div', { key: 'askrow', style: { display: 'flex', gap: 6, marginTop: 4 } }, [
            h('input', {
              key: 'askin',
              type: 'text',
              'data-review-ask': '1',
              value: askDraft,
              placeholder: TEXT.askPlaceholder,
              onChange: (event) => setAskDraft(String(event?.target?.value ?? '')),
              onKeyDown: (event) => { if (event?.key === 'Enter') submitAsk(); },
              style: {
                boxSizing: 'border-box', flex: '1 1 auto', minWidth: 0, padding: '3px 7px',
                borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1)',
                background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)',
                fontFamily: 'inherit', fontSize: 11.5, lineHeight: '17px',
              },
            }),
            h('button', {
              key: 'askb',
              type: 'button',
              'data-review-ask-submit': '1',
              onClick: submitAsk,
              style: {
                flex: 'none', padding: '3px 10px', borderRadius: 6, cursor: 'pointer',
                border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-2)',
                color: 'var(--dsw-alias-label-primary)', fontFamily: 'inherit', fontSize: 11.5,
              },
            }, TEXT.ask),
          ]),
          // **回答就长在这个框下面**（左栏、你打字的同一块地方）：
          // 投影里的问答条目 + 命令回执的本地回显，去重后一起画。
          // 用户提问之后眼睛就在这里 —— 答在另一栏的底部、还要滚过去找，等于没答（bug 54）。
          qaBlock(qaEntries, 'askqa'),
        ]);
        return h('div', { key: 'evidence', style: { marginTop: 8, borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: 6 } }, [
          line('qh', TEXT.qHead, '--dsw-alias-label-tertiary', 11.5),
          allSaid.length === 0 ? null : h('input', {
            key: 'filter',
            type: 'search',
            'data-review-filter': 'said',
            value: saidFilter,
            placeholder: TEXT.filter,
            onChange: (event) => setSaidFilter(String(event?.target?.value ?? '')),
            style: {
              boxSizing: 'border-box', width: '100%', marginTop: 3, padding: '3px 7px',
              borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1)',
              background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)',
              fontFamily: 'inherit', fontSize: 11.5, lineHeight: '17px',
            },
          }),
          ...(said.length === 0
            ? [line('qe', allSaid.length === 0 ? '（没读到你说的话）' : TEXT.noMatch, '--dsw-alias-label-tertiary')]
            : said.map((text, index) => line(`q${index}`, text, '--dsw-alias-label-primary'))),
          askBox(),
        ].filter(Boolean));
      };

      const bodyFor = () => (depth === 0 ? bodyPick() : (depth === 1 ? bodyList() : resultsBlock({ withEvidence: true })));

      /* ── 视图与「返回」的**显式定义**（用户 2026-10：「点击返回……没法返回原界面」）──
       *
       * 面板一共只有三个视图，**返回永远等于「上一层」**：
       *
       *   `pick`（depth 0，选方向）
       *      ↑↓ 返回   —— `pick` 是根，没有返回键（它上面没有东西，也就没有死路）
       *   `list`（depth 1，选对话）
       *      ↑↓ 返回   —— 回 `pick`，同时清掉 kind/tree/note
       *   `results`（depth 2，看结论）
       *      ↑↓ 返回   —— 回 `list`，并**把右栏收回「跟随最新」**（`selected = null`）
       *
       * 「右栏选中了某一条评价」**不是第四个视图**，它是一个可逆的选择状态，所以有三条
       * 独立的回头路，任何一条都够用：
       *   1. 再点同一行（`evaluationRow` 的 onClick 传 null）= 取消选中；
       *   2. 右栏顶部的 **「看最新」** 按钮（`data-review-latest`）；
       *   3. 顶栏 **返回**（离开 results，回到 list）。
       * 这三条都写进了 `README.md` / `FLOW.md` 的「问答框 vs 面板 / 返回模型」一节。
       *
       * 为什么以前会「点不动」：那个按钮是 flex 行里的一个 `padding:0` 的裸文本节点，
       * 既没有 `flex:'none'` 也没有 `whiteSpace:'nowrap'`，而它的文案里还塞着整条对话标题
       * （`crumbs`）。面板一窄，flex 就把它压成几像素宽的一条缝（`min-content` 对中文而言
       * 只有一个字宽），外侧再被面板的 `overflow:hidden` 裁掉 —— 于是「看得见字、点不到」。
       * 现在：`flex:'none'` + `whiteSpace:'nowrap'` + 真正的内边距（≥56px 命中区），
       * 标题只留在 `title`/`aria-label` 里，不再撑这一个按钮。
       */
      const VIEW_NAMES = ['pick', 'list', 'results'];
      const view = VIEW_NAMES[depth] ?? 'pick';
      const goBack = () => {
        // 一层一层往上退；根视图（depth 0）**永远不退**，所以不可能退进死路。
        if (depth <= 0) {
          setDepth(0);
          setSelected(null);
          return;
        }
        const up = depth === 2 && kind === 'self' ? 0 : depth - 1;
        setDepth(up);
        setSelected(null);
        setNote('');
        if (up < 2) setPicked(null);
      };
      const crumbs = picked?.item?.title ?? (depth === 1 ? (kind === 'dsh' ? 'DSH 会话' : 'Codex 对话') : '');
      const backLabel = crumbs === '' ? TEXT.back : `${TEXT.back} ${crumbs}`;

      const head = h('div', {
        key: 'head',
        style: {
          display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px',
          borderBottom: open ? '1px solid var(--dsw-alias-border-l1)' : 'none',
        },
      }, [
        h('span', { key: 'dot', 'aria-hidden': true, style: { width: 7, height: 7, borderRadius: '50%', flex: 'none', background: 'var(--dsw-alias-brand-primary)' } }),
        // 标题**可以**被压窄（它是装饰），所以只让它缩，不让返回键缩。
        h('span', {
          key: 't',
          style: {
            fontWeight: 600, color: 'var(--dsw-alias-label-primary)',
            flex: '0 1 auto', minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          },
        }, TEXT.title),
        depth > 0
          ? h('button', {
              key: 'back', type: 'button',
              'data-review-back': view,
              title: backLabel,
              'aria-label': TEXT.back,
              onClick: goBack,
              style: {
                // `flex:'none'` + `nowrap` + 内边距 = 永远有 ≥56px 的可点区域，
                // 面板再窄也不会被压成一条缝（这就是「点不动」的真因）。
                flex: 'none', whiteSpace: 'nowrap', boxSizing: 'border-box',
                minWidth: 56, minHeight: 24, padding: '2px 8px',
                border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 6,
                background: 'var(--dsw-alias-bg-layer-2)', cursor: 'pointer',
                color: 'var(--dsw-alias-label-primary)', fontSize: 12.5, fontFamily: 'inherit',
              },
            }, TEXT.back)
          : null,
        h('span', { key: 'sp', style: { flex: '1 1 auto', minWidth: 0 } }),
        h('button', {
          key: 'toggle', type: 'button', 'aria-expanded': open,
          onClick: () => {
            const next = !open;
            // 展开 = 结果区（最新那条就在最上面）立刻在眼前 —— 记为「看过了」。
            if (next) acknowledge(reviews.length);
            setOpen(next);
          },
          style: { flex: 'none', border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--dsw-alias-label-secondary)', fontSize: 12.5, padding: '0 2px', textDecoration: 'underline', fontFamily: 'inherit' },
        }, open ? TEXT.collapse : TEXT.expand),
      ]);

      /**
       * **「有新结果」信号条** —— 渲染在 `body` **之外**，所以面板收起也在
       * （和活性条同一个位置纪律，但它是**另一个节点**、回答另一个问题：
       * 活性灯说「连没连上、跑不跑得起来」，这条说「有你还没看过的评价，最新的是这个」）。
       *
       * 它说的是**最新那条的要点**，不是光一个数字；点它就等于「看过了」：
       * 记下已读条数、展开面板、把结果区滚回顶部。所以它**不会常亮**。
       */
      const updateBar = unseen === 0 ? null : h('button', {
        key: 'update',
        type: 'button',
        'data-review-update': String(unseen),
        'data-review-update-gist': gistOf(latest).slice(0, 160),
        title: '有你还没看过的评价 —— 点一下看最新那条（看过就消失）',
        onClick: () => {
          acknowledge(reviews.length);
          setOpen(true);
          setDepth(0);
          setSelected(null);
          try {
            const node = bodyRef.current;
            if (node !== null && node !== undefined) node.scrollTop = 0;
          } catch { /* 滚不了也无所谓，内容已经在最上面 */ }
        },
        style: {
          display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left',
          padding: '4px 10px', border: 'none', borderTop: '1px solid var(--dsw-alias-border-l1)',
          cursor: 'pointer', fontFamily: 'inherit',
          background: 'var(--dsw-alias-bg-layer-2)',
          color: 'var(--dsw-alias-brand-primary)', fontSize: 11.5, lineHeight: '17px',
        },
      }, [
        h('span', { key: 'n', style: { flex: 'none', fontWeight: 600 } },
          unseen === 1 ? '1 条新结果' : `${unseen} 条新结果`),
        h('span', {
          key: 'g',
          style: {
            flex: '1 1 auto', minWidth: 0, overflow: 'hidden',
            textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-primary)',
          },
        }, gistOf(latest).slice(0, 160)),
        h('span', { key: 'c', style: { flex: 'none', color: 'var(--dsw-alias-label-tertiary)' } }, '查看'),
      ]);

      const body = open ? h('div', {
        key: 'body',
        ref: bodyRef,
        'data-review-body': '1',
        // 结果区滚回顶部 = 最新那条在眼前 = 看过了（往下滚不算，那时最新那条已经滚出去了）。
        onScroll: (event) => {
          if (unseen > 0 && Number(event?.target?.scrollTop ?? 1) <= 4) acknowledge(reviews.length);
        },
        // 面板是**满高的一列**，所以结果区靠 flex 撑开（不再是固定高度）。
        style: { flex: '1 1 auto', minHeight: 0, overflowY: depth === 2 ? 'hidden' : 'auto', overscrollBehavior: 'contain', padding: '8px 10px' },
      }, [depth === 2 ? null : resultsBlock({ withEvidence: false }), bodyFor()].filter(Boolean)) : null;

      // **D. 一行诊断**：浏览器到底看到了什么。用户可以直接念出来报告，
      // 不用开发者工具就能证实/证伪「第三方插件的远程通道不存在」这个判断。
      const diagText = diagnose();
      const diag = open ? h('div', {
        key: 'diag',
        'data-review-diag': diagText,
        style: {
          padding: '3px 10px 4px', color: 'var(--dsw-alias-label-tertiary)',
          fontSize: 10.5, lineHeight: '15px', wordBreak: 'break-word', userSelect: 'text',
        },
      }, diagText) : null;

      /**
       * **活性指示条** —— 常驻在诊断行旁边（收起面板时也留着，用户随时能看一眼）。
       *
       * 转圈是**一个 CSS 动画元素**（class `review-mode-spin`，规则来自下面的
       * `<style>`）：DOM 建好之后浏览器自己转，与 React 是否重画无关 ——
       * 所以投影几天不变，它也照转。JS 这边只做两件事：几十秒探一次（真心跳）、
       * 每秒重算一次新鲜度（本地时钟）。
       *
       * `未连接` 时**不画**那个带 class 的元素，只留一个灰点 ——
       * 用户原话「没有连接上就消失」，绝不能让断开的样子看起来和正常一样。
       */
      const liveDotStyle = (color, spin) => ({
        display: 'inline-block', width: 10, height: 10, flex: 'none',
        borderRadius: '50%',
        border: '2px solid var(--dsw-alias-border-l1)',
        borderTopColor: spin ? `var(${color})` : 'transparent',
        boxSizing: 'border-box',
      });
      const liveDot = liveTone.spin
        ? h('span', {
            key: 'spin',
            'data-review-spin': '1',
            className: 'review-mode-spin',
            'aria-hidden': true,
            title: '浏览器到宿主的心跳正常',
            style: liveDotStyle(liveTone.color, true),
          })
        : h('span', {
            key: 'spin',
            'data-review-spin': 'off',
            'aria-hidden': true,
            title: liveStatus === 'fail' ? '审核跑不起来' : '心跳没有连接上',
            style: liveDotStyle('--dsw-alias-state-idle-primary', false),
          });
      const liveWhyText = liveStatus === 'down' ? String(liveWhy) : (liveStatus === 'fail' ? String(liveFacts()) : '');
      const liveness = h('div', {
        key: 'liveness',
        'data-review-liveness': liveStatus,
        // 「未连接」和「跑不起来」都必须把原因**写进 DOM**（测试据此断言，用户据此排查）。
        'data-review-liveness-why': liveWhyText.slice(0, 240),
        style: {
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '3px 10px 5px', fontSize: 11, lineHeight: '16px', wordBreak: 'break-word',
        },
      }, [
        liveDot,
        h('span', { key: 'l', style: { color: `var(${liveTone.color})`, fontWeight: 600, flex: 'none' } }, liveTone.label),
        h('span', { key: 'f', style: { color: 'var(--dsw-alias-label-tertiary)' } }, liveFacts()),
      ]);

      /* ── **上一次进程留下的失败**：是事实，但**不是这个面板现在的状态** ────────
       *
       * 2026-10 用户现场读到的那一行逐字是：
       *   `跑不起来 · 审核失败  通道是通的，但最近一次运行失败（6148 秒前）：
       *    developer/message turn must be a non-negative safe integer · UNKNOWN`
       * 6148 秒 ≈ 1.7 小时前，而且是**上一个 DSH 进程**的旧账 —— 那个进程早退出了，
       * 现在这一份宿主一次都没跑过。拿它冒充「现在跑不起来」是假话（宿主侧据此把
       * `turnOutcome` 分成 `lastTurn` / `history`，见 `index.js` 的 `splitTurnOutcome`）。
       *
       * 但也**不许把它藏掉**（这条线的诚实是它最值钱的地方）：所以单独一行、
       * 明说「不在本进程」，灯的判断（绿/灰/转不转）与这条历史事实互不冒充。
       * 只在「已连接 · 监控中」时画 —— 真失败（`fail`）时上面那句已经说了当前的事，
       * 断线（`down`）时屏幕上该说的是「连不上」，不是旧账。
       */
      const historyFact = liveStatus === 'ok' ? (probe.facts?.history ?? null) : null;
      const historyText = historyFact === null || historyFact === undefined ? '' : (() => {
        const when = Number.isFinite(historyFact.ageMs) ? `（${agoText(historyFact.ageMs)}，不在本进程）` : '（不在本进程）';
        const code = String(historyFact.code ?? '').trim();
        const message = String(historyFact.message ?? '').trim();
        if (message === '') return `上次运行失败${when}${code === '' ? '' : ` · ${code}`}`;
        return `上次运行失败${when}：${message}${code === '' ? '' : ` · ${code}`}`;
      })();
      const historyNode = historyText === '' ? null : h('div', {
        key: 'livehistory',
        'data-review-liveness-history': historyText,
        style: {
          padding: '0 10px 5px', fontSize: 10.5, lineHeight: '15px',
          color: 'var(--dsw-alias-label-tertiary)', wordBreak: 'break-word',
        },
      }, historyText);

      // CSS 动画定义跟着面板一起进 DOM（不依赖构建期产物，也不写 document.head）。
      const spinCss = h('style', { key: 'spincss', 'data-review-spin-css': '1' }, SPIN_CSS);
      // 「预留一列」的规则也随面板进 DOM；变量由上面的 effect 写在 shell 的 frame 上。
      const reserveCss = h('style', { key: 'reservecss', 'data-review-reserve-css': '1' }, RESERVE_CSS);
      // 这次实际预留了多少 px（0 = 收起 / 找不到 frame）。测试与排查都读它。
      const reservedWidth = open ? Math.min(width, Math.round((window.innerWidth || 1280) * MAX_RESERVE_RATIO)) : 0;

      /* ── **版本戳**（2026-10-03 现场失败的止血）────────────────────────
       *
       * 现场：DSH 进程 15:39:03 启动，宿主文件 16:20–16:26 才被改 —— 跑的仍是旧代码，
       * 屏幕上却没有任何东西能说明这件事，于是「我改了 / 你重启 / 还是没动」循环了三轮。
       *
       * 这一行永远画（收起面板也在，和活性条同一个位置纪律），内容是：
       *   宿主 <正在运行的那份 index.js 的 mtime> · 进程 <本进程启动时间>
       *   · 页面 <这一页的加载时间> · 界面 <磁盘上 client.js 的 mtime>
       * 两个过期判据（都用宿主报回来的 **disk** mtime 比）：
       *   盘上的宿主文件比运行的新 → 明说「需要重启 DSH」；
       *   盘上的 client.js 比这一页新 → 明说「需要刷新页面」。
       * 零成本：事实全在已有的 `ping` 快照里，不新增任何请求。
       */
      const identity = probe.facts?.identity ?? null;
      const hostStamp = identity?.host ?? null;
      const clientStamp = identity?.client ?? null;
      const clockText = (ms) => (Number.isFinite(Number(ms)) ? new Date(Number(ms)).toTimeString().slice(0, 8) : '—');
      const hostDiskNewer = Number.isFinite(Number(hostStamp?.diskMtimeMs))
        && Number.isFinite(Number(hostStamp?.mtimeMs))
        && Number(hostStamp.diskMtimeMs) > Number(hostStamp.mtimeMs) + STAMP_TOLERANCE_MS;
      const pageDiskNewer = Number.isFinite(Number(clientStamp?.diskMtimeMs))
        && Number(clientStamp.diskMtimeMs) > PAGE_STARTED_AT + STAMP_TOLERANCE_MS;
      const stampParts = [
        `宿主 ${clockText(hostStamp?.mtimeMs)}`,
        `进程 ${clockText(identity?.processStartedAt)}`,
        `页面 ${clockText(PAGE_STARTED_AT)}`,
        `界面 ${clockText(clientStamp?.mtimeMs)}`,
      ];
      if (hostDiskNewer) stampParts.push(`⚠ 盘上的 ${'index.js'} 已是 ${clockText(hostStamp.diskMtimeMs)}，需要重启 DSH`);
      if (pageDiskNewer) stampParts.push(`⚠ 盘上的 client.js 已是 ${clockText(clientStamp.diskMtimeMs)}，需要刷新页面`);
      const stampText = stampParts.join(' · ');
      const stamp = h('div', {
        key: 'stamp',
        'data-review-stamp': stampText,
        'data-review-stamp-page': String(PAGE_STARTED_AT),
        'data-review-stamp-host': clockText(hostStamp?.mtimeMs),
        'data-review-stamp-process': clockText(identity?.processStartedAt),
        'data-review-stamp-stale': hostDiskNewer ? 'host' : (pageDiskNewer ? 'page' : ''),
        style: {
          padding: '2px 10px 4px', fontSize: 10.5, lineHeight: '15px',
          color: (hostDiskNewer || pageDiskNewer) ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-label-tertiary)',
          wordBreak: 'break-word', userSelect: 'text',
        },
      }, stampText);

      /* 调宽度的把手在**左边缘**（面板贴右，宽度往左长）。
       * 顺带把「拖动这里可以调宽度」这句提示留在底部，不然用户不知道能拖。 */
      const grip = open ? h('div', {
        key: 'grip',
        'data-review-grip': 'width',
        onMouseDown: (event) => { dragging.current = { x: event.clientX, width }; },
        title: TEXT.hint,
        style: {
          position: 'absolute', left: 0, top: 0, bottom: 0, width: 5,
          cursor: 'ew-resize', background: 'transparent', userSelect: 'none',
        },
      }) : null;

      const hintLine = open ? h('div', {
        key: 'hintline',
        style: { padding: '2px 10px 0', fontSize: 10.5, color: 'var(--dsw-alias-label-tertiary)', userSelect: 'none' },
      }, `${TEXT.hint} · ≡`) : null;

      /* 根节点的版式：**右侧自己的一列**（贴右边、满高、可拖宽、可收起）。
       *
       * 用户原话：「把审核的这个面板放在最上面或者最右边，对话框放在最下面或者最左边」。
       * 收起时不再整块消失，而是缩成右上角一个小条（标题 + 活性 + 版本戳还在），
       * 所以「有没有连上、跑的是哪一版」永远不会因为收起而看不见。 */
      const rootStyle = open ? {
        position: 'fixed', top: 0, right: 0, bottom: 0, width,
        display: 'flex', flexDirection: 'column', minHeight: 0,
        // `shell.overlay` 那一层是 click-through 的，占位者要自己把指针事件要回来。
        pointerEvents: 'auto',
        borderLeft: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        boxShadow: '-10px 0 28px rgba(0, 0, 0, 0.10)',
        overflow: 'hidden', fontSize: 12.5, lineHeight: '19px',
      } : {
        position: 'fixed', top: 10, right: 10,
        pointerEvents: 'auto',
        maxWidth: 360,
        borderRadius: 10, border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        boxShadow: '0 6px 20px rgba(0, 0, 0, 0.14)',
        overflow: 'hidden', fontSize: 12.5, lineHeight: '19px',
      };

      return h('div', {
        'data-review-mode': 'panel',
        'data-review-region': 'right',
        // 对外声明：这个面板**不覆盖**对话列，而是把 shell 的 frame 右边留出这么多 px。
        'data-review-reserve': String(reservedWidth),
        'data-review-view': VIEW_NAMES[depth] ?? 'pick',
        ref: reserveRef,
        style: rootStyle,
      }, [reserveCss, spinCss, grip, head, updateBar, body, hintLine, liveness, historyNode, stamp, diag].filter(Boolean));
    }

    return {
      // 只声明我们**真的必须有**的那个：slots。
      //
      // 血的教训（就是这一次，2026-10-03）：cordis 的 inject 是**硬依赖**，不是提示。
      // 列进去的服务没到，这个插件就一直 **pending**；而 web boot 把
      // "1 entry did not activate" 当成**启动失败** —— 整个应用打不开，
      // 用户连别的模式都进不去。
      //
      // 我们一度写成 inject: ['slots','remote','remote.reviewRemote']，依据是官方
      // dsh-client-ui-agent-preset 的
      //   ['slots','sessions','locale','remote','remote.agentPresets','remote.settings','configForms']
      // 但官方那几个命名空间**确实存在**，而我们的 `remote.reviewRemote` 究竟有没有
      // 被 Gateway 暴露给浏览器，**始终没有证实过**。一旦没有 → 就是上面那个后果。
      //
      // 所以规矩定死：inject 里只放**已经证实必然存在**的服务；`ctx.remote` 一律在
      // 调用点 try/catch 里现摸，摸不到就退成一句话（面板早有这条兜底）。
      // 宁可少一个功能，也绝不拿"应用能不能打开"去赌。
      inject: ['slots'],
      apply(ctx) {
        pluginCtx = ctx;
        /* 面板挂在 `shell.overlay`（frame 级浮层，**右侧自己的一列**），
         * 不再挂在 `conversation.input.dock`（输入框那张卡里）。
         *
         * 用户原话：「把审核的这个面板放在最上面或者最右边，对话框放在最下面或者最左边」，
         * 以及「我点了之后，审核面板会跳，对话框那边也会跳，它有相冲突」。
         * 在 dock 里时面板**长在 composer 卡片内部**，两个界面抢同一块地方，
         * 所以看起来就是「审核跳进对话框」。
         *
         * 为什么是 `shell.overlay` 而不是右边的列：见 README「面板为什么在浮层里」一节，
         * 那里逐字引了 shipped 插槽目录（`dsh-cordis-client-runner/lib/client.js`）：
         * 右侧栏（`sidebar.right.pane.tab`）只是**一个用户要自己打开的**停靠面里的
         * **tab body**，它的类型必须注册到可选服务 `sidebarRightTabs` 上、还要有人
         * `openTab` 才会出现 —— 而可选服务不能进顶层 inject（进了就是整个应用打不开
         * 的那次事故），于是面板可能根本不可见。
         * `shell.overlay` 是目录里**唯一**「加一条就一定有地方画」的 frame 级席位
         * （`replaceRisk: none`，只依赖我们唯一确信存在的 `slots`）。
         */
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: 'review-mode-panel', order: 5, label: '审核' },
            ReviewPanel,
          ),
        );
        // 面板命令的目录/证据是 JSON，只给面板解析用；对话流里用一行小字代替。
        // keyed slot 的 key 就是命令名（`dsh-client-ui-chat/lib/client.js:6813`
        // 用 `entryKey: command.name` 派发）。注册失败无所谓 —— 面板不受影响。
        try {
          ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register(
            { name: 'conversation.chat.commandview', key: COMMAND },
            ReviewCommandLine,
          ));
        } catch { /* 没有这个插槽就算了 */ }
      },
    };
  },
});
