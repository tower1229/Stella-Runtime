import { parse as parseYaml } from "yaml";

import {
  type ContractName,
  type ContractValidationError,
  validateContract,
} from "../contracts/index.js";

export type AuthorityLayer = "evidence" | "semantic" | "cognitive";

export interface AuthorityRecord {
  readonly id: string;
  readonly layer: AuthorityLayer;
  readonly recordType: string;
  readonly schemaVersion: string;
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly body: string;
  readonly sections: ReadonlyMap<string, string>;
  readonly sourcePath?: string;
}

export interface AuthorityLintIssue {
  readonly code:
    | "EMPTY_REQUIRED_SECTION"
    | "MISSING_REQUIRED_SECTION"
    | "MISSING_PERSISTENT_KERNEL"
    | "ESSENTIALIZED_PERSONAL_MODEL";
  readonly section?: string;
}

export interface AuthorityLintResult {
  readonly valid: boolean;
  readonly issues: readonly AuthorityLintIssue[];
}

const cognitiveSections = [
  "User definition",
  "Core propositions",
  "Direction and active attention",
  "Observational strengths",
  "Compression tendencies and blind spots",
  "Applicable and inapplicable boundaries",
  "Cognitive signature",
  "Cognitive operators",
  "Relations and tensions",
  "Positive examples, counterexamples, and calibration",
  "Runtime digest",
  "Source explanation",
] as const;

const authoritySchemas = {
  "cognitive-runtime.evidence/v1": {
    contract: "evidence",
    idField: "source_id",
    recordTypeField: "source_type",
    layer: "evidence",
  },
  "cognitive-runtime.semantic/v1": {
    contract: "semantic",
    idField: "claim_id",
    recordTypeField: "record_type",
    layer: "semantic",
  },
  "cognitive-runtime.personal-model/v1": {
    contract: "personal-model",
    idField: "claim_id",
    recordTypeField: "record_type",
    layer: "semantic",
  },
  "cognitive-runtime.cognitive/v1": {
    contract: "cognitive",
    idField: "cognitive_id",
    recordTypeField: "entity_type",
    layer: "cognitive",
  },
} as const satisfies Record<
  string,
  {
    readonly contract: ContractName;
    readonly idField: string;
    readonly recordTypeField: string;
    readonly layer: AuthorityLayer;
  }
>;

type AuthoritySchemaVersion = keyof typeof authoritySchemas;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readString = (record: Record<string, unknown>, key: string): string => {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`AUTHORITY_FIELD_INVALID:${key}`);
  }
  return value;
};

const formatValidationErrors = (
  errors: readonly ContractValidationError[],
): string => errors.map((error) => `${error.instancePath}:${error.keyword}`).join(",");

const parseSections = (body: string): ReadonlyMap<string, string> => {
  const sections = new Map<string, string>();
  const matches = [...body.matchAll(/^## ([^\n]+)\s*$/gm)];
  for (const [index, match] of matches.entries()) {
    const title = match[1]?.trim();
    if (title === undefined || title.length === 0 || match.index === undefined) {
      continue;
    }
    const contentStart = match.index + match[0].length;
    const contentEnd = matches[index + 1]?.index ?? body.length;
    sections.set(title, body.slice(contentStart, contentEnd).trim());
  }
  return sections;
};

export function parseAuthorityMarkdown(
  markdown: string,
  options: { readonly sourcePath?: string } = {},
): AuthorityRecord {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(markdown);
  if (match === null) {
    throw new Error("AUTHORITY_FRONTMATTER_MISSING");
  }

  const parsed = parseYaml(match[1] ?? "") as unknown;
  if (!isRecord(parsed)) {
    throw new Error("AUTHORITY_FRONTMATTER_INVALID");
  }

  const schemaVersion = readString(parsed, "schema_version");
  if (!(schemaVersion in authoritySchemas)) {
    throw new Error(`AUTHORITY_SCHEMA_UNSUPPORTED:${schemaVersion}`);
  }
  const descriptor = authoritySchemas[schemaVersion as AuthoritySchemaVersion];
  const validation = validateContract(descriptor.contract, parsed);
  if (!validation.valid) {
    throw new Error(
      `AUTHORITY_CONTRACT_INVALID:${formatValidationErrors(validation.errors)}`,
    );
  }

  const body = (match[2] ?? "").trim();
  return {
    id: readString(parsed, descriptor.idField),
    layer: descriptor.layer,
    recordType: readString(parsed, descriptor.recordTypeField),
    schemaVersion,
    frontmatter: parsed,
    body,
    sections: parseSections(body),
    ...(options.sourcePath === undefined
      ? {}
      : { sourcePath: options.sourcePath }),
  };
}

export function resolveStableId(
  records: readonly AuthorityRecord[],
  id: string,
  expectedLayer?: AuthorityLayer,
): AuthorityRecord {
  const matches = records.filter((record) => record.id === id);
  if (matches.length === 0) {
    throw new Error(`STABLE_REF_NOT_FOUND:${id}`);
  }
  if (matches.length > 1) {
    throw new Error(`DUPLICATE_STABLE_ID:${id}`);
  }

  const record = matches[0];
  if (record === undefined) {
    throw new Error(`STABLE_REF_NOT_FOUND:${id}`);
  }
  if (expectedLayer !== undefined && record.layer !== expectedLayer) {
    throw new Error(
      `STABLE_REF_LAYER_MISMATCH:${id}:${expectedLayer}:${record.layer}`,
    );
  }
  return record;
}

export function lintAuthorityRecord(
  record: AuthorityRecord,
): AuthorityLintResult {
  const issues: AuthorityLintIssue[] = [];
  if (record.layer === "cognitive") {
    for (const section of cognitiveSections) {
      if (!record.sections.has(section)) {
        issues.push({ code: "MISSING_REQUIRED_SECTION", section });
      } else if (record.sections.get(section)?.trim().length === 0) {
        issues.push({ code: "EMPTY_REQUIRED_SECTION", section });
      }
    }
    if (
      record.recordType === "governing_system" &&
      !record.sections.get("Persistent Kernel")?.trim()
    ) {
      issues.push({ code: "MISSING_PERSISTENT_KERNEL", section: "Persistent Kernel" });
    }
  }

  if (
    record.schemaVersion === "cognitive-runtime.personal-model/v1" &&
    /\b(?:the\s+)?user\s+is\s+inherently\b|用户(?:天生|本质上)/iu.test(record.body)
  ) {
    issues.push({ code: "ESSENTIALIZED_PERSONAL_MODEL" });
  }

  return { valid: issues.length === 0, issues };
}
