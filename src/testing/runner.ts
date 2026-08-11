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
    await assertDirectory(instanceTestPack, "Instance Test Pack");
    instanceTests = await discoverTests(instanceTestPack);
  }

  const testFiles = [...repositoryTests, ...instanceTests];
  if (testFiles.length === 0) {
    throw new Error("no test files were discovered");
  }

  const result = spawnSync(process.execPath, ["--test", ...testFiles], {
    stdio: "inherit",
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  return result.status ?? 1;
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
