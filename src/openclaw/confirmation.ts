import {
  CandidateAdmissionService,
  CONFIRMATION_ACTIONS,
  type CandidateAuthorityHeadPort,
  type ConfirmationAction,
  type ConfirmationPreparationInput,
} from "../admission/index.js";
import { FileCandidateAdmissionStore } from "../admission/persistence.js";
import type {
  ApprovalMessageReference,
  CandidateReviewArtifact,
} from "../contracts/index.js";

export const OPENCLAW_TELEGRAM_CONFIRMATION_VERSION = "2026.6.34";
export const TELEGRAM_CONFIRMATION_NAMESPACE = "crad";

interface TelegramConfirmationContext {
  readonly channel: "telegram";
  readonly accountId: string;
  readonly conversationId: string;
  readonly senderId?: string;
  readonly auth: {
    readonly isAuthorizedSender: boolean;
  };
  readonly callback: {
    readonly namespace: string;
    readonly payload: string;
    readonly messageId: number;
  };
  readonly respond: {
    clearButtons(): Promise<void>;
    reply(params: { readonly text: string }): Promise<void>;
  };
}

interface TelegramInteractiveRegistration {
  readonly channel: "telegram";
  readonly namespace: string;
  readonly handler: (
    context: TelegramConfirmationContext,
  ) => Promise<{ readonly handled: boolean }>;
}

export interface TelegramConfirmationPluginApi {
  registerInteractiveHandler(
    registration: TelegramInteractiveRegistration,
  ): void;
}

export interface TelegramConfirmationGatewayOptions {
  readonly api: TelegramConfirmationPluginApi;
  readonly service: CandidateAdmissionService;
  readonly hostVersion: string;
}

export interface TelegramConfirmationAction {
  readonly action: ConfirmationAction;
  readonly text: "接受此版本" | "拒绝此版本" | "请求改写";
  readonly callbackData: string;
}

class ConfigurableAuthorityHeadPort implements CandidateAuthorityHeadPort {
  #delegate: CandidateAuthorityHeadPort | null = null;

  configure(delegate: CandidateAuthorityHeadPort): void {
    if (this.#delegate !== null) {
      throw new Error("CANDIDATE_AUTHORITY_HEAD_ALREADY_CONFIGURED");
    }
    this.#delegate = delegate;
  }

  getCurrent(
    input: Parameters<CandidateAuthorityHeadPort["getCurrent"]>[0],
  ): ReturnType<CandidateAuthorityHeadPort["getCurrent"]> {
    if (this.#delegate === null) {
      throw new Error("CANDIDATE_AUTHORITY_HEAD_UNAVAILABLE");
    }
    return this.#delegate.getCurrent(input);
  }
}

const openClawAuthorityHead = new ConfigurableAuthorityHeadPort();

export function configureOpenClawCandidateAuthorityHead(
  port: CandidateAuthorityHeadPort,
): void {
  openClawAuthorityHead.configure(port);
}

export const openClawCandidateAdmissionService = new CandidateAdmissionService({
  authorityHead: openClawAuthorityHead,
});

export function configureOpenClawCandidateAdmissionPersistence(
  runtimeStorage: string,
): FileCandidateAdmissionStore {
  const store = new FileCandidateAdmissionStore({ directory: runtimeStorage });
  openClawCandidateAdmissionService.configurePersistence(store);
  return store;
}

const actionMetadata = {
  accept: { code: "a", text: "接受此版本" },
  reject: { code: "r", text: "拒绝此版本" },
  "request-rewrite": { code: "w", text: "请求改写" },
} as const satisfies Record<
  ConfirmationAction,
  { readonly code: string; readonly text: TelegramConfirmationAction["text"] }
>;

const actionDescriptors = CONFIRMATION_ACTIONS.map((action) => ({
  action,
  ...actionMetadata[action],
}));

const decodeAction = (code: string): ConfirmationAction | null => {
  return actionDescriptors.find((descriptor) => descriptor.code === code)
    ?.action ?? null;
};

const parsePayload = (
  payload: string,
): { readonly action: ConfirmationAction; readonly routingToken: string } => {
  const separator = payload.indexOf(":");
  const action = decodeAction(payload.slice(0, separator));
  const routingToken = payload.slice(separator + 1);
  if (separator < 1 || action === null || routingToken.length < 32) {
    throw new Error("CONFIRMATION_CALLBACK_INVALID");
  }
  return { action, routingToken };
};

export function buildTelegramConfirmationActions(
  routingToken: string,
): readonly TelegramConfirmationAction[] {
  if (routingToken.length < 32 || routingToken.includes(":")) {
    throw new Error("CONFIRMATION_ROUTING_TOKEN_INVALID");
  }
  return actionDescriptors.map(({ action, code, text }) => {
    const callbackData = `${TELEGRAM_CONFIRMATION_NAMESPACE}:${code}:${routingToken}`;
    if (Buffer.byteLength(callbackData) > 64) {
      throw new Error("CONFIRMATION_CALLBACK_DATA_TOO_LONG");
    }
    return { action, text, callbackData };
  });
}

export interface TelegramConfirmationPresentationPort {
  present(input: {
    readonly reviewArtifact: CandidateReviewArtifact;
    readonly text: string;
    readonly actions: readonly TelegramConfirmationAction[];
  }): Promise<ApprovalMessageReference>;
}

interface OpenClawTelegramOutboundAdapter {
  sendPayload?(input: {
    readonly cfg: unknown;
    readonly to: string;
    readonly text: string;
    readonly accountId: string;
    readonly payload: {
      readonly text: string;
      readonly presentation: {
        readonly blocks: readonly [
          { readonly type: "text"; readonly text: string },
          {
            readonly type: "buttons";
            readonly buttons: readonly {
              readonly label: string;
              readonly action: { readonly type: "callback"; readonly value: string };
            }[];
          },
        ];
      };
    };
  }): Promise<{
    readonly messageId: string;
    readonly chatId?: string;
    readonly conversationId?: string;
  }>;
}

