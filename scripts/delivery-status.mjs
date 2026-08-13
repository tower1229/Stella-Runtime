import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

const unavailable = (reasonCode) => ({ status: "unavailable", reasonCode });

function commandRunner(command, args, options = {}) {
  try {
    return {
      ok: true,
      stdout: execFileSync(command, args, {
        cwd: options.cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: options.timeoutMs ?? 15_000,
      }).trim(),
      stderr: "",
      exitCode: 0,
    };
  } catch (error) {
    return {
      ok: false,
      stdout: typeof error.stdout === "string" ? error.stdout.trim() : "",
      stderr: typeof error.stderr === "string" ? error.stderr.trim() : error.message,
      exitCode: typeof error.status === "number" ? error.status : 1,
    };
  }
}

function required(run, command, args, cwd) {
  const result = run(command, args, { cwd });
  if (!result.ok) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

function parseGitHubRepository(remoteUrl) {
  const match = remoteUrl.match(/github\.com(?::|\/)([^/]+)\/([^/]+?)(?:\.git)?$/);
  return match === null ? null : `${match[1]}/${match[2]}`;
}

function issueNumbers(subject) {
  return [...subject.matchAll(/#(\d+)/g)].map((match) => Number(match[1]));
}

function parseJson(result) {
  if (!result.ok) {
    return null;
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function summarizeCi(runs, head) {
  if (!Array.isArray(runs)) {
    return unavailable("CI_QUERY_FAILED");
  }
  const matching = runs.filter((run) => run.headSha === head);
  if (matching.length === 0) {
    return { status: "not_found", runs: [] };
  }
  if (matching.some((run) => run.status !== "completed")) {
    return { status: "pending", runs: matching };
  }
  if (matching.some((run) => run.conclusion !== "success")) {
    return { status: "failed", runs: matching };
  }
  return { status: "passed", runs: matching };
}

function summarizeIssues(issues, expectedNumbers) {
  if (expectedNumbers.length === 0) {
    return { status: "not_applicable", items: [] };
  }
  if (issues.some((issue) => issue === null)) {
    return unavailable("ISSUE_QUERY_FAILED");
  }
  const items = issues;
  return {
    status: items.every((issue) => issue.state === "CLOSED") ? "closed" : "open",
    items,
  };
}

function summarizeRelease({ npmMetadata, release, version, tagRevision, head }) {
  if (npmMetadata === null && release === null) {
    return unavailable("RELEASE_QUERY_FAILED");
  }
  const npmVersion = npmMetadata?.version ?? null;
  const npmIntegrity = npmMetadata?.dist?.integrity
    ?? npmMetadata?.["dist.integrity"]
    ?? null;
  const githubTag = release?.tagName ?? null;
  const npmPublished = npmVersion === version;
  const githubPublished = githubTag === `v${version}` && release?.isDraft !== true;
  return {
    status: npmPublished && githubPublished ? "published" : "incomplete",
    version,
    sourceRevision: tagRevision,
    sourceRevisionMatchesHead: tagRevision === head,
    npm: {
      status: npmPublished ? "published" : "not_found",
      version: npmVersion,
      integrity: npmIntegrity,
    },
    githubRelease: release === null
      ? { status: "not_found" }
      : {
          status: githubPublished ? "published" : "incomplete",
          tagName: release.tagName,
          url: release.url,
          isDraft: release.isDraft,
          isPrerelease: release.isPrerelease,
          publishedAt: release.publishedAt,
        },
  };
}

export async function collectDeliveryStatus({
  cwd,
  includeRemote = true,
  run = commandRunner,
  now = () => new Date(),
}) {
  const packageJson = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
  const head = required(run, "git", ["rev-parse", "HEAD"], cwd);
  const branch = required(run, "git", ["branch", "--show-current"], cwd) || null;
  const subject = required(run, "git", ["show", "-s", "--format=%s", "HEAD"], cwd);
  const changesOutput = required(run, "git", ["status", "--porcelain=v1"], cwd);
  const changes = changesOutput.length === 0 ? [] : changesOutput.split("\n");
  const remoteUrl = required(run, "git", ["remote", "get-url", "origin"], cwd);
  const repository = parseGitHubRepository(remoteUrl);
  const upstreamResult = run(
    "git",
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    { cwd },
  );
  let upstream = unavailable("UPSTREAM_NOT_CONFIGURED");
  if (upstreamResult.ok) {
    const counts = required(
      run,
      "git",
      ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
      cwd,
    ).split(/\s+/).map(Number);
    upstream = {
      status: "observed",
      ref: upstreamResult.stdout,
      ahead: counts[0],
      behind: counts[1],
      synchronized: counts[0] === 0 && counts[1] === 0,
      observation: "local_tracking_ref",
    };
  }

  let fetchedAt = null;
  const gitDirectory = required(run, "git", ["rev-parse", "--absolute-git-dir"], cwd);
  try {
    fetchedAt = (await stat(join(gitDirectory, "FETCH_HEAD"))).mtime.toISOString();
  } catch {
    fetchedAt = null;
  }

  let ci = { status: "skipped" };
  let issues = { status: "skipped" };
  let release = { status: "skipped" };
  const expectedIssues = issueNumbers(subject);

  if (includeRemote && repository !== null) {
    const runList = parseJson(run("gh", [
      "run",
      "list",
      "--repo",
      repository,
      "--commit",
      head,
      "--limit",
      "20",
      "--json",
      "databaseId,name,status,conclusion,url,headSha,createdAt,updatedAt",
    ], { cwd, timeoutMs: 20_000 }));
    ci = summarizeCi(runList, head);

    const issueItems = expectedIssues.map((number) => parseJson(run("gh", [
      "issue",
      "view",
      String(number),
      "--repo",
      repository,
      "--json",
      "number,state,url,title",
    ], { cwd, timeoutMs: 15_000 })));
    issues = summarizeIssues(issueItems, expectedIssues);

    const npmMetadata = parseJson(run("npm", [
      "view",
      `${packageJson.name}@${packageJson.version}`,
      "version",
      "dist.integrity",
      "--json",
    ], { cwd, timeoutMs: 20_000 }));
    const githubRelease = parseJson(run("gh", [
      "release",
      "view",
      `v${packageJson.version}`,
      "--repo",
      repository,
      "--json",
      "tagName,url,isDraft,isPrerelease,publishedAt",
    ], { cwd, timeoutMs: 15_000 }));
    const tagResult = run("git", ["rev-list", "-n", "1", `v${packageJson.version}`], { cwd });
    release = summarizeRelease({
      npmMetadata,
      release: githubRelease,
      version: packageJson.version,
      tagRevision: tagResult.ok ? tagResult.stdout : null,
      head,
    });
  }

  return {
    schemaVersion: "stella-runtime.delivery-status/v1",
    generatedAt: now().toISOString(),
    repository: {
      name: repository,
      remoteUrl,
      branch,
      head,
      subject,
      fetchedAt,
    },
    source: {
      status: changes.length === 0 && upstream.status === "observed" && upstream.synchronized
        ? "delivered"
        : "not_delivered",
      clean: changes.length === 0,
      changes,
      upstream,
    },
    verification: {
      local: {
        status: "not_recorded",
        command: "npm run verify:env -- <profile> --json",
      },
      ci,
    },
    issues,
    release,
  };
}
