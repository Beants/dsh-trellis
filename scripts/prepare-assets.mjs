#!/usr/bin/env node
/**
 * prepare-assets.mjs — regenerate the plugin's Trellis skill assets from the
 * Trellis CLI's `init --dsh` rendering.
 *
 * The DSH plugin bundles the *rendered* Trellis skill content (the same bytes
 * `trellis init --dsh` writes into a project's `.dsh/skills/`), so the plugin
 * stays self-contained and byte-consistent with upstream Trellis.
 *
 * Usage:
 *   node scripts/prepare-assets.mjs [path-to-trellis-cli]
 *
 * `path-to-trellis-cli` defaults to ../Trellis/packages/cli/dist/cli/index.js
 * (relative to this repo root). Run `pnpm build` in the Trellis package first.
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const cliDefault = resolve(root, "..", "Trellis", "packages", "cli", "dist", "cli", "index.js");
const cli = resolve(process.argv[2] ?? cliDefault);

if (!existsSync(cli)) {
  console.error(`Trellis CLI not found: ${cli}`);
  console.error("Build it first: cd ../Trellis/packages/cli && pnpm build");
  process.exit(1);
}

/** Keep the SKILL.md body verbatim (frontmatter is parsed by the plugin). */
function keepBody(content) {
  return content;
}

const scratch = mkdtempSync(join(tmpdir(), "dsh-trellis-assets-"));
try {
  execFileSync("git", ["init", "-q"], { cwd: scratch, stdio: "ignore" });
  execFileSync(process.execPath, [cli, "init", "--dsh", "-y"], {
    cwd: scratch,
    stdio: "pipe",
    env: { ...process.env, TRELLIS_QUIET: "1" },
  });
} catch (error) {
  console.error("trellis init --dsh failed:", error.message);
  process.exit(1);
}

const skillsRoot = join(scratch, ".dsh", "skills");
const assetsSkills = join(root, "assets", "skills");
rmSync(assetsSkills, { recursive: true, force: true });
mkdirSync(assetsSkills, { recursive: true });

let count = 0;
for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const skillDir = join(skillsRoot, entry.name);
  const skillFile = join(skillDir, "SKILL.md");
  if (!existsSync(skillFile)) continue;

  // Multi-file bundled skills (SKILL.md + references/): ship the whole
  // rendered tree — references resolve through the skill's resourceBase
  // directory. Single-file skills ship as one `<name>.md` body.
  const isMultiFile = readdirSync(skillDir).some((name) => name !== "SKILL.md");
  if (isMultiFile) {
    cpSync(skillDir, join(assetsSkills, entry.name), { recursive: true });
    count += 1;
    continue;
  }
  writeFileSync(
    join(assetsSkills, `${entry.name}.md`),
    keepBody(readFileSync(skillFile, "utf-8")),
  );
  count += 1;
}

// Mirror the current .trellis/ scaffold (workflow.md, config.yaml, scripts,
// agents/, gitattributes/gitignore) from the Trellis template dir so the
// plugin's /trellis-init writes 0.6.x-identical content.
const scaffoldSource = join(root, "..", "Trellis", "packages", "cli", "src", "templates", "trellis");
const assetsScaffold = join(root, "assets", "scaffold");
rmSync(assetsScaffold, { recursive: true, force: true });
mkdirSync(assetsScaffold, { recursive: true });
for (const name of readdirSync(scaffoldSource)) {
  if (name === "index.ts") continue;
  cpSync(join(scaffoldSource, name), join(assetsScaffold, name), { recursive: true });
}
mkdirSync(join(assetsScaffold, "spec"), { recursive: true });
mkdirSync(join(assetsScaffold, "workspace"), { recursive: true });

rmSync(scratch, { recursive: true, force: true });
console.log(`Prepared ${count} skill assets under assets/skills/ and scaffold under assets/scaffold/`);
