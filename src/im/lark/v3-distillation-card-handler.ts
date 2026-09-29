/** Authenticated Lark callback boundary for v3 parameter-distillation cards. */

import {
  acceptV3WorkflowDistillation,
  rejectV3WorkflowDistillation,
} from '../../workflows/v3/distillation-service.js';
import { loadProposal } from '../../workflows/v3/distillation-store.js';
import {
  V3_DISTILL_ACCEPT_ACTION,
  V3_DISTILL_REJECT_ACTION,
  buildV3DistillationCommittedCard,
  buildV3DistillationRejectedCard,
  isV3DistillationAction,
  parseV3DistillationActionValue,
} from './v3-distillation-card.js';
import { DEFAULT_LOCALE, localeForBot, t, type Locale } from '../../i18n/index.js';

export { isV3DistillationAction } from './v3-distillation-card.js';

export interface V3DistillationCardHandlerDeps {
  dataDir: string;
  baseDir: string;
  resolveMessageChatId(larkAppId: string, messageId: string): Promise<string | null>;
  onError?(proposalId: string, error: unknown): void;
}

function stale(locale: Locale): unknown {
  return { toast: { type: 'warning', content: t('workflow.v3.distill.toast.stale', undefined, locale) } };
}

function denied(locale: Locale): unknown {
  return { toast: { type: 'error', content: t('workflow.v3.distill.toast.identity', undefined, locale) } };
}

/** Safe fixed copy only. Never reflect model, source, path, or provider text. */
export function v3DistillationUserErrorMessage(
  error: unknown,
  phase: 'prepare' | 'generate' | 'approve',
  locale: Locale = DEFAULT_LOCALE,
): string {
  const code = error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : '';
  switch (code) {
    case 'unsafe_display_name':
      return t('workflow.v3.distill.error.unsafe_name', undefined, locale);
    case 'source_changed':
    case 'SOURCE_CHANGED':
    case 'SOURCE_NOT_ELIGIBLE':
    case 'SOURCE_NOT_FOUND':
      return t('workflow.v3.distill.error.source_changed', undefined, locale);
    case 'UNSUPPORTED_PLATFORM':
    case 'UNSUPPORTED_CLI':
      return t('workflow.v3.distill.error.unsupported', undefined, locale);
    case 'INVALID_MODEL_INPUT':
      return t('workflow.v3.distill.error.credentials', undefined, locale);
    case 'MANAGED_POLICY_UNSUPPORTED':
      return t('workflow.v3.distill.error.managed_policy', undefined, locale);
    case 'SCRATCH_SETUP_FAILED':
    case 'SCRATCH_CLEANUP_FAILED':
      return t('workflow.v3.distill.error.scratch', undefined, locale);
    case 'MODEL_FAILED':
    case 'MODEL_OUTPUT_INVALID':
      return t('workflow.v3.distill.error.model', undefined, locale);
    case 'IDENTITY_BUSY':
      return t('workflow.v3.distill.error.busy', undefined, locale);
    case 'STALE_PROPOSAL':
    case 'STATE_CONFLICT':
    case 'proposal_not_ready':
      return t('workflow.v3.distill.error.proposal_stale', undefined, locale);
    case 'approval_denied':
      return t('workflow.v3.distill.error.denied', undefined, locale);
    case 'commit_conflict':
    case 'CONTENT_CONFLICT':
      return t('workflow.v3.distill.error.conflict', undefined, locale);
    default:
      return phase === 'prepare'
        ? t('workflow.v3.distill.error.prepare', undefined, locale)
        : phase === 'generate'
          ? t('workflow.v3.distill.error.generate', undefined, locale)
          : t('workflow.v3.distill.error.approve', undefined, locale);
  }
}

export async function handleV3DistillationAction(
  rawValue: unknown,
  operatorOpenId: string | undefined,
  receivingLarkAppId: string | undefined,
  cardMessageId: string | undefined,
  deps: V3DistillationCardHandlerDeps,
): Promise<unknown> {
  const locale = localeForBot(receivingLarkAppId);
  const value = parseV3DistillationActionValue(rawValue);
  if (!value) return stale(locale);
  if (!operatorOpenId || !receivingLarkAppId || !cardMessageId) return denied(locale);

  try {
    const chatId = await deps.resolveMessageChatId(receivingLarkAppId, cardMessageId);
    if (!chatId) return denied(locale);
    const loaded = loadProposal(deps.dataDir, value.proposalId);
    if (!loaded.proposal) return stale(locale);
    const proposalHash = loaded.proposal.proposalHash;
    if (value.action === V3_DISTILL_REJECT_ACTION) {
      rejectV3WorkflowDistillation({
        dataDir: deps.dataDir,
        proposalId: value.proposalId,
        proposalHash,
        nonce: value.nonce,
        operatorOpenId,
        larkAppId: receivingLarkAppId,
        chatId,
      });
      return JSON.parse(buildV3DistillationRejectedCard(locale));
    }
    if (value.action !== V3_DISTILL_ACCEPT_ACTION) return stale(locale);
    const result = await acceptV3WorkflowDistillation({
      dataDir: deps.dataDir,
      baseDir: deps.baseDir,
      proposalId: value.proposalId,
      proposalHash,
      nonce: value.nonce,
      operatorOpenId,
      larkAppId: receivingLarkAppId,
      chatId,
    });
    return JSON.parse(buildV3DistillationCommittedCard(result, locale));
  } catch (error) {
    deps.onError?.(value.proposalId, error);
    return {
      toast: {
        type: 'warning',
        content: v3DistillationUserErrorMessage(error, 'approve', locale),
      },
    };
  }
}
