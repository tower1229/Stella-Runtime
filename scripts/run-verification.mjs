#!/usr/bin/env node
import { fileURLToPath } from "node:url";

import { executeVerification, VERIFICATION_EXIT } from "./verification-environment.mjs";
import { verificationProfiles } from "./verification-profiles.mjs";
import { persistVerificationReceipt } from "./verification-receipt.mjs";

const project = "stella-runtime";
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const arguments_ = process.argv.slice(2);
const json = arguments_.includes("--json");
const profileName = arguments_.find((argument) => !argument.startsWith("--"));

if (arguments_.includes("--list")) {
  const profiles = Object.entries(verificationProfiles).map(([name, profile]) => ({
    name,
    requirements: profile.requirements,
  }));
  process.stdout.write(`${json ? JSON.stringify(profiles, null, 2) : profiles.map(({ name }) => name).join("\n")}\n`);
  process.exit(VERIFICATION_EXIT.passed);
}

if (profileName === undefined) {
  process.stderr.write("Usage: npm run verify:env -- <profile> [--json]\n");
  process.exit(VERIFICATION_EXIT.usage);
}

const verificationReceipt = await executeVerification({
  project,
  profileName,
  profiles: verificationProfiles,
  cwd: repositoryRoot,
});
if (verificationReceipt.status === "usage_error") {
  process.stdout.write(`${JSON.stringify(verificationReceipt, null, 2)}\n`);
  process.exit(verificationReceipt.exitCode);
}
const { receipt, relativePath } = await persistVerificationReceipt({
  receipt: verificationReceipt,
  cwd: repositoryRoot,
  profile: verificationProfiles[profileName],
});

if (json) {
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
} else {
  process.stdout.write(
    `${project} ${profileName}: ${receipt.status}`
    + `${receipt.reasonCode === undefined ? "" : ` (${receipt.reasonCode})`}`
    + ` [${relativePath}]\n`,
  );
}
process.exit(receipt.exitCode);
