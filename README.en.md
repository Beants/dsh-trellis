# dsh-trellis

[简体中文](README.md) · English

> Bring the [Trellis](https://github.com/mindfold-ai/Trellis) task-driven development workflow into [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh): full Trellis skill set, `/trellis-*` commands, one-shot `.trellis/` scaffolding, and per-turn workflow-state injection — no hooks required.

The primary documentation is [Chinese](README.md). This page is a condensed English reference.

## Highlights

- **15 Trellis skills** — session commands (`trellis-start/continue/finish-work`), the five workflow skills (`brainstorm`, `before-dev`, `check`, `break-loop`, `update-spec`), DSH-adapted sub-agent dispatch definitions (`trellis-agent-implement/check/research`), and bundled skills (`trellis-channel`, `trellis-session-insight`, `trellis-spec-bootstrap`, `trellis-meta`).
- **`/trellis-*` commands** — `/trellis-init` scaffolds `.trellis/`; `/trellis-status` shows session state; the workflow commands render session guidance.
- **Per-turn workflow-state injection** — DSH has no hook system, so the plugin re-implements Trellis's `inject-workflow-state` via a per-agent system-prompt section re-evaluated on every prompt assembly (`<trellis-workflow>` with the active task + workflow.md phase guidance).
- **Self-contained** — no runtime dependency on the Trellis CLI; assets regenerate via `scripts/prepare-assets.mjs`.

## Install

```sh
dsh plugin --profile web add git+https://github.com/Beants/dsh-trellis.git
```

Enable in `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - name: dsh-trellis
      config: {}
```

Restart `dsh web`, then in any session: `/trellis-init your-name`, then describe a development task — the agent runs the Trellis Plan → Implement → Verify → Finish loop.

## Configuration

```yaml
- id: dsh-trellis
  name: dsh-trellis
  config:
    injectWorkflowState: true    # per-turn <trellis-workflow> breadcrumb (default true)
    workflowSectionOrder: -97    # prompt section order (default -97)
    pythonCommand: python3       # Python interpreter; set to `python` on Windows
```

## Hook equivalence

| Upstream hook | dsh-trellis equivalent |
| --- | --- |
| `session-start` | `trellis-start` skill — the model runs `get_context.py` via bash (pull-based) |
| `inject-workflow-state` | `app:trellis` prompt section, re-evaluated every prompt assembly |
| `inject-subagent-context` | `Active task: <path>` prelude in `trellis-agent-*` dispatch prompts |

## Upstream Trellis

The Trellis CLI (`packages/cli`) registers a `dsh` platform: `trellis init --dsh` writes the same skills into `.dsh/skills/` for team repos; the plugin adds commands/scaffolding on top.

## Credits

Built **entirely by a DeepSeek V4 Flash (max reasoning effort) session inside DeepSeek Harness** — design, implementation, the 292-commit upstream merge (7 conflicts, 1672 tests green), and the GitHub release were all done in-session.

## License

AGPL-3.0-only (skill content and scaffold derived from [`@mindfoldhq/trellis`](https://www.npmjs.com/package/@mindfoldhq/trellis)).
