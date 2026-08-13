import { readdirSync } from "node:fs";

const npmRun = (name, requirements = []) => ({
  name,
  command: "npm",
  args: ["run", name],
  requirements,
});

const nodeTest = (name, paths, requirements = []) => ({
  name,
  command: process.execPath,
  args: ["--test", "--test-concurrency=1", ...paths],
  requirements,
});

const testFiles = (...directories) => directories.flatMap((directory) =>
  readdirSync(directory)
    .filter((entry) => entry.endsWith(".test.mjs"))
    .sort()
    .map((entry) => `${directory}/${entry}`));

const pureSteps = [
  npmRun("lint"),
  npmRun("typecheck"),
  npmRun("build"),
  nodeTest(
    "unit-contract-integration",
    testFiles("tests/unit", "tests/contract", "tests/integration"),
  ),
];

const networkInstallSteps = [
  npmRun("build"),
  nodeTest("package-and-upgrade", [
    "tests/pack-install/package-contents.test.mjs",
    "tests/pack-install/public-content.test.mjs",
    "tests/pack-install/release-candidate.test.mjs",
  ], ["network-install"]),
];

const exactHostSteps = [
  npmRun("build"),
  nodeTest("openclaw-exact-host", [
    "tests/pack-install/openclaw-discovery.test.mjs",
  ], ["network-install", "loopback", "exact-host"]),
];

export const verificationProfiles = Object.freeze({
  pure: {
    requirements: [],
    steps: pureSteps,
  },
  "network-install": {
    requirements: ["network-install"],
    steps: networkInstallSteps,
  },
  "exact-host": {
    requirements: ["network-install", "loopback", "exact-host"],
    steps: exactHostSteps,
  },
  release: {
    requirements: ["network-install", "loopback", "exact-host"],
    steps: [...pureSteps, ...networkInstallSteps, ...exactHostSteps],
  },
});
