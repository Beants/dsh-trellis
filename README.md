# dsh-trellis

把 [Trellis](https://github.com/mindfold-ai/Trellis) 工作流集成进
[DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 的
Cordis 插件：注册 Trellis 全套技能（`trellis-start` / `trellis-brainstorm` /
`trellis-implement` / `trellis-check` / `trellis-finish-work` 等）、提供
`/trellis-*` 命令，并可在会话工作区一键初始化 `.trellis/` 结构。

> 配套的上游支持：Trellis CLI 现已支持 `trellis init --dsh`，可在项目里直接
> 生成 `.dsh/skills/`（见 [Trellis 仓库的 dsh 平台注册](#trellis-上游-dsh-平台)）。

## 本项目是如何实现的

本项目（本插件 + Trellis 上游的 `dsh` 平台注册）**完全由 DeepSeek V4 Flash
（max reasoning effort）+ DeepSeek Harness (dsh) 会话完成**，无人工手写代码：

- 插件设计：研究 DSH 的 Cordis 插件机制（`ctx.skills` / `ctx.commands` /
  `systemPrompt.section` / `agent/created` 事件）与 Trellis 的 14 平台
  集成架构（`AI_TOOLS` 注册表 + configurator + 模板渲染），确定 DSH 无 hook
  场景下的等价注入方案（pull-based 技能 + 每轮重算的 prompt section）；
- 实现：技能内容由 Trellis CLI `init --dsh` 渲染产物同步（`prepare-assets.mjs`），
  命令、脚手架、面包屑注入均为 dsh 会话中编写；
- 上游合并：拉取 Trellis 292 个落后提交，解决 7 处冲突（含上游新增 7 个平台），
  1672 个测试全绿后推送；
- 发布：GitHub CLI 建仓、topic、可见性配置均在本会话完成。

## 安装（web profile 示例）

```bash
# 1. 把插件加入 profile 的依赖（pnpm add 转发）
dsh plugin --profile web add /path/to/dsh-trellis

# 2. 在 ~/.dsh/profiles/web/cordis.patch.yml 中启用（追加一条顶层 insert）：
#    - insert:
#        - name: dsh-trellis
#          config: {}

# 3. 重启 dsh web（或等待 loader 热加载），刷新浏览器
```

## 用法

初始化 Trellis 工作区（当前会话的 cwd 会被自动识别）：

- `/trellis-init [你的名字]` — 生成 `.trellis/`（config.yaml、workflow.md、
  scripts/task.py、get_context.py、add_session.py 等）+ 追加 .gitignore 条目；
  带名字时同时初始化 developer identity。
- `/trellis-status` — 查看当前会话状态（当前任务、git 状态、激活任务列表）。
- `/trellis-start` / `/trellis-continue` / `/trellis-finish-work` —
  会话/续作/收尾指引。

之后直接在对话里描述开发任务即可：agent 会通过 `skill` 工具加载
`trellis-start` → 按需进入 `trellis-brainstorm`（需求澄清 → PRD）→ 派发
`trellis-agent-implement` / `trellis-agent-check` 子代理实现与校验 → 收尾时
`trellis-finish-work` 归档任务并写工作日志。完整 4 阶段循环见项目内的
`.trellis/workflow.md`。

## 插件提供的技能

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
| `trellis-channel` | 实时多 agent 协作：spawn 工作线程、跨 agent 审查、进度检查、forum 频道、channel 日志调试 |
| `trellis-session-insight` | 通过 `trellis mem` 检索历史会话记忆（"上次怎么解决的 X"） |
| `trellis-spec-bootstrap` | 用 GitNexus 分析代码库并引导生成/刷新 `.trellis/spec/` 规范 |
| `trellis-meta` | Trellis 本地架构与自定义指南（多文件，含 references） |

## 与 hook 平台的机制对照

Trellis 在 Claude Code / Cursor / Qoder / OpenCode 等平台通过 Python/JS hook
自动注入上下文。DSH 没有 hook 系统，本插件用 DSH 的等价机制实现同样的效果：

| 上游 hook | 做的事情 | 本插件的等价实现 |
| --- | --- | --- |
| `session-start` | 会话开始时注入完整工作流上下文（get_context.py 输出） | `trellis-start` 技能：模型按技能指示用 bash 运行 get_context.py 拉取（pull-based；DSH 的 prompt section 必须同步，无法直接执行 Python） |
| `inject-workflow-state` | **每一轮**向模型注入 `<workflow-state>` 面包屑（workflow.md 的 `[workflow-state:STATUS]` 标签 + 当前 task.json 状态） | **每轮 prompt 组装时求值的 systemPrompt section**：`app:trellis` 段把 `<trellis-workflow>`（当前任务/阶段 + 对应阶段的指引正文）钉进每轮上下文。机制不同但效果等价——DSH 的 section 每轮重算，比往会话历史里塞消息更干净 |
| `inject-subagent-context` | 主 agent 派发子代理时把 prd/implement.jsonl 上下文注入子代理 prompt | `trellis-agent-implement/check/research` 技能的 pull-based prelude：派发 prompt 首行 `Active task: <path>`，子代理自行读取 prd.md / implement.jsonl |

行为细节：

- 面包屑只在**主会话**注入（子代理的 prompt 已带任务行，与上游 hook 跳过子代理
  的行为一致）；
- 任务状态解析对齐 Trellis 自身契约：只信任 `.trellis/.runtime/sessions/` 下
  **恰好一个**指针文件（多窗口隔离），再回退 `.trellis/.current-task`；
- 非 Trellis 工作区完全不打扰（不注册 section）。

## 配置

插件导出 Schemastery `Config` schema（在 profile 的 `cordis.patch.yml` 中覆盖）：

```yaml
- id: dsh-trellis
  name: dsh-trellis
  config:
    injectWorkflowState: true    # 是否注入每轮 <trellis-workflow> 面包屑（默认 true）
    workflowSectionOrder: -97    # prompt section 顺序（默认 -97）
    pythonCommand: python3       # .trellis/scripts 的解释器；Windows 上设为 python
```

## 资产再生成

`assets/skills/` 是 Trellis CLI `init --dsh` 的渲染产物（与写入项目的字节
一致），`assets/scaffold/` 是 `.trellis/` 模板镜像。上游更新后一并重新生成：

```bash
cd ../Trellis/packages/cli && pnpm build
cd ../../dsh-trellis && node scripts/prepare-assets.mjs   # 同步 skills + scaffold
```

## 与 Trellis 上游的配合

本插件自带完整 `.trellis/` 脚手架和渲染后的技能，自包含可用（运行时行为与
`trellis init --dsh` 完全等价，见上方对照表）。同时 Trellis 上游
（`packages/cli`）已注册 `dsh` 平台：

- `trellis init --dsh` 会把同样的技能写入项目 `.dsh/skills/`（DSH 的文件系统
  技能提供者会自动发现项目级 `.dsh/skills/` 与 `.agents/skills/`），适合团队
  仓库内共享标准；
- 插件侧则提供命令（init/status/指引）与开箱即用的会话体验，两者可同时使用，
  内容保持一致。

## License

AGPL-3.0-only。技能内容与 `.trellis/` 脚手架派生自
[`@mindfoldhq/trellis`](https://www.npmjs.com/package/@mindfoldhq/trellis)
（AGPL-3.0），见 `LICENSE`。
