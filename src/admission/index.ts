import {
  lintAuthorityRecord,
  parseAuthorityMarkdown,
  type AuthorityRecord,
} from "../authority/index.js";

export type FrameworkAdmissionDecision = "accepted" | "rejected" | "rewritten";

export interface FrameworkAdmissionProposal {
  readonly sourceAuthor: {
    readonly sourceRefs: readonly string[];
    readonly claims: readonly string[];
  };
  readonly modelSynthesis: string;
  readonly userUnderstanding: {
    readonly decision: FrameworkAdmissionDecision;
    readonly statement: string;
    readonly confirmedAuthorityChecksum?: string;
  };
  readonly authorityMarkdown?: string;
}

export type FrameworkAdmissionResult =
  | {
      readonly status: "admitted";
      readonly decision: "accepted" | "rewritten";
      readonly confirmedUnderstanding: string;
      readonly record: AuthorityRecord;
    }
  | {
      readonly status: "rejected";
      readonly decision: "rejected";
    };

const requireNonEmpty = (value: string, reason: string): void => {
  if (value.trim().length === 0) {
    throw new Error(reason);
  }
};

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
};

export function calculateCognitiveAuthorityChecksum(markdown: string): string {
  const record = parseAuthorityMarkdown(markdown);
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalize({
    id: record.id,
    schemaVersion: record.schemaVersion,
    recordType: record.recordType,
    frontmatter: record.frontmatter,
    body: record.body,
  }))).digest("hex")}`;
}

const sameStrings = (
  left: readonly string[],
  right: readonly string[],
): boolean => {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.length === sortedRight.length &&
    sortedLeft.every((value, index) => value === sortedRight[index]);
};

export function admitFramework(
  proposal: FrameworkAdmissionProposal,
): FrameworkAdmissionResult {
  if (!["accepted", "rejected", "rewritten"].includes(
    proposal.userUnderstanding.decision,
  )) {
    throw new Error("ADMISSION_DECISION_INVALID");
  }
  if (
    proposal.sourceAuthor.claims.length === 0 ||
    proposal.sourceAuthor.claims.some((claim) => claim.trim().length === 0) ||
    proposal.sourceAuthor.sourceRefs.length === 0 ||
    proposal.sourceAuthor.sourceRefs.some((ref) => ref.trim().length === 0)
  ) {
    throw new Error("ADMISSION_SOURCE_AUTHOR_REQUIRED");
  }
  requireNonEmpty(proposal.modelSynthesis, "ADMISSION_MODEL_SYNTHESIS_REQUIRED");
  requireNonEmpty(
    proposal.userUnderstanding.statement,
    "ADMISSION_USER_UNDERSTANDING_REQUIRED",
  );
  if (proposal.userUnderstanding.decision === "rejected") {
    if (
      proposal.authorityMarkdown !== undefined ||
      proposal.userUnderstanding.confirmedAuthorityChecksum !== undefined
    ) {
      throw new Error("ADMISSION_REJECTED_AUTHORITY_FORBIDDEN");
    }
    return { status: "rejected", decision: "rejected" };
  }
  if (proposal.authorityMarkdown === undefined) {
    throw new Error("ADMISSION_AUTHORITY_MARKDOWN_REQUIRED");
  }
  if (
    proposal.userUnderstanding.confirmedAuthorityChecksum === undefined ||
    proposal.userUnderstanding.confirmedAuthorityChecksum !==
      calculateCognitiveAuthorityChecksum(proposal.authorityMarkdown)
  ) {
    throw new Error("ADMISSION_CONFIRMATION_MISMATCH");
  }
  const record = parseAuthorityMarkdown(proposal.authorityMarkdown);
  if (record.layer !== "cognitive") {
    throw new Error("ADMISSION_COGNITIVE_REQUIRED");
  }
  const lint = lintAuthorityRecord(record);
  if (!lint.valid) {
    throw new Error(
      `ADMISSION_COGNITIVE_INVALID:${lint.issues.map((issue) => issue.code).join(",")}`,
    );
  }
  const recordSourceRefs = record.frontmatter.source_refs;
  if (
    !Array.isArray(recordSourceRefs) ||
    recordSourceRefs.some((ref) => typeof ref !== "string") ||
    !sameStrings(recordSourceRefs as readonly string[], proposal.sourceAuthor.sourceRefs)
  ) {
    throw new Error("ADMISSION_SOURCE_REF_MISMATCH");
  }
  return {
    status: "admitted",
    decision: proposal.userUnderstanding.decision,
    confirmedUnderstanding: proposal.userUnderstanding.statement,
    record,
  };
}
import { createHash } from "node:crypto";
