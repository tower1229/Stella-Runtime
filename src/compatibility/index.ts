import { readFile } from "node:fs/promises";

export interface CompatibleHostIdentity {
  readonly releaseChannel: string;
  readonly openclawVersion: string;
  readonly nodeVersion: string;
  readonly evidence: string;
}

export interface HostCompatibilityInput {
  readonly openclawVersion: string;
  readonly nodeVersion: string;
  readonly releaseChannel?: string;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireString = (value: unknown): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("COMPATIBILITY_MATRIX_INVALID");
  }
  return value;
};

const requireExactVersion = (value: unknown): string => {
  const version = requireString(value);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("COMPATIBILITY_MATRIX_INVALID");
  }
  return version;
};

const parseAuthorizedRows = (value: unknown): readonly CompatibleHostIdentity[] => {
  if (
    !isRecord(value) ||
    value.schemaVersion !== "cognitive-runtime.openclaw-compatibility/v2" ||
    !Array.isArray(value.hosts)
  ) {
    throw new Error("COMPATIBILITY_MATRIX_INVALID");
  }
  const rows = value.hosts.map((entry) => {
    if (!isRecord(entry) || !isRecord(entry.generationConsumptionAcceptance)) {
      throw new Error("COMPATIBILITY_MATRIX_INVALID");
    }
    if (entry.generationConsumptionAcceptance.status !== "passed") {
      throw new Error("COMPATIBILITY_MATRIX_INVALID");
    }
    return {
      releaseChannel: requireString(entry.releaseChannel),
      openclawVersion: requireExactVersion(entry.openclawVersion),
      nodeVersion: requireExactVersion(entry.nodeVersion),
      evidence: requireString(entry.evidence),
    } satisfies CompatibleHostIdentity;
  });
  const identities = rows.map((row) =>
    `${row.releaseChannel}\u0000${row.openclawVersion}\u0000${row.nodeVersion}`);
  if (new Set(identities).size !== rows.length) {
    throw new Error("COMPATIBILITY_MATRIX_INVALID");
  }
  return rows;
};

const readAuthorizedRows = async (): Promise<readonly CompatibleHostIdentity[]> => {
  const path = new URL("../../compatibility/openclaw.json", import.meta.url);
  return parseAuthorizedRows(JSON.parse(await readFile(path, "utf8")) as unknown);
};

let authorizedRows: Promise<readonly CompatibleHostIdentity[]> | undefined;

const loadAuthorizedRows = (): Promise<readonly CompatibleHostIdentity[]> => {
  authorizedRows ??= readAuthorizedRows();
  return authorizedRows;
};

export const resolveCompatibleHost = async (
  input: HostCompatibilityInput,
): Promise<CompatibleHostIdentity> => {
  const matches = (await loadAuthorizedRows()).filter((row) =>
    row.openclawVersion === input.openclawVersion &&
    row.nodeVersion === input.nodeVersion &&
    (input.releaseChannel === undefined || row.releaseChannel === input.releaseChannel));
  const match = matches[0];
  if (match === undefined || matches.length !== 1) throw new Error("INCOMPATIBLE_HOST");
  return match;
};
