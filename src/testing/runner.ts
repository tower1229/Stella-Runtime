#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_TEST_LAYERS = [
  "unit",
  "contract",
  "integration",
  "golden",
  "pack-install",
] as const;

export interface TestRunnerOptions {
  readonly repositoryTestRoot?: string;
  readonly instanceTestPack?: string;
}

async function assertDirectory(directory: string, label: string): Promise<void> {
  const info = await stat(directory).catch(() => null);
  if (!info?.isDirectory()) {
    throw new Error(`${label} must be an existing directory: ${directory}`);
  }
}

async function discoverTests(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const discovered = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return discoverTests(entryPath);
    }
    return /\.test\.(?:[cm]?js)$/.test(entry.name) ? [entryPath] : [];
  }));
  return discovered.flat().sort();
}

export async function runTestPacks(options: TestRunnerOptions = {}): Promise<number> {
  const repositoryTestRoot = path.resolve(options.repositoryTestRoot ?? "tests");
  await assertDirectory(repositoryTestRoot, "repository test root");

  const repositoryTests = (
    await Promise.all(REPOSITORY_TEST_LAYERS.map(async (layer) => {
      const layerPath = path.join(repositoryTestRoot, layer);
      const info = await stat(layerPath).catch(() => null);
      return info?.isDirectory() ? discoverTests(layerPath) : [];
    }))
  ).flat();

  let instanceTests: readonly string[] = [];
  if (options.instanceTestPack !== undefined) {
    const instanceTestPack = path.resolve(options.instanceTestPack);
    try {
      await assertDirectory(instanceTestPack, "Instance Test Pack");
      instanceTests = await discoverTests(instanceTestPack);
    } catch {
      throw new Error("INSTANCE_TEST_PACK_INVALID");
    }
  }

  if (repositoryTests.length === 0 && instanceTests.length === 0) {
    throw new Error("no test files were discovered");
  }
  const run = (
    testFiles: readonly string[],
    execution?: { readonly cwd: string; readonly privatePack: boolean },
  ) => spawnSync(
    process.execPath,
    ["--test", ...testFiles],
    {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      ...(execution === undefined ? {} : { cwd: execution.cwd }),
      ...(execution?.privatePack !== true ? {} : {
        env: Object.fromEntries(Object.entries(process.env).filter(([key]) =>
          key !== "NODE_OPTIONS"
          && !/(?:COVERAGE|JUNIT|NYC|ARTIFACT|TEST_REPORT|NODE_TEST_CONTEXT)/iu.test(key))),
      }),
    },
  );
  const repositoryResult = repositoryTests.length === 0 ? null : run(repositoryTests);
  if (repositoryResult?.error !== undefined) {
    throw new Error("test runner process failed");
  }
  process.stdout.write(repositoryResult?.stdout ?? "");
  process.stderr.write(repositoryResult?.stderr ?? "");

  const instanceResult = instanceTests.length === 0 ? null : run(instanceTests, {
    cwd: path.resolve(options.instanceTestPack as string),
    privatePack: true,
  });
  if (instanceResult?.error !== undefined) {
    throw new Error("INSTANCE_TEST_PACK_PROCESS_FAILED");
  }
  if (instanceResult !== null) {
    process.stdout.write(`${instanceResult.status === 0
      ? "INSTANCE_TEST_PACK_PASSED"
      : "INSTANCE_TEST_PACK_FAILED"}\n`);
  }
  return repositoryResult?.status === 0 && (instanceResult?.status ?? 0) === 0
    ? 0
    : 1;
}

function parseArguments(arguments_: readonly string[]): TestRunnerOptions {
  let repositoryTestRoot: string | undefined;
  let instanceTestPack: string | undefined;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const value = arguments_[index + 1];
    if (argument === "--repository-test-root" && value !== undefined) {
      repositoryTestRoot = value;
      index += 1;
    } else if (argument === "--instance-test-pack" && value !== undefined) {
      instanceTestPack = value;
      index += 1;
    } else {
      throw new Error(`unknown or incomplete argument: ${argument}`);
    }
  }

  return {
    ...(repositoryTestRoot === undefined ? {} : { repositoryTestRoot }),
    ...(instanceTestPack === undefined ? {} : { instanceTestPack }),
  };
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined
  && path.resolve(invokedPath) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = await runTestPacks(parseArguments(process.argv.slice(2)));
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
