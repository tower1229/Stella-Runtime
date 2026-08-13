#!/usr/bin/env node
import { fileURLToPath } from "node:url";

import { collectDeliveryStatus } from "./delivery-status.mjs";

const cwd = fileURLToPath(new URL("../", import.meta.url));
const localOnly = process.argv.includes("--local");
const json = process.argv.includes("--json");
const receipt = await collectDeliveryStatus({ cwd, includeRemote: !localOnly });

if (json) {
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
} else {
  process.stdout.write([
    `source: ${receipt.source.status}`,
    `ci: ${receipt.verification.ci.status}`,
    `issues: ${receipt.issues.status}`,
    `release: ${receipt.release.status}`,
  ].join("\n") + "\n");
}
