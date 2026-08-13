import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { collectDeliveryStatus } from "../../scripts/delivery-status.mjs";
import { verificationProfiles } from "../../scripts/verification-profiles.mjs";
import { persistVerificationReceipt } from "../../scripts/verification-receipt.mjs";

const head = "cbd73a4b2cd67d9435f976370498b8bc98c15dd0";
const tagRevision = "513728dc729d3fa66555ecaac10da2bb5f5e4ef3";

function fakeRunner(overrides = {}) {
  const outputs = new Map([
    ["git rev-parse HEAD", head],
    ["git branch --show-current", "master"],
    ["git show -s --format=%s HEAD", "fix: release recovery (#10)"],
    ["git status --porcelain=v1", ""],
    ["git remote get-url origin", "git@github.com:tower1229/Stella-Runtime.git"],
    ["git rev-parse --abbrev-ref --symbolic-full-name @{upstream}", "origin/master"],
    ["git rev-list --left-right --count HEAD...@{upstream}", "0\t0"],
    ["git rev-parse --absolute-git-dir", "/private/tmp/non-existent-git-dir"],
    [`git rev-list -n 1 v0.1.0`, tagRevision],
    [
      `gh run list --repo tower1229/Stella-Runtime --commit ${head} --limit 20 --json databaseId,name,status,conclusion,url,headSha,createdAt,updatedAt`,
      JSON.stringify([{
        name: "Verification",
        headSha: head,
        status: "completed",
        conclusion: "success",
      }]),
    ],
    [
      "gh issue view 10 --repo tower1229/Stella-Runtime --json number,state,url,title",
      JSON.stringify({ number: 10, state: "CLOSED", url: "https://example/10", title: "Release" }),
    ],
    [
      "npm view @tower1229/stella-cognitive-runtime@0.1.0 version dist.integrity --json",
      JSON.stringify({ version: "0.1.0", dist: { integrity: "sha512-fixture" } }),
    ],
    [
      "gh release view v0.1.0 --repo tower1229/Stella-Runtime --json tagName,url,isDraft,isPrerelease,publishedAt",
      JSON.stringify({
        tagName: "v0.1.0",
        url: "https://example/release",
        isDraft: false,
        isPrerelease: false,
        publishedAt: "2026-08-13T00:00:00Z",
      }),
    ],
  ]);
  for (const [key, value] of Object.entries(overrides)) {
    outputs.set(key, value);
  }
  return (command, args) => {
    const key = `${command} ${args.join(" ")}`;
    if (!outputs.has(key)) {
      return { ok: false, stdout: "", stderr: `missing fixture: ${key}`, exitCode: 1 };
    }
    return { ok: true, stdout: outputs.get(key), stderr: "", exitCode: 0 };
  };
}

async function writeVerificationReceipt({
  cwd,
  profileName = "pure",
  revision = head,
  clean = true,
}) {
  const profile = verificationProfiles[profileName];
  await persistVerificationReceipt({
    cwd,
    profile,
    sourceState: { revision, clean },
    receipt: {
      schemaVersion: "verification-environment/v1",
      project: "stella-runtime",
      profile: profileName,
      status: "passed",
      exitCode: 0,
      startedAt: "2026-08-13T00:59:00.000Z",
      finishedAt: "2026-08-13T01:00:00.000Z",
      steps: profile.steps.map((step) => ({
        name: step.name,
        status: "passed",
        exitCode: 0,
        durationMs: 1,
      })),
    },
  });
}

test("delivery receipt separates source delivery, verification, and release revision", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "stella-delivery-status-"));
  try {
    await writeFile(join(cwd, "package.json"), JSON.stringify({
      name: "@tower1229/stella-cognitive-runtime",
      version: "0.1.0",
    }));
    await writeVerificationReceipt({ cwd, profileName: "release" });
    const receipt = await collectDeliveryStatus({
      cwd,
      run: fakeRunner(),
      now: () => new Date("2026-08-13T03:00:00.000Z"),
    });

    assert.equal(receipt.source.status, "delivered");
    assert.equal(receipt.verification.local.status, "passed");
    assert.equal(receipt.verification.ci.status, "passed");
    assert.equal(receipt.issues.status, "closed");
    assert.equal(receipt.release.status, "published");
    assert.equal(receipt.release.sourceRevision, tagRevision);
    assert.equal(receipt.release.sourceRevisionMatchesHead, false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("dirty or ahead source is not reported as delivered", async () => {
  const receipt = await collectDeliveryStatus({
    cwd: new URL("../../", import.meta.url).pathname,
    includeRemote: false,
    run: fakeRunner({
      "git status --porcelain=v1": " M package.json",
      "git rev-list --left-right --count HEAD...@{upstream}": "2\t0",
    }),
  });

  assert.equal(receipt.source.status, "not_delivered");
  assert.equal(receipt.source.clean, false);
  assert.equal(receipt.source.upstream.ahead, 2);
  assert.equal(receipt.verification.ci.status, "skipped");
});

test("unrelated workflows cannot satisfy current HEAD verification", async () => {
  const receipt = await collectDeliveryStatus({
    cwd: new URL("../../", import.meta.url).pathname,
    run: fakeRunner({
      [`gh run list --repo tower1229/Stella-Runtime --commit ${head} --limit 20 --json databaseId,name,status,conclusion,url,headSha,createdAt,updatedAt`]: JSON.stringify([{
        name: "Dependency review",
        headSha: head,
        status: "completed",
        conclusion: "success",
      }]),
    }),
  });
  assert.equal(receipt.verification.ci.status, "not_found");
});

test("local verification is stale when it belongs to another revision", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "stella-delivery-status-stale-"));
  try {
    await writeFile(join(cwd, "package.json"), JSON.stringify({
      name: "@tower1229/stella-cognitive-runtime",
      version: "0.1.0",
    }));
    await writeVerificationReceipt({ cwd, revision: "previous-head" });
    const receipt = await collectDeliveryStatus({
      cwd,
      includeRemote: false,
      run: fakeRunner(),
    });
    assert.equal(receipt.verification.local.status, "stale");
    assert.equal(receipt.verification.local.profiles.pure.currentSource, false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("local verification from a dirty worktree cannot verify HEAD", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "stella-delivery-status-dirty-"));
  try {
    await writeFile(join(cwd, "package.json"), JSON.stringify({
      name: "@tower1229/stella-cognitive-runtime",
      version: "0.1.0",
    }));
    await writeVerificationReceipt({ cwd, clean: false });
    const receipt = await collectDeliveryStatus({
      cwd,
      includeRemote: false,
      run: fakeRunner(),
    });
    assert.equal(receipt.verification.local.status, "stale");
    assert.equal(receipt.verification.local.profiles.pure.sourceClean, false);
    assert.equal(receipt.verification.local.profiles.pure.currentSource, false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
