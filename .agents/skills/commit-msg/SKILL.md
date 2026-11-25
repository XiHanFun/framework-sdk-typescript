---
name: xihan-sdk-typescript-commit-msg
description: 根据 TypeScript SDK 当前暂存区生成一行提交信息时使用，适用于「提交信息」「commit msg」「msg」或提交前概括 staged changes；只生成消息，不负责暂存、解决冲突或执行提交。
---

# TypeScript SDK 提交信息

1. 检查 `git status --short --branch`；存在冲突、merge 或 rebase 时先报告，不生成完成态消息。
2. 只读取 `git diff --cached --stat`、完整 staged diff 和最近 20 条提交。暂存区为空时不从未暂存内容猜测。
3. 将全部暂存变化归纳成一个意图，输出一行 Conventional Commit。

格式：`<type>(<scope>): <中文说明>`。type 使用 `feat`、`fix`、`refactor`、`perf`、`docs`、`style`、`test`、`build`、`ci`、`chore`、`revert`。

scope 用本仓库的模块名：`primitives`、`manifest`、`invocation`、`pipeline`、`operation`、`plugin`、`conformance`（向量覆盖与黑盒运行器的测试），或 `spec`（只升规范指针）、`docs`、`build`、`ci`。跨多个模块的同一修复取最主要的模块，不逐个罗列。

说明写使用者能看到的结果；对齐规范的改动末尾注 ADR。只升规范指针的写 `build(spec): 规范指针升到 <短哈希>（ADR-NNNN）`，与实现同一提交时不另写指针哈希。删除、改名或改变公开导出、错误码、消息键与线上编码时使用 `!`。

## 写短

- 只写一行标题，不写正文。
- 说明一句话讲这次改动的结果，不超过 40 个字：汉字、字母、数字、标点各算一个，末尾的 `（ADR-NNNN）` 不计。
- 说明里不再出现「：」「；」，除末尾的 ADR 注外不用括号或破折号补充；不罗列文件、成员、取值与改前改后，不写向量与测试的数量、门禁结果，这些写进 文档页、ADR 或 PR 描述。
- 40 个字写不下时，多半是暂存区混了几件事（先建议拆成几笔），或细节写多了（删到只剩结果），不要加长标题。

不要：`feat(plugin): 配置回调拿到的绑定带属性（ADR-0285）：PluginBinding 新增 properties（ReadonlyMap<string, string>）……`

要：`feat(plugin): 配置回调拿到的绑定带属性（ADR-0285）`

只要求消息时最终只输出一行标题，不附解释或候选列表。
