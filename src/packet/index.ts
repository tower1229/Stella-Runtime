export interface RemediationPort<TRequest = unknown, TResult = unknown> {
  remediate(request: TRequest): Promise<TResult>;
}

export interface ExplicitContextEntry {
  readonly id: string;
  readonly content: string;
}

export interface VersionedExplicitContextEntry extends ExplicitContextEntry {
  readonly version: string;
}

export interface ExplicitContextBinding {
  readonly currentInput: string;
  readonly stateView: readonly ExplicitContextEntry[];
  readonly semanticClaims: readonly ExplicitContextEntry[];
  readonly evidenceRefs: readonly ExplicitContextEntry[];
  readonly governing: {
    readonly system: VersionedExplicitContextEntry;
    readonly modules: readonly VersionedExplicitContextEntry[];
  } | null;
  readonly frameworks: readonly VersionedExplicitContextEntry[];
  readonly retrievalInstructions: readonly string[];
}

export interface ExplicitContextPacketOptions {
  readonly binding: ExplicitContextBinding;
  readonly memoryRoute: "none" | "optional" | "required";
  readonly maxCharacters: number;
}

const section = (role: string, content: string): string =>
  `[${role}]\n${content}`;

export const buildExplicitContextPacket = (
  options: ExplicitContextPacketOptions,
): string => {
  if (!Number.isInteger(options.maxCharacters) || options.maxCharacters < 1) {
    throw new Error("CONTEXT_PACKET_LIMIT_INVALID");
  }
  const { binding } = options;
  const sections = [
    section("current_input", binding.currentInput),
    ...binding.stateView.map((entry) =>
      section(`current_state:${entry.id}`, entry.content)),
    ...binding.semanticClaims.map((entry) =>
      section(`semantic:${entry.id}`, entry.content)),
    ...binding.evidenceRefs.map((entry) =>
      section(`evidence:${entry.id}`, entry.content)),
  ];
  if (binding.governing !== null) {
    sections.push(section(
      `governing_kernel:${binding.governing.system.id}@${binding.governing.system.version}`,
      binding.governing.system.content,
    ));
    if (options.memoryRoute !== "none") {
      sections.push(...binding.governing.modules.map((entry) =>
        section(`governing_module:${entry.id}@${entry.version}`, entry.content)));
    }
  }
  if (options.memoryRoute !== "none") {
    sections.push(...binding.frameworks.map((entry) =>
      section(`ordinary_framework:${entry.id}@${entry.version}`, entry.content)));
    sections.push(...binding.retrievalInstructions.map((instruction) =>
      section("retrieval_instruction", instruction)));
  }
  const packet = sections.join("\n\n");
  if (packet.length > options.maxCharacters) {
    throw new Error("CONTEXT_PACKET_LIMIT_EXCEEDED");
  }
  return packet;
};

export interface RemediationRequest {
  readonly runId: string;
  readonly expectedRevision: number;
}

export interface RemediationCasResult {
  readonly applied: boolean;
  readonly revision: number;
}

export type RemediationOutcome =
  | { readonly status: "applied"; readonly revision: number }
  | { readonly status: "revision_conflict"; readonly revision: number }
  | { readonly status: "already_claimed"; readonly revision: null };

export interface CompareAndSetRemediationOptions {
  readonly scratch: {
    claimRemediation(runId: string): Promise<boolean>;
  };
  readonly compareAndSet: (
    request: RemediationRequest,
  ) => Promise<RemediationCasResult>;
}

export class CompareAndSetRemediation
  implements RemediationPort<RemediationRequest, RemediationOutcome>
{
  readonly #scratch: CompareAndSetRemediationOptions["scratch"];
  readonly #compareAndSet: CompareAndSetRemediationOptions["compareAndSet"];

  constructor(options: CompareAndSetRemediationOptions) {
    this.#scratch = options.scratch;
    this.#compareAndSet = options.compareAndSet;
  }

  async remediate(request: RemediationRequest): Promise<RemediationOutcome> {
    if (!(await this.#scratch.claimRemediation(request.runId))) {
      return { status: "already_claimed", revision: null };
    }
    const result = await this.#compareAndSet(request);
    return result.applied
      ? { status: "applied", revision: result.revision }
      : { status: "revision_conflict", revision: result.revision };
  }
}
