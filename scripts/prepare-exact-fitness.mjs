#!/usr/bin/env node
import { appendFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { spawn } from "node:child_process";

const FITNESS_REVISION = "ac1b8eaf55cf0cba4f5035b82ff74ac5ddd8cf8e";
const destination = process.argv[2];

if (destination === undefined || !isAbsolute(destination)) {
  throw new Error("Usage: prepare-exact-fitness.mjs <absolute-destination>");
}

const run = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: "inherit" });
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (code === 0) resolve();
    else reject(new Error(`${command} failed (${signal ?? code})`));
  });
});

await run("git", [
  "clone",
  "--no-checkout",
  "https://github.com/tower1229/Stella-Fitness.git",
  destination,
]);
await run("git", [
  "-C",
  destination,
  "fetch",
  "--depth=1",
  "origin",
  FITNESS_REVISION,
]);
await run("git", ["-C", destination, "checkout", "--detach", "FETCH_HEAD"]);
await run("npm", ["ci", "--prefix", destination]);
await run("npm", ["run", "build", "--prefix", destination]);

const githubEnvironment = process.env.GITHUB_ENV;
if (githubEnvironment === undefined || githubEnvironment.length === 0) {
  throw new Error("GITHUB_ENV is required");
}
await appendFile(
  githubEnvironment,
  [
    `STELLA_FITNESS_PACKAGE_ROOT=${destination}`,
    `STELLA_FITNESS_EXPECTED_REVISION=${FITNESS_REVISION}`,
    "",
  ].join("\n"),
);
