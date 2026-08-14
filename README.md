# dsh-trellis

简体中文 · [English](README.en.md)

> 把 [Trellis](https://github.com/mindfold-ai/Trellis) 任务驱动开发工作流集成进
> [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）：
> 全套 Trellis 技能、`/trellis-*` 命令、一键 `.trellis/` 脚手架、每轮工作流状态注入——DSH 没有 hook 也能跑。

生态话题：`#dsh-plugin` · `#dsh` · `#trellis`

本项目（本插件 + Trellis 上游的 `dsh` 平台注册）**完全由 DeepSeek V4 Flash
（max reasoning effort）+ DeepSeek Harness 会话完成**，见
[本项目是如何实现的](#本项目是如何实现的)。

## 特性

| 能力 | 说明 |
| --- | --- |
| **15 个 Trellis 技能** | `trellis-start` / `continue` / `finish-work`、五个工作流技能（`brainstorm` / `before-dev` / `check` / `break-loop` / `update-spec`）、DSH 版子代理派发定义（`trellis-agent-implement/check/research`）、内置技能（`trellis-channel` / `trellis-session-insight` / `trellis-spec-bootstrap` / `trellis-meta`） |
| **`/trellis-*` 命令** | `/trellis-init` 在会话工作区一键生成 `.trellis/`；`/trellis-status` 查看会话状态；`/trellis-start` / `continue` / `finish-work` 会话指引 |
| **每轮工作流状态注入** | DSH 没有 hook，插件用 per-agent 的 systemPrompt section（每次 prompt 组装重新求值）复刻 Trellis 的 `inject-workflow-state`——每轮都携带当前任务 + workflow.md 的阶段指引 |
| **完全自包含** | 运行时不依赖 Trellis CLI：渲染好的技能内容与 `.trellis/` 脚手架都随包分发，上游更新后用 `scripts/prepare-assets.mjs` 一键再生成 |

## 工作原理（与 hook 平台的对照）

Trellis 在带 hook 的平台（Claude Code、Cursor、Qoder、OpenCode…）上自动注入上下文。
DSH 没有 hook，本插件把每个 hook 映射为 DSH 的等价机制：

| 上游 hook | 做的事 | dsh-trellis 的等价实现 |
| --- | --- | --- |
| `session-start` | 首条消息注入完整会话上下文 | `trellis-start` 技能：模型按技能指示用 bash 跑 `get_context.py`（pull-based；DSH 的 prompt section 必须同步，无法直接执行 Python） |
| `inject-workflow-state` | **每一轮**注入 `<workflow-state>` 面包屑（workflow.md 的 `[workflow-state:STATUS]` 标签 + 当前 task.json 状态） | `app:trellis` prompt section，**每次** prompt 组装重新求值：`<trellis-workflow>` 块带 `Task: <id> (<status>)` 与 workflow.md 对应阶段的指引正文 |
| `inject-subagent-context` | 子代理 prompt 注入 prd/implement.jsonl 上下文 | `trellis-agent-*` 技能的 pull-based prelude：派发 prompt 首行 `Active task: <path>`，子代理自行读取 prd.md / implement.jsonl |

行为细节：

- 面包屑只注入**主会话**（子代理的派发 prompt 自带任务行，与上游跳过子代理的行为一致）；
- 任务状态解析对齐 Trellis 自身契约：只信任 `.trellis/.runtime/sessions/` 下**恰好一个**指针文件（多窗口隔离），再回退 `.trellis/.current-task`；
- 非 Trellis 工作区完全不打扰（不注册 section）。

### 注入效果示例

每轮 prompt 组装时，`app:trellis` section 会注入类似下面的块（正文来自
workflow.md 对应 `[workflow-state:STATUS]` 标签，不是写死的文案）：

```xml
<trellis-workflow>
Status: no_task
No active task. First classify the current turn and ask for task-creation consent before creating any Trellis task.
Simple conversation / small task: ask only whether this turn should create a Trellis task. ...

This workspace uses the Trellis workflow. Follow it: load the `trellis-start` skill at session start and when a new task arrives, route per the skill routing table in `.trellis/workflow.md`, and run `python3 .trellis/scripts/get_context.py` / `task.py current` for live state. Do not skip the DO-NOT-skip steps.
</trellis-workflow>
```

有活动任务时，首行变成 `Task: <id> (<status>)`，正文换成对应阶段（
`planning` / `in_progress` / `completed`…）的指引。完整会话上下文
（developer、git 状态、spec 索引）仍需模型按 `trellis-start` 技能用 bash
拉取——注入的是"轨道"，不是"全量数据"。

## 前置要求

- 正在运行的 DeepSeek Harness profile（如 `dsh web`）
- Python 3.9+（跑 `.trellis/scripts/` 的 `task.py`、`get_context.py` 等）
- PATH 上有 `pnpm`（`dsh plugin` 依赖）

## 安装

```sh
# 从 GitHub 安装（公开仓库）
dsh plugin --profile web add git+https://github.com/Beants/dsh-trellis.git

# 或本地 checkout
dsh plugin --profile web add /path/to/dsh-trellis
```

在 `~/.dsh/profiles/web/cordis.patch.yml` 中启用（追加一条顶层 insert）：

```yaml
- insert:
    - name: dsh-trellis
      config: {}
```

验证并重启：

```sh
dsh --profile web --dump-config   # 组合树中出现 dsh-trellis 行
# 重启 dsh web，然后刷新浏览器
```

## 快速开始

1. 把会话工作区切到你的项目。
2. 执行 `/trellis-init 你的名字`——生成 `.trellis/`（config.yaml、workflow.md、scripts/、agents/ 等）并追加 .gitignore 条目。
3. 用自然语言描述开发任务。agent 会加载 `trellis-start`，走 规划 → 实现 → 验证 → 收尾 循环：brainstorm 产出 `prd.md`、派发 `trellis-agent-implement` / `trellis-agent-check` 子代理实现与校验，最后 `trellis-finish-work` 归档任务并写工作日志。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/trellis-init [名字]` | 在会话工作区生成/补齐 `.trellis/` |
| `/trellis-status` | 查看当前任务、git 状态、激活任务 |
| `/trellis-start` / `/trellis-continue` / `/trellis-finish-work` | 会话入口 / 续作 / 收尾指引 |

## 配置

插件导出 Schemastery `Config` schema（可在 profile 的 patch 层覆盖）：

```yaml
- id: dsh-trellis
  name: dsh-trellis
  config:
    injectWorkflowState: true    # 是否注入每轮 <trellis-workflow> 面包屑（默认 true）
    workflowSectionOrder: -97    # prompt section 顺序（默认 -97）
    pythonCommand: python3       # .trellis/scripts 的解释器；Windows 上设为 python
```

## 技能清单

| 技能 | 作用 |
| --- | --- |
| `trellis-start` | 会话入口：加载工作流上下文并路由任务 |
| `trellis-brainstorm` | 需求澄清：逐题提问、调研、收敛 MVP，产出 prd.md |
| `trellis-before-dev` | 编码前注入 `.trellis/spec/` 规范 |
| `trellis-check` | 质量校验：spec 合规 + lint/typecheck/test + 跨层检查 |
| `trellis-break-loop` | 深层 bug 分析，沉淀防复发机制 |
| `trellis-update-spec` | 把新认知写回 `.trellis/spec/` |
| `trellis-continue` / `trellis-finish-work` | 续作 / 收尾（归档 + 日志） |
| `trellis-agent-implement` / `trellis-agent-check` / `trellis-agent-research` | DSH 版子代理派发定义（`subagent` 工具 prompt 模板） |
| `trellis-channel` | 实时多 agent 协作：spawn 工作线程、跨 agent 审查、进度检查、forum 频道 |
| `trellis-session-insight` | 通过 `trellis mem` 检索历史会话记忆 |
| `trellis-spec-bootstrap` | 用 GitNexus 分析代码库 → 生成/刷新 `.trellis/spec/` |
| `trellis-meta` | Trellis 本地架构与自定义指南（多文件，含 references） |

## 开发（资产再生成）

`assets/skills/` 是 `trellis init --dsh` 的渲染产物（与写入项目的字节一致），
`assets/scaffold/` 是 `.trellis/` 模板镜像。上游模板更新后一并重新生成：

```sh
cd ../Trellis/packages/cli && pnpm build
cd ../../dsh-trellis && node scripts/prepare-assets.mjs   # 同步 skills + scaffold
```

## 与 Trellis 上游的配合

本插件完全自包含（运行时行为与 `trellis init --dsh` 等价，见上方对照表）。
此外，Trellis CLI（`packages/cli`）现已注册 `dsh` 平台：

- `trellis init --dsh` 会把同样的技能写入项目 `.dsh/skills/`，DSH 的文件系统
  技能提供者会自动发现（项目级优先）——适合团队仓库共享标准；
- 插件侧提供命令、脚手架与会话体验，两者可同时使用，内容保持一致。

## 本项目是如何实现的

本项目（本插件 + Trellis 上游的 `dsh` 平台注册）**完全由 DeepSeek V4 Flash
（max reasoning effort）+ DeepSeek Harness (dsh) 会话完成**，无人工手写代码：

- **设计**：研究 DSH 的 Cordis 插件机制（`ctx.skills` / `ctx.commands` /
  `systemPrompt.section` / `agent/created` 事件）与 Trellis 的 14 平台集成架构
  （`AI_TOOLS` 注册表 + configurator + 模板渲染），推导出 DSH 无 hook 场景下的
  hook 等价注入方案；
- **实现**：技能内容由 Trellis CLI 的渲染产物同步（`prepare-assets.mjs`），
  命令、脚手架、面包屑注入均在会话中编写；
- **上游合并**：拉取落后 292 个提交，解决 7 处冲突（含上游新增 7 个平台），
  1672 个测试全绿后推送；
- **发布**：GitHub CLI 建仓、topic、可见性配置均在本会话完成。

## License

AGPL-3.0-only。技能内容与 `.trellis/` 脚手架派生自
[`@mindfoldhq/trellis`](https://www.npmjs.com/package/@mindfoldhq/trellis)
（AGPL-3.0），见 `LICENSE`。
