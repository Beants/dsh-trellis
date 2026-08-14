/**
 * dsh-trellis — Trellis workflow integration for DeepSeek Harness.
 *
 * A Cordis plugin that makes DSH a first-class Trellis platform:
 *
 * 1. Skills — registers the rendered Trellis workflow skills (start, continue,
 *    finish-work, brainstorm, before-dev, check, break-loop, update-spec),
 *    the DSH-adapted sub-agent dispatch definitions (trellis-agent-implement /
 *    trellis-agent-check / trellis-agent-research), and the multi-file
 *    `trellis-meta` skill, all through `ctx.skills`. The skill bodies are the
 *    exact bytes `trellis init --dsh` renders into a project's `.dsh/skills/`
 *    (see scripts/prepare-assets.mjs).
 *
 * 2. Commands —
 *    - `/trellis-init [name]`   scaffold `.trellis/` into the session workspace
 *    - `/trellis-status`        show the current Trellis session state
 *    - `/trellis-start`         session-start guidance (workflow is agent-driven)
 *    - `/trellis-continue`      resume guidance
 *    - `/trellis-finish-work`   finish guidance
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Schema from "@deepseek-ai/schemastery";

/** Cordis plugin name (also the loader entry name). */
export const name = "dsh-trellis";
/** Services this plugin requires. */
export const inject = ["skills", "commands"];

/**
 * Plugin configuration — validated against this schema on load.
 * @typedef {Object} Config
 * @property {boolean} injectWorkflowState - Inject the per-turn <trellis-workflow> breadcrumb into Trellis workspace sessions.
 * @property {number} workflowSectionOrder - Order of the injected prompt section (negative renders early).
 * @property {string} pythonCommand - Python interpreter used to run .trellis/scripts (python on Windows).
 */

/** Schemastery schema for the plugin config (Standard Schema, validated by Cordis). */
export const Config = Schema.object({
  injectWorkflowState: Schema.boolean().default(true),
  workflowSectionOrder: Schema.number().default(-97),
  pythonCommand: Schema.string().default("python3"),
});

/**
 * Packaged skill provider rank — mirrors BUNDLED_SKILL_RANK in
 * @deepseek-ai/dsh-skill (600) without importing the package, so this plugin
 * has zero runtime dependencies beyond Cordis itself.
 */
const BUNDLED_SKILL_RANK = 600;

const ASSETS_DIR = fileURLToPath(new URL("../assets", import.meta.url));
const SKILLS_DIR = path.join(ASSETS_DIR, "skills");
const SCAFFOLD_DIR = path.join(ASSETS_DIR, "scaffold");
const GITIGNORE_HEADER = "# Trellis (managed by dsh-trellis)";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Frontmatter parsing (YAML subset used by Trellis skill files)
// ---------------------------------------------------------------------------

/**
 * Parse the `name`/`description` frontmatter block of a Trellis SKILL.md.
 * Handles single-line quoted and plain scalars plus `|` block scalars.
 * @returns {{ name: string, description: string, body: string } | undefined}
 */
function parseSkillFile(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return undefined;
  const frontmatter = match[1];
  const data = {};
  const lines = frontmatter.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let value = kv[2].trim();
    if (value === "|") {
      // Block scalar: collect more-indented lines
      const block = [];
      while (i + 1 < lines.length && /^[ \t]/.test(lines[i + 1])) {
        block.push(lines[i + 1].trim());
        i += 1;
      }
      value = block.join("\n");
    } else {
      value = value.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
    }
    data[key] = value;
  }
  if (typeof data.name !== "string" || typeof data.description !== "string") {
    return undefined;
  }
  return {
    name: data.name,
    description: data.description,
    body: raw.slice(match[0].length).trim(),
  };
}

/** Read one single-file skill asset. */
function loadSkillAsset(fileName) {
  const raw = readFileSync(path.join(SKILLS_DIR, fileName), "utf-8");
  return parseSkillFile(raw);
}

// ---------------------------------------------------------------------------
// Skill catalog
// ---------------------------------------------------------------------------

/** All single-file skills shipped by this plugin (assets/skills/*.md). */
const SINGLE_FILE_SKILLS = readdirSync(SKILLS_DIR)
  .filter((entry) => entry.endsWith(".md"))
  .sort()
  .map((entry) => {
    const parsed = loadSkillAsset(entry);
    if (!parsed) {
      throw new Error(`dsh-trellis: asset ${entry} has no name/description frontmatter`);
    }
    return { fileName: entry, ...parsed };
  });

