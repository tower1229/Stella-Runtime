import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const sensitivePatterns = [
  ["macOS home path", new RegExp("/" + "Users" + "/")],
  ["Linux home path", new RegExp("/" + "home" + "/")],
  [
    "private key",
    new RegExp("BEGIN (?:RSA |EC |OPENSSH )?" + "PRIVATE KEY"),
  ],
  ["AWS access key", new RegExp("AK" + "IA[0-9A-Z]{16}")],
  [
    "inline credential",
    new RegExp(
      "(?:api[_-]?key|token|password)\\s*[:=]\\s*[\"'][A-Za-z0-9_./+-]{12,}[\"']",
      "i",
    ),
  ],
];

async function listFiles(directory, ignoredDirectories) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(path, ignoredDirectories)));
    } else {
      files.push(path);
    }
  }
  return files;
}

export async function findSensitiveMaterial(
  root,
  { ignoredDirectories = new Set() } = {},
) {
  const findings = [];
  for (const path of await listFiles(root, ignoredDirectories)) {
    const content = await readFile(path, "utf8");
    for (const [name, pattern] of sensitivePatterns) {
      if (pattern.test(content)) {
        findings.push(`${relative(root, path)}: ${name}`);
      }
    }
  }
  return findings;
}
