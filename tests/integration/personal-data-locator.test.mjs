import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { resolvePersonalDataLocator } from "../../dist/index.js";

const hostConfig = (repository, instanceId = "instance-synthetic") => ({
  plugins: {
    entries: {
      "cognitive-runtime": {
        config: {
          stella: {
            schema_version: "stella.personal-data-locator/v1",
            instance_id: instanceId,
            personal_data_repository: repository,
          },
        },
      },
    },
  },
});

const createLayout = async (root) => {
  const repository = join(root, "personal-data");
  for (const path of [
    repository,
    join(repository, "stella"),
    join(repository, "stella", "authority"),
    join(repository, "stella", "fitness"),
    join(repository, "stella", "projections"),
    join(repository, "stella", "projections", "fitness"),
    join(repository, "stella", "projections", "stella"),
  ]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700);
  }
  return repository;
};

test("locator resolves only the fixed Personal Data layout from public api.config", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "stella-locator-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = await createLayout(root);

  const resolved = await resolvePersonalDataLocator({
    apiConfig: hostConfig(repository),
    runtimeInstanceId: "instance-synthetic",
  });

  assert.deepEqual(resolved, {
    locator: {
      schema_version: "stella.personal-data-locator/v1",
      instance_id: "instance-synthetic",
      personal_data_repository: repository,
    },
    repository,
    stellaRoot: join(repository, "stella"),
    authority: join(repository, "stella", "authority"),
    fitness: join(repository, "stella", "fitness"),
    projections: {
      fitness: join(repository, "stella", "projections", "fitness"),
      stella: join(repository, "stella", "projections", "stella"),
    },
  });
});

test("locator fails closed on instance mismatch, unsafe permissions, traversal, and symlinks", async (t) => {
  const vectors = JSON.parse(await readFile(
    new URL("../fixtures/projection-conformance/vectors.json", import.meta.url),
    "utf8",
  ));
  const symlinkVector = vectors.cases.find(({ id }) => id === "symlink_path_escape");
  const root = await realpath(await mkdtemp(join(tmpdir(), "stella-locator-negative-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = await createLayout(root);

  await assert.rejects(resolvePersonalDataLocator({
    apiConfig: hostConfig(repository, "another-instance"),
    runtimeInstanceId: "instance-synthetic",
  }), /PERSONAL_DATA_INSTANCE_MISMATCH/);

  await chmod(join(repository, "stella", "fitness"), 0o755);
  await assert.rejects(resolvePersonalDataLocator({
    apiConfig: hostConfig(repository),
    runtimeInstanceId: "instance-synthetic",
  }), /PERSONAL_DATA_PERMISSIONS_UNSAFE/);
  await chmod(join(repository, "stella", "fitness"), 0o700);

  await assert.rejects(resolvePersonalDataLocator({
    apiConfig: hostConfig(repository),
    runtimeInstanceId: "instance-synthetic",
    ownerUid: (process.getuid?.() ?? 0) + 1,
  }), /PERSONAL_DATA_OWNERSHIP_MISMATCH/);

  await assert.rejects(resolvePersonalDataLocator({
    apiConfig: hostConfig(`${repository}/../personal-data`),
    runtimeInstanceId: "instance-synthetic",
  }), /PERSONAL_DATA_PATH_NOT_CANONICAL/);

  const external = await createLayout(join(root, "outside"));
  assert.equal(external, join(root, symlinkVector.input.link_target));
  const linked = join(root, symlinkVector.input.link_name);
  await symlink(external, linked, "dir");
  await assert.rejects(resolvePersonalDataLocator({
    apiConfig: hostConfig(linked),
    runtimeInstanceId: "instance-synthetic",
  }), new RegExp(symlinkVector.expected_reason));
});