/** All multi-file bundled skills (assets/skills/<name>/ with references/). */
const MULTI_FILE_SKILLS = readdirSync(SKILLS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .sort()
  .map((entry) => {
    const parsed = loadSkillAsset(`${entry.name}/SKILL.md`);
    if (!parsed) {
      throw new Error(
        `dsh-trellis: asset ${entry.name}/SKILL.md has no name/description frontmatter`,
      );
    }
    return {
      fileName: `${entry.name}/SKILL.md`,
      dir: path.join(SKILLS_DIR, entry.name),
      ...parsed,
    };
  });

/** Invocation policy advertised to the model and the human UI. */
const INVOCATION = { modelInvocable: true, userInvocable: true };

const PROVIDER_NAME = "dsh-trellis";

function candidateFor(skill, resourceBase) {
  return {
    name: skill.name,
    description: skill.description,
    invocation: INVOCATION,
    provider: PROVIDER_NAME,
    source: "bundled",
    rank: BUNDLED_SKILL_RANK,
    resourceBase,
    locator: skill.fileName,
  };
}

const provider = {
  name: PROVIDER_NAME,
  list: () =>
    Promise.resolve([
      ...SINGLE_FILE_SKILLS.map((skill) => candidateFor(skill)),
      ...MULTI_FILE_SKILLS.map((skill) =>
        candidateFor(skill, { kind: "directory", path: skill.dir }),
      ),
    ]),
  async get(candidate) {
    const multi = MULTI_FILE_SKILLS.find(
      (skill) => skill.name === candidate.name,
    );
    if (multi) {
      return {
        name: multi.name,
        description: multi.description,
        invocation: INVOCATION,
        provider: PROVIDER_NAME,
        source: "bundled",
        resourceBase: { kind: "directory", path: multi.dir },
        content: multi.body,
      };
    }
    const skill = SINGLE_FILE_SKILLS.find((s) => s.name === candidate.name);
    if (!skill) return undefined;
    return {
      name: skill.name,
      description: skill.description,
      invocation: INVOCATION,
      provider: PROVIDER_NAME,
      source: "bundled",
      content: skill.body,
    };
  },
};

// ---------------------------------------------------------------------------
// .trellis scaffolding
// ---------------------------------------------------------------------------

/** Recursively collect the scaffold as { relPath, content } (sorted). */
function collectScaffold(dir = SCAFFOLD_DIR, prefix = "") {
  const files = [];
  for (const entry of readdirSync(dir).sort()) {
    const abs = path.join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(abs).isDirectory()) {
      files.push(...collectScaffold(abs, rel));
    } else {
      files.push({ rel, content: readFileSync(abs, "utf-8") });
    }
  }
  return files;
}

const SCAFFOLD_FILES = collectScaffold();

