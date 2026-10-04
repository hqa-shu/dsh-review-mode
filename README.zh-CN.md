# DSH Review Mode · 审核模式

**给 AI 对话一个独立的复审视角。**

**正在开发中，尚非稳定版本。** 这是面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的社区实验插件，可以读取本机 Codex 对话。它不是 DeepSeek 或 OpenAI 官方产品；包内 `2.1.0` 是经过本机体验测试的开发快照，不代表已正式发布。

本版完成十轮真实修改、重启和模拟用户操作，另做五轮回归修复。面板显示可展开的短洞察；新结果提示可直达最新评价；重启后恢复目标、侧重点和暂停状态。详见[当前实现](CURRENT-IMPLEMENTATION.md)与[迭代记录](ITERATIONS.md)。模型判断仍需人工核对。

[English](README.md) · [安装说明](docs/INSTALLATION.md) · [完整配置](docs/CONFIGURATION.md) · [架构](docs/ARCHITECTURE.md) · [开发路线](docs/ROADMAP.md)

## 想解决什么问题？

AI 一直在回答，不一定意味着任务一直在前进。对话可能偏离最初目标，把局部细节越磨越细，或者把缺少证据的判断说得很确定。

审核模式尝试把“做事”和“复审”分开：宿主整理有限证据，交给独立上下文的复审 Agent，再把具体分析显示在旁边的面板里。它从**主题漂移、局部纠结、选择是否合理**切入，也区分用户的指令、整段对话和 AI 的回答。

## 当前实现

- 选择当前 DSH 会话、其他 DSH 会话或本机 Codex 对话。
- 在目标出现新的用户消息后触发复审；检测循环与调用模型分开。
- 输出原话、对话概述、具体分析和可执行建议，分析条数随内容变化。
- 控制证据长度，被省略的证据明确标注。
- 显示未开始、复审中、失败和已有结果，提供运行版本与活性诊断。
- 复审员不具备工具权限；宿主负责读盘、整理证据与投递结果。

这些是代码中的机制，**不等于已经证明审核准确、兼容所有版本或达到生产可用**。测试范围和不足见 [VALIDATION.md](docs/VALIDATION.md)。

## 开始使用开发快照

目前基线：macOS arm64、DeepSeek Harness Desktop `0.2.0-rc.2`；开发检查使用 Node.js 24+。

```sh
git clone https://github.com/hqa-shu/dsh-review-mode.git
cd dsh-review-mode
node scripts/prepare-runtime.mjs
node scripts/check.mjs
node scripts/run-tests.mjs
```

准备脚本仅从已安装的 Harness 读取所需 SDK 包，写入本仓库被忽略的 `node_modules/`。之后在 Harness 的 **Plugins** 页面，通过仓库的绝对路径安装；重启后创建“审核模式”会话，在面板选择目标。完整步骤、配置示例和故障处理见 [安装指南](docs/INSTALLATION.md)。其他人的全新环境安装尚待验证。

## 使用前理解数据流

本机读取日志，**并不代表模型只在本机运行**。选中的证据会交给 Harness 配置的模型供应方；使用远程模型时，证据会离开电脑。当前不保证自动去除密钥或私人信息。先用无敏感信息的测试对话，详见 [PRIVACY.md](docs/PRIVACY.md)。

## 欢迎参与

欢迎提供可复现的 UI 问题、版本兼容性报告、证据截断案例，以及“这条建议为什么有用 / 没用”的合成对话。先阅读 [贡献说明](CONTRIBUTING.md)，提交报告前移除私人内容。

作者：[Qian'an Huang](https://github.com/hqa-shu)。关注实际 AI Agent 开发、评估与人机协作。

初始快照尚未选择许可证；公开可见不等于授予通用再分发授权。宿主 SDK 不随仓库分发。