export interface OpenClawTelegramPresentationRuntime {
  readonly config: { current(): unknown };
  readonly channel: {
    readonly outbound: {
      loadAdapter(channel: "telegram"): Promise<OpenClawTelegramOutboundAdapter | undefined>;
    };
  };
}

export function createOpenClawTelegramConfirmationPresentation(options: {
  readonly runtime: OpenClawTelegramPresentationRuntime;
  readonly instanceId: string;
  readonly accountId: string;
  readonly conversationId: string;
}): TelegramConfirmationPresentationPort {
  return {
    async present(input) {
      const adapter = await options.runtime.channel.outbound.loadAdapter("telegram");
      if (adapter?.sendPayload === undefined) {
        throw new Error("TELEGRAM_CONFIRMATION_OUTBOUND_UNAVAILABLE");
      }
      const result = await adapter.sendPayload({
        cfg: options.runtime.config.current(),
        to: options.conversationId,
        text: input.text,
        accountId: options.accountId,
        payload: {
          text: input.text,
          presentation: {
            blocks: [
              { type: "text", text: input.text },
              {
                type: "buttons",
                buttons: input.actions.map((action) => ({
                  label: action.text,
                  action: { type: "callback", value: action.callbackData },
                })),
              },
            ],
          },
        },
      });
      const conversationId = result.chatId ?? result.conversationId;
      if (result.messageId.length === 0 || conversationId === undefined) {
        throw new Error("TELEGRAM_CONFIRMATION_OUTBOUND_IDENTITY_MISSING");
      }
      return {
        schema_version: "cognitive-runtime.approval-message-reference/v2",
        provider: "telegram",
        instance_id: options.instanceId,
        account_id: options.accountId,
        conversation_id: conversationId,
        message_id: result.messageId,
      };
    },
  };
}

export type PresentedTelegramConfirmation =
  | {
      readonly status: "redirect_required";
      readonly confirmedChannel: "telegram";
    }
  | {
      readonly status: "presented";
      readonly requestId: string;
      readonly routingToken: string;
      readonly reviewArtifact: CandidateReviewArtifact;
      readonly messageReference: ApprovalMessageReference;
    };

const renderReviewArtifact = (artifact: CandidateReviewArtifact): string => [
  `Candidate ${artifact.candidate_id} revision ${artifact.candidate_revision}`,
  `Checksum: ${artifact.candidate_checksum}`,
  `Base Authority Version: ${artifact.base_authority_version ?? "null"}`,
  "Complete Candidate:",
  JSON.stringify(artifact.complete_candidate, null, 2),
  "Exact Base Diff:",
  artifact.exact_diff,
  "Source Map:",
  JSON.stringify(artifact.source_map, null, 2),
].join("\n");

export async function presentTelegramConfirmation(options: {
  readonly service: CandidateAdmissionService;
  readonly input: ConfirmationPreparationInput;
  readonly presentation: TelegramConfirmationPresentationPort;
}): Promise<PresentedTelegramConfirmation> {
  const prepared = options.service.prepareConfirmation(options.input);
  if (prepared.status === "redirect_required") {
    return prepared;
  }
  try {
    const messageReference = await options.presentation.present({
      reviewArtifact: prepared.reviewArtifact,
      text: renderReviewArtifact(prepared.reviewArtifact),
      actions: buildTelegramConfirmationActions(prepared.routingToken),
    });
    options.service.bindConfirmationMessage({
      routingToken: prepared.routingToken,
      messageReference,
    });
    return {
      status: "presented",
      requestId: prepared.requestId,
      routingToken: prepared.routingToken,
      reviewArtifact: prepared.reviewArtifact,
      messageReference,
    };
  } catch (error) {
    options.service.withdrawConfirmation(prepared.routingToken);
    throw error;
  }
}

export function registerTelegramConfirmationGateway(
  options: TelegramConfirmationGatewayOptions,
): void {
  if (options.hostVersion !== OPENCLAW_TELEGRAM_CONFIRMATION_VERSION) {
    throw new Error("TELEGRAM_CONFIRMATION_HOST_UNSUPPORTED");
  }
  options.api.registerInteractiveHandler({
    channel: "telegram",
    namespace: TELEGRAM_CONFIRMATION_NAMESPACE,
    handler: async (context) => {
      if (
        context.channel !== "telegram" ||
        context.callback.namespace !== TELEGRAM_CONFIRMATION_NAMESPACE
      ) {
        return { handled: false };
      }
      const callback = parsePayload(context.callback.payload);
      const instanceId = options.service.confirmationInstanceId(
        callback.routingToken,
      );
      const decision = options.service.decideConfirmation({
        routingToken: callback.routingToken,
        action: callback.action,
        authorized: context.auth.isAuthorizedSender,
        senderId: context.senderId ?? "",
        messageReference: {
          schema_version: "cognitive-runtime.approval-message-reference/v2",
          provider: "telegram",
          instance_id: instanceId,
          account_id: context.accountId,
          conversation_id: context.conversationId,
          message_id: String(context.callback.messageId),
        },
      });
      await context.respond.clearButtons();
      await context.respond.reply({
        text: decision.status === "rewrite_requested"
          ? "AUTHORITY_CANDIDATE_REWRITE_REQUESTED"
          : decision.receipt.decision === "rejected"
            ? "AUTHORITY_CANDIDATE_REJECTED"
            : "AUTHORITY_CANDIDATE_ACCEPTED",
      });
      return { handled: true };
    },
  });
}