/** Merge the Trellis gitignore entries into the project .gitignore (append once). */
function mergeGitignore(cwd) {
  const target = path.join(cwd, ".gitignore");
  const extra = readFileSync(path.join(SCAFFOLD_DIR, "gitignore.txt"), "utf-8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  const existing = existsSync(target) ? readFileSync(target, "utf-8") : "";
  const missing = extra.filter((line) => !existing.includes(line));
  if (missing.length === 0) return 0;
  const block = `\n${GITIGNORE_HEADER}\n${missing.join("\n")}\n`;
  writeFileSync(target, existing.endsWith("\n") || existing === "" ? existing + block : existing + "\n" + block);
  return missing.length;
}

/** Resolve the session workspace root for a command invocation. */
function sessionCwd(invocation) {
  const header = invocation.agent?.session?.header;
  if (header && typeof header.cwd === "string") return header.cwd;
  return process.cwd();
}

/** Run a Trellis Python script in the workspace; returns stdout trimmed. */
function runTrellisScript(cwd, script, args, pythonCommand, timeoutMs = 60000) {
  return execFileAsync(pythonCommand, [script, ...args], {
    cwd,
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  }).then(({ stdout }) => stdout.trim());
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** Scaffold `.trellis/` into the session workspace. */
async function handleInit(invocation, pythonCommand) {
  const cwd = sessionCwd(invocation);
  const trellisRoot = path.join(cwd, ".trellis");
  const hadConfig = existsSync(path.join(trellisRoot, "config.yaml"));
  const created = [];
  const skipped = [];

  for (const file of SCAFFOLD_FILES) {
    const target = path.join(trellisRoot, file.rel);
    if (existsSync(target)) {
      skipped.push(file.rel);
      continue;
    }
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, file.content);
    created.push(file.rel);
  }

  const gitignoreAdded = mergeGitignore(cwd);

  const name = invocation.rawInput.trim().split(/\s+/)[0] ?? "";
  let developerNote = "";
  if (name) {
    try {
      const out = await runTrellisScript(
        cwd,
        path.join(".trellis", "scripts", "init_developer.py"),
        [name],
        pythonCommand,
      );
      developerNote = `\nDeveloper: ${out}`;
    } catch (error) {
      developerNote = `\nDeveloper init failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  const lines = [
    hadConfig
      ? "Trellis workspace already initialized — added missing files only."
      : "Trellis workspace initialized.",
    created.length > 0
      ? `Created ${created.length} files (${created.slice(0, 5).join(", ")}${created.length > 5 ? ", …" : ""}).`
      : "No new files needed.",
    skipped.length > 0 ? `Skipped ${skipped.length} existing files.` : "",
    gitignoreAdded > 0 ? `Appended ${gitignoreAdded} entries to .gitignore.` : "",
    developerNote,
    "",
    "Next: describe your development task in the chat — the agent will load the trellis-start skill and drive the Plan → Implement → Verify → Finish loop.",
  ];
  return { kind: "success", text: lines.filter(Boolean).join("\n") };
}

/** Show the current Trellis session state. */
async function handleStatus(invocation, pythonCommand) {
  const cwd = sessionCwd(invocation);
  if (!existsSync(path.join(cwd, ".trellis", "scripts", "get_context.py"))) {
    return {
      kind: "error",
      text: "No .trellis workspace here. Run /trellis-init first (or `trellis init --dsh` in the project).",
    };
  }
  try {
    const out = await runTrellisScript(
      cwd,
      path.join(".trellis", "scripts", "get_context.py"),
      [],
      pythonCommand,
    );
    return { kind: "success", text: out.slice(0, 8000) };
  } catch (error) {
    return {
      kind: "error",
      text: `get_context.py failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Render one workflow guidance skill as command output. */
function guidanceCommand(skillName, hint) {
  return {
    name: `trellis-${skillName}`,
    description: hint,
    async handler(invocation) {
      const cwd = sessionCwd(invocation);
      if (!existsSync(path.join(cwd, ".trellis"))) {
        return {
          kind: "error",
          text: "No .trellis workspace here. Run /trellis-init first.",
        };
      }
      const skill = SINGLE_FILE_SKILLS.find((s) => s.name === `trellis-${skillName}`);
      const body = skill ? skill.body : "";
      return {
        kind: "success",
        text: `${hint}\n\nThe agent drives the Trellis workflow through the trellis-* skills — describe your task in the chat to begin.\n\n---\n\n${body}`,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Per-turn workflow-state injection (the DSH equivalent of Trellis hooks)
//
// Trellis platforms with a hook system (Claude Code, Cursor, Qoder, OpenCode,
// …) ship `session-start` / `inject-workflow-state` hooks that push a
// `<workflow-state>` breadcrumb into every user turn. DSH has no hooks, so
// this plugin replicates the same effect through a per-agent system-prompt
// section whose `text` provider is re-evaluated on every prompt assembly:
// each turn of a Trellis workspace session carries the current task + the
// workflow.md [workflow-state:STATUS] body, keeping long conversations on
// rails exactly like the hook platforms.
// ---------------------------------------------------------------------------

/** Matches workflow.md [workflow-state:STATUS] ... [/workflow-state:STATUS] tag blocks. */
const WORKFLOW_STATE_TAG_RE =
  /\[workflow-state:([A-Za-z0-9_-]+)\]\s*\n([\s\S]*?)\n\s*\[\/workflow-state:\1\]/g;

/** Parse workflow.md tag blocks; workflow.md is the single source of truth. */
function readWorkflowStateTags(cwd) {
  let content;
  try {
    content = readFileSync(path.join(cwd, ".trellis", "workflow.md"), "utf-8");
  } catch {
    return {};
  }
  const tags = {};
  for (const match of content.matchAll(WORKFLOW_STATE_TAG_RE)) {
    const body = match[2].trim();
    if (body) tags[match[1]] = body;
  }
  return tags;
}

/**
 * Resolve the active task (id + status) with sync filesystem reads only —
 * the prompt section provider must stay synchronous. Mirrors Trellis's own
 * single-session fallback: exactly one `.trellis/.runtime/sessions/*.json`
 * file is trusted (multi-window isolation contract), then the legacy
 * `.trellis/.current-task` pointer.
 */
function resolveActiveTaskSync(cwd) {
  const trellisRoot = path.join(cwd, ".trellis");
  let ref = null;

  const sessionsDir = path.join(trellisRoot, ".runtime", "sessions");
  try {
    const files = readdirSync(sessionsDir).filter((f) => f.endsWith(".json"));
    if (files.length === 1) {
      const data = JSON.parse(
        readFileSync(path.join(sessionsDir, files[0]), "utf-8"),
      );
      if (typeof data?.current_task === "string" && data.current_task) {
        ref = data.current_task;
      }
    }
  } catch {
    /* no runtime sessions yet */
  }
  if (!ref) {
    try {
      const legacy = readFileSync(
        path.join(trellisRoot, ".current-task"),
        "utf-8",
      ).trim();
      if (legacy) ref = legacy;
    } catch {
      /* no legacy pointer */
    }
  }
  if (!ref) return null;

  const candidates = [
    path.join(trellisRoot, "tasks", ref),
    path.join(cwd, ref),
  ];
  for (const taskDir of candidates) {
    let data;
    try {
      data = JSON.parse(
        readFileSync(path.join(taskDir, "task.json"), "utf-8"),
      );
    } catch {
      continue;
    }
    const status = typeof data?.status === "string" ? data.status : null;
    if (!status) return null;
    return {
      id: typeof data?.id === "string" && data.id ? data.id : ref.split("/").pop(),
      status,
    };
  }
  return null;
}

/**
 * Build the per-turn `<trellis-workflow>` block for one workspace, or ""
 * when the workspace is not a Trellis project (contributes nothing).
 */
function buildTrellisContext(cwd) {
  if (!existsSync(path.join(cwd, ".trellis", "workflow.md"))) return "";
  const tags = readWorkflowStateTags(cwd);
  const task = resolveActiveTaskSync(cwd);
  const status = task ? task.status : "no_task";
  const body =
    tags[status] ?? "Refer to .trellis/workflow.md for the current step.";
  const header = task ? `Task: ${task.id} (${status})` : `Status: ${status}`;
  return [
    "<trellis-workflow>",
    header,
    body,
    "",
    "This workspace uses the Trellis workflow. Follow it: load the `trellis-start` skill at session start and when a new task arrives, route per the skill routing table in `.trellis/workflow.md`, and run `python3 .trellis/scripts/get_context.py` / `task.py current` for live state. Do not skip the DO-NOT-skip steps.",
    "</trellis-workflow>",
  ].join("\n");
}

/** Whether this agent is a sub-agent (its prompt already carries task context). */
function isSubagent(agent) {
  return agent.session?.header?.parentSession !== undefined;
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

/** Cordis plugin apply function. */
export function apply(ctx, config) {
  ctx.skills.registerProvider(() => provider);

  // Per-turn Trellis workflow breadcrumb — the hook-platform equivalent. Each
  // agent whose workspace is a Trellis project gets a prompt section that is
  // re-evaluated on every assembly, so every turn carries the workflow state.
  if (config.injectWorkflowState) {
    ctx.on("agent/created", ({ agent }) => {
      if (isSubagent(agent)) return;
      const cwd = agent.session?.header?.cwd;
      if (typeof cwd !== "string") return;
      if (!existsSync(path.join(cwd, ".trellis", "workflow.md"))) return;
      agent.ctx.inject(["systemPrompt"], (promptCtx) => {
        promptCtx.systemPrompt.section({
          name: "app:trellis",
          order: config.workflowSectionOrder,
          text: () => buildTrellisContext(cwd),
        });
      });
    });
  }

  ctx.commands.register({
    name: "trellis-init",
    description: "Initialize a Trellis workspace (.trellis/) in this project.",
    input: { hint: "developer name (optional)" },
    handler: (invocation) => handleInit(invocation, config.pythonCommand),
  });
  ctx.commands.register({
    name: "trellis-status",
    description: "Show the current Trellis session state.",
    handler: (invocation) => handleStatus(invocation, config.pythonCommand),
  });
  ctx.commands.register(
    guidanceCommand(
      "start",
      "Initialize a Trellis development session.",
    ),
  );
  ctx.commands.register(
    guidanceCommand(
      "continue",
      "Resume work on the current task at the correct phase.",
    ),
  );
  ctx.commands.register(
    guidanceCommand(
      "finish-work",
      "Wrap up the current session: quality gate, commit reminder, archive, journal.",
    ),
  );
}
