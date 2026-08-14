import { createRequire } from "node:module";

import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import type { FormatsPlugin } from "ajv-formats";

export type { CognitiveBinding } from "./generated/cognitive-binding.schema.js";
export type { CognitiveEntity } from "./generated/cognitive.schema.js";
export type { CognitiveProvenanceOverlay } from "./generated/cognitive-provenance-overlay.schema.js";
export type { CurrentStateEvent } from "./generated/current-state-event.schema.js";
export type { CurrentStateHead } from "./generated/current-state-head.schema.js";
export type { EvidenceSource } from "./generated/evidence.schema.js";
export type { PersonalModel } from "./generated/personal-model.schema.js";
export type { ReanswerOutbox } from "./generated/reanswer-outbox.schema.js";
export type { RouterResult } from "./generated/router-result.schema.js";
export type { RuntimeRecoveryVerificationOrRestoreReport } from "./generated/runtime-recovery-report.schema.js";
export type { RuntimeRecoverySnapshotManifest } from "./generated/runtime-recovery-snapshot-manifest.schema.js";
export type { SemanticClaim } from "./generated/semantic.schema.js";
export type { ReleasePin } from "./generated/release-pin.schema.js";
export type { ConsumerConformanceReceipt } from "./generated/conformance-receipt.schema.js";
export type { DiscoveryAuthorization } from "./generated/discovery-authorization.schema.js";
export type { AuthorityCandidate } from "./generated/authority-candidate.schema.js";
export type { CandidateReviewArtifact } from "./generated/candidate-review-artifact.schema.js";
export type { ApprovalMessageReference } from "./generated/approval-message-reference.schema.js";
export type { DecisionReceipt } from "./generated/decision-receipt.schema.js";
export type { ChangeSet } from "./generated/change-set.schema.js";
export type { StateView } from "./generated/state-view.schema.js";
export type { StateImportManifest } from "./generated/state-import-manifest.schema.js";
export type { StateCorrectionPreview } from "./generated/state-correction-preview.schema.js";
export type { StateCorrectionReceipt } from "./generated/state-correction-receipt.schema.js";
export type { GenerationManifest } from "./generated/generation-manifest.schema.js";
export type { ProjectionEntry } from "./generated/projection-entry.schema.js";
export type { ActiveGenerationPointer } from "./generated/active-generation-pointer.schema.js";
export type { ActivationReceipt } from "./generated/activation-receipt.schema.js";
export type { InstanceRuntimeConfig } from "./generated/instance-runtime-config.schema.js";
export type { InstanceCutoverPlan } from "./generated/instance-cutover-plan.schema.js";

const contractNames = [
  "evidence",
  "semantic",
  "personal-model",
  "cognitive",
  "cognitive-binding",
  "current-state-event",
  "current-state-head",
  "reanswer-outbox",
  "router-result",
  "cognitive-provenance-overlay",
  "runtime-recovery-snapshot-manifest",
  "runtime-recovery-report",
  "release-pin",
  "conformance-receipt",
  "discovery-authorization",
  "authority-candidate",
  "candidate-review-artifact",
  "approval-message-reference",
  "decision-receipt",
  "change-set",
  "state-view",
  "state-import-manifest",
  "state-correction-preview",
  "state-correction-receipt",
  "generation-manifest",
  "projection-entry",
  "active-generation-pointer",
  "activation-receipt",
  "instance-runtime-config",
  "instance-cutover-plan",
] as const;

export type ContractName = (typeof contractNames)[number];

export interface ContractValidationError {
  readonly instancePath: string;
  readonly schemaPath: string;
  readonly keyword: string;
  readonly message: string;
}

export type ContractValidationResult =
  | { readonly valid: true; readonly errors: readonly [] }
  | {
      readonly valid: false;
      readonly errors: readonly ContractValidationError[];
    };

const require = createRequire(import.meta.url);
const addFormats = require("ajv-formats") as FormatsPlugin;
const ajv = addFormats(
  new Ajv2020({
    allErrors: true,
    strict: true,
    strictRequired: false,
    strictTypes: false,
  }),
);

const schemas = new Map<ContractName, object>();
for (const name of contractNames) {
  const schema = require(`../../contracts/v2/${name}.schema.json`) as object;
  schemas.set(name, schema);
  ajv.addSchema(schema);
}

const routerSchema = schemas.get("router-result") as Record<string, unknown>;
ajv.addSchema(
  {
    ...routerSchema,
    $id: "cognitive-runtime.cognitive-provenance-overlay/router-result.schema.json",
  },
  "cognitive-runtime.cognitive-provenance-overlay/router-result.schema.json",
);

const validators = new Map<ContractName, ValidateFunction>();
for (const [name, schema] of schemas) {
  validators.set(name, ajv.compile(schema));
}

const normalizeErrors = (
  errors: readonly ErrorObject[] | null | undefined,
): readonly ContractValidationError[] =>
  (errors ?? []).slice(0, 20).map((error) => ({
    instancePath: error.instancePath,
    schemaPath: error.schemaPath,
    keyword: error.keyword,
    message: error.message ?? "contract validation failed",
  }));

export function validateContract(
  contract: ContractName,
  value: unknown,
): ContractValidationResult {
  const validator = validators.get(contract);
  if (validator === undefined) {
    throw new Error(`Unknown contract: ${contract}`);
  }

  if (validator(value)) {
    return { valid: true, errors: [] };
  }

  return { valid: false, errors: normalizeErrors(validator.errors) };
}
