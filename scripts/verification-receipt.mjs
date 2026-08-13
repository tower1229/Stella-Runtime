import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

const defaultReceiptDirectory = ".stella/verification";
const exitCodeByStatus = Object.freeze({
  passed: 0,
  failed: 1,
  usage_error: 2,
  environment_blocked: 3,
});

function isIsoDate(value) {
  return typeof value === "string"
    && value.includes("T")
    && Number.isFinite(Date.parse(value));
}

function isVerificationStep(step) {
  return step !== null
    && typeof step === "object"
    && typeof step.name === "string"
    && step.name.length > 0
    && ["passed", "failed", "environment_blocked"].includes(step.status)
    && Number.isInteger(step.exitCode)
    && Number.isFinite(step.durationMs)
    && step.durationMs >= 0
    && (step.status === "passed" ? step.exitCode === 0 : step.exitCode !== 0)
    && (step.status !== "environment_blocked" || typeof step.reasonCode === "string");
}

function hasValidStepSequence(receipt, profile) {
  if (
    receipt.steps.length === 0
    || receipt.steps.length > profile.steps.length
    || !receipt.steps.every((step, index) => step.name === profile.steps[index].name)
  ) {
    return false;
  }
  if (receipt.status === "passed") {
    return receipt.steps.length === profile.steps.length
      && receipt.steps.every((step) => step.status === "passed");
  }
  if (receipt.status === "failed" || receipt.status === "environment_blocked") {
    const precedingSteps = receipt.steps.slice(0, -1);
    const terminalStep = receipt.steps.at(-1);
    return precedingSteps.every((step) => step.status === "passed")
      && terminalStep.status === receipt.status;
  }
  return false;
}

function profileDefinitionSha256(profile) {
  const definition = {
    requirements: profile.requirements,
    steps: profile.steps.map(({ name, command, args, requirements = [] }) => ({
      name,
      command: command === process.execPath ? "node" : command,
      args,
      requirements,
    })),
  };
  return createHash("sha256").update(JSON.stringify(definition)).digest("hex");
}

function isVerificationReceipt(receipt, fileName, expectedProject, profiles) {
  const profile = profiles[receipt?.profile];
  return receipt !== null
    && typeof receipt === "object"
    && receipt.schemaVersion === "verification-environment/v1"
    && receipt.project === expectedProject
    && typeof receipt.profile === "string"
    && fileName === `${receipt.profile}.json`
    && profile !== undefined
    && receipt.profileDefinitionSha256 === profileDefinitionSha256(profile)
    && Object.hasOwn(exitCodeByStatus, receipt.status)
    && receipt.exitCode === exitCodeByStatus[receipt.status]
    && typeof receipt.sourceRevision === "string"
    && receipt.sourceRevision.length > 0
    && typeof receipt.sourceClean === "boolean"
    && isIsoDate(receipt.startedAt)
    && isIsoDate(receipt.finishedAt)
    && Date.parse(receipt.startedAt) <= Date.parse(receipt.finishedAt)
    && Array.isArray(receipt.steps)
    && receipt.steps.every(isVerificationStep)
    && hasValidStepSequence(receipt, profile)
    && (receipt.status !== "environment_blocked"
      || typeof receipt.reasonCode === "string");
}

function resolveReceiptDirectory({ cwd, environment }) {
  const override = environment.STELLA_VERIFICATION_RECEIPT_DIR?.trim();
  if (override === undefined || override.length === 0) {
    return join(cwd, defaultReceiptDirectory);
  }
  if (!isAbsolute(override)) {
    throw new Error("STELLA_VERIFICATION_RECEIPT_DIR must be an absolute path");
  }
  return override;
}

function runGit(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function readSourceState(cwd) {
  return {
    revision: runGit(cwd, ["rev-parse", "HEAD"]),
    clean: runGit(cwd, ["status", "--porcelain=v1"]).length === 0,
  };
}

export async function persistVerificationReceipt({
  receipt,
  cwd,
  environment = process.env,
  sourceState = readSourceState(cwd),
  profile,
}) {
  const directory = resolveReceiptDirectory({ cwd, environment });
  const path = join(directory, `${receipt.profile}.json`);
  const temporaryPath = `${path}.${process.pid}.tmp`;
  const persistedReceipt = {
    ...receipt,
    sourceRevision: sourceState.revision,
    sourceClean: sourceState.clean,
    profileDefinitionSha256: profileDefinitionSha256(profile),
  };
  await mkdir(directory, { recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify(persistedReceipt, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporaryPath, path);
  return {
    receipt: persistedReceipt,
    path,
    relativePath: relative(cwd, path),
  };
}

export async function loadVerificationReceipts({
  cwd,
  project,
  profiles,
  environment = process.env,
}) {
  const directory = resolveReceiptDirectory({ cwd, environment });
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return { receipts: [], invalidFiles: [] };
    }
    throw error;
  }

  const receipts = [];
  const invalidFiles = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    try {
      const receipt = JSON.parse(await readFile(join(directory, entry.name), "utf8"));
      if (!isVerificationReceipt(receipt, entry.name, project, profiles)) {
        throw new Error("unsupported receipt shape");
      }
      receipts.push(receipt);
    } catch {
      invalidFiles.push(entry.name);
    }
  }
  receipts.sort((left, right) => left.profile.localeCompare(right.profile));
  invalidFiles.sort();
  return { receipts, invalidFiles };
}
