import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";

export const VERIFICATION_EXIT = Object.freeze({
  passed: 0,
  failed: 1,
  usage: 2,
  environmentBlocked: 3,
});

const ENVIRONMENT_BLOCKERS = Object.freeze([
  {
    reasonCode: "NPM_CACHE_PERMISSION_DENIED",
    requirement: "network-install",
    pattern: /(?:npm[^\n]*cache|cache[^\n]*)(?:EPERM|EACCES)|root-owned files/i,
  },
  {
    reasonCode: "LOOPBACK_PERMISSION_DENIED",
    requirement: "loopback",
    pattern: /listen (?:EPERM|EACCES)|(?:EPERM|EACCES)[^\n]*(?:127\.0\.0\.1|localhost)/i,
  },
  {
    reasonCode: "NETWORK_UNAVAILABLE",
    requirement: "network-install",
    pattern: /EAI_AGAIN|ENETUNREACH|ECONNRESET|Could not resolve host|network request to .* failed|fetch failed/i,
  },
  {
    reasonCode: "EXACT_HOST_UNAVAILABLE",
    requirement: "exact-host",
    pattern: /(?:openclaw[^\n]*(?:ENOENT|not found|is not recognized))|(?:ENOENT[^\n]*openclaw)/i,
  },
  {
    reasonCode: "EXACT_HOST_RUNTIME_INCOMPATIBLE",
    requirement: "exact-host",
    pattern: /openclaw: Node\.js .* is required \(current: v[^)]+\)/i,
  },
]);

export function resolveVerificationCache({ temporaryRoot, environment }) {
  const override = environment.STELLA_VERIFICATION_NPM_CACHE?.trim();
  if (override === undefined || override.length === 0) {
    return join(temporaryRoot, "npm-cache");
  }
  if (!isAbsolute(override)) {
    throw new Error("STELLA_VERIFICATION_NPM_CACHE must be an absolute path");
  }
  return override;
}

export function classifyEnvironmentBlock({ output, requirements }) {
  for (const blocker of ENVIRONMENT_BLOCKERS) {
    if (
      requirements.includes(blocker.requirement)
      && blocker.pattern.test(output)
    ) {
      return blocker.reasonCode;
    }
  }
  return null;
}

async function runCommand({ step, cwd, environment, writeLog }) {
  const startedAt = Date.now();
  return await new Promise((resolve, reject) => {
    const child = spawn(step.command, step.args, {
      cwd,
      env: environment,
      stdio: ["inherit", "pipe", "pipe"],
    });
    let output = "";
    const capture = (chunk) => {
      const text = chunk.toString();
      output += text;
      writeLog(text);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolve({
      durationMs: Date.now() - startedAt,
      exitCode: exitCode ?? 1,
      output,
      signal,
    }));
  });
}

export async function executeVerification({
  project,
  profileName,
  profiles,
  cwd,
  environment = process.env,
  now = () => new Date(),
  runStep = runCommand,
  writeLog = (text) => process.stderr.write(text),
}) {
  const profile = profiles[profileName];
  if (profile === undefined) {
    return {
      schemaVersion: "verification-environment/v1",
      project,
      profile: profileName,
      status: "usage_error",
      reasonCode: "UNKNOWN_PROFILE",
      availableProfiles: Object.keys(profiles),
      exitCode: VERIFICATION_EXIT.usage,
    };
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), `${project}-verify-`));
  const cache = resolveVerificationCache({ temporaryRoot, environment });
  const commandEnvironment = {
    ...environment,
    NPM_CONFIG_CACHE: cache,
    npm_config_cache: cache,
    STELLA_CLEAN_INSTALL_NPM_CACHE: cache,
  };
  const startedAt = now();
  const steps = [];

  try {
    for (const step of profile.steps) {
      writeLog(`[verify:${profileName}] ${step.name}\n`);
      const result = await runStep({
        step,
        cwd,
        environment: commandEnvironment,
        writeLog,
      });
      const requirements = step.requirements ?? [];
      if (result.exitCode !== 0) {
        const reasonCode = classifyEnvironmentBlock({
          output: result.output,
          requirements,
        });
        const status = reasonCode === null ? "failed" : "environment_blocked";
        steps.push({
          name: step.name,
          status,
          exitCode: result.exitCode,
          signal: result.signal,
          durationMs: result.durationMs,
          ...(reasonCode === null ? {} : { reasonCode }),
        });
        return {
          schemaVersion: "verification-environment/v1",
          project,
          profile: profileName,
          status,
          requirements: profile.requirements,
          cache: "isolated",
          startedAt: startedAt.toISOString(),
          finishedAt: now().toISOString(),
          steps,
          ...(reasonCode === null ? {} : { reasonCode }),
          exitCode: reasonCode === null
            ? VERIFICATION_EXIT.failed
            : VERIFICATION_EXIT.environmentBlocked,
        };
      }
      steps.push({
        name: step.name,
        status: "passed",
        exitCode: 0,
        signal: result.signal,
        durationMs: result.durationMs,
      });
    }

    return {
      schemaVersion: "verification-environment/v1",
      project,
      profile: profileName,
      status: "passed",
      requirements: profile.requirements,
      cache: "isolated",
      startedAt: startedAt.toISOString(),
      finishedAt: now().toISOString(),
      steps,
      exitCode: VERIFICATION_EXIT.passed,
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
