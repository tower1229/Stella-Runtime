import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repositoryRoot = new URL("../../", import.meta.url);

test("packed plugin exposes self-check and Skill to exact OpenClaw host", async () => {
  const root = await mkdtemp(join(tmpdir(), "stella-runtime-openclaw-"));
  const environment = {
    ...process.env,
    HOME: root,
    OPENCLAW_CONFIG_PATH: join(root, "openclaw.json"),
    OPENCLAW_STATE_DIR: join(root, "state"),
    npm_config_cache: join(root, "npm-cache"),
  };
  const { stdout: versionOutput } = await execFileAsync(
    "openclaw",
    ["--version"],
    { env: environment },
  );
  assert.match(versionOutput, /2026\.6\.34/);

  const { stdout: packOutput } = await execFileAsync(
    "npm",
    [
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      root,
    ],
    { cwd: repositoryRoot, env: environment },
  );
  const [pack] = JSON.parse(packOutput);
  const tarball = join(root, pack.filename);

  await execFileAsync("openclaw", ["plugins", "install", tarball], {
    env: environment,
  });

  const { stdout: inspectOutput } = await execFileAsync(
    "openclaw",
    ["plugins", "inspect", "cognitive-runtime", "--runtime", "--json"],
    { env: environment },
  );
  const inspection = JSON.parse(inspectOutput);
  assert.equal(inspection.plugin.status, "loaded");
  assert.equal(inspection.plugin.source.endsWith("/dist/openclaw/index.js"), true);
  assert.deepEqual(inspection.plugin.cliCommands, ["cognitive"]);
  assert.equal(inspection.plugin.configJsonSchema.additionalProperties, false);

  const { stdout: selfCheckOutput } = await execFileAsync(
    "openclaw",
    ["cognitive", "self-check"],
    { env: environment },
  );
  assert.deepEqual(JSON.parse(selfCheckOutput.trim()), {
    status: "ok",
    pluginId: "cognitive-runtime",
  });

  const { stdout: skillOutput } = await execFileAsync(
    "openclaw",
    ["skills", "info", "framework-admission", "--json"],
    { env: environment },
  );
  const skill = JSON.parse(skillOutput);
  assert.equal(skill.name, "framework-admission");
  assert.equal(skill.eligible, true);
});
