/**
 * Host-neutral execution seam for Saved Workflow IM commands.
 *
 * This module deliberately returns a notification payload instead of sending
 * it.  Persistence/launch completion is therefore never reclassified as a
 * business failure merely because the Lark reply failed afterwards.
 */

import type { BotConfig } from '../../bot-registry.js';
import { getDefaultLocale, t, type Locale } from '../../i18n/index.js';
import type { RawParamInput } from '../../workflows/shared/params.js';
import type { RunChatBinding } from '../../workflows/v3/grill-state.js';
import {
  instantiatePublishedSavedWorkflow,
  listVisibleSavedWorkflows,
  loadVisibleSavedWorkflow,
  resolveOwnedTerminalRunDir,
  saveTerminalRunAsWorkflow,
  type SavedWorkflowActorContext,
} from '../../workflows/v3/library-service.js';
import {
  readV3RunChatBinding,
  requestV3RunCancel,
  safeRunDir,
} from '../../workflows/v3/daemon-run.js';
import type { V3SavedWorkflowCommand } from './v3-saved-workflow-command.js';
import { v3SavedWorkflowAdHocRunEscapeHint } from './v3-saved-workflow-command.js';

export type ExecutableV3SavedWorkflowCommand = Exclude<V3SavedWorkflowCommand, { kind: 'invalid' }>;

function savedWorkflowScopeLabel(scope: { kind: 'chat' | 'global' }, locale: Locale): string {
  return t(`workflow.v3.saved.scope.${scope.kind}`, undefined, locale);
}

export interface V3SavedWorkflowMessageTargetsInput {
  /** Existing daemon routing anchor; it may be an oc_ chat id in chat scope. */
  anchor: string;
  /** Real thread/fold-back root supplied by the event dispatcher, when any. */
  replyRootId?: string;
  /** Stable inbound message id. */
  messageId: string;
}

export interface V3SavedWorkflowMessageTargets {
  /** Where every user-visible reply for this invocation must land. */
  replyAnchor: string;
  /** Binding frozen into run.json. Always a message id, never the chat id. */
  runRootMessageId: string;
  /** Stable id used by quota deduplication. */
  quotaMessageId: string;
}

export function resolveV3SavedWorkflowMessageTargets(
  input: V3SavedWorkflowMessageTargetsInput,
): V3SavedWorkflowMessageTargets {
  const messageId = input.messageId.trim();
  if (!messageId) throw new Error('Saved Workflow invocation requires a stable messageId');
  const replyRootId = input.replyRootId?.trim();
  const runRootMessageId = replyRootId || messageId;
  if (runRootMessageId.startsWith('oc_')) {
    throw new Error('Saved Workflow run binding requires a message root, not a chat id');
  }
  return {
    replyAnchor: replyRootId || input.anchor,
    runRootMessageId,
    quotaMessageId: messageId,
  };
}

export type V3SavedWorkflowPolicyResult =
  | { ok: true }
  | { ok: false; reason: 'global_requires_operate' | 'quota_denied' };

/**
 * One authorization seam shared by all Saved Workflow verbs. Read commands
 * consume quota too, so a command can never accidentally become a free CLI
 * path merely by moving code between read/write branches. Cancellation is the
 * deliberate exception: it only reduces already-authorized work and must stay
 * available after the run-launching message exhausts a user's last quota.
 */
export async function authorizeV3SavedWorkflowInvocation(
  command: ExecutableV3SavedWorkflowCommand,
  deps: {
    canPublishGlobal(): boolean;
    consumeMessageQuotaOnce(): Promise<boolean>;
  },
): Promise<V3SavedWorkflowPolicyResult> {
  if (command.kind === 'save' && command.global && !deps.canPublishGlobal()) {
    return { ok: false, reason: 'global_requires_operate' };
  }
  if (command.kind === 'cancel') return { ok: true };
  if (!await deps.consumeMessageQuotaOnce()) return { ok: false, reason: 'quota_denied' };
  return { ok: true };
}

export interface V3SavedWorkflowExecutionInput {
  command: ExecutableV3SavedWorkflowCommand;
  dataDir: string;
  baseDir: string;
  context: SavedWorkflowActorContext;
  /** Resolved bot locale for every user-visible success and failure path. */
  locale?: Locale;
  /** Host-authorized operate permission for run-level mutations. Ownership is
   * checked independently against the immutable run binding. */
  operatorCanOperate?: boolean;
}

export interface V3SavedWorkflowExecutionDeps {
  listVisible: typeof listVisibleSavedWorkflows;
  loadVisible: typeof loadVisibleSavedWorkflow;
  resolveOwnedRun: typeof resolveOwnedTerminalRunDir;
  saveRun: typeof saveTerminalRunAsWorkflow;
  instantiate: typeof instantiatePublishedSavedWorkflow;
  loadBots(): BotConfig[];
  persistStartIntent(runId: string, runDir: string): void;
  driveDetached(runId: string): void;
  readRunBinding(runDir: string): RunChatBinding | undefined;
  requestCancel: typeof requestV3RunCancel;
  cancelAndDrive(runId: string, cancelRequestId: string): void;
}

export type V3SavedWorkflowExecutionEffect =
  | 'read_completed'
  | 'save_committed'
  | 'run_started'
  | 'run_materialized_not_started'
  | 'cancel_requested'
  | 'cancel_terminal'
  | 'failed';

export interface V3SavedWorkflowExecutionResult {
  effect: V3SavedWorkflowExecutionEffect;
  message: string;
}

/** Best-effort transport boundary kept outside the business execution try/catch. */
export async function deliverV3SavedWorkflowNotification(
  result: V3SavedWorkflowExecutionResult,
  send: (message: string) => Promise<void>,
  onError: (error: unknown, effect: V3SavedWorkflowExecutionEffect) => void,
): Promise<void> {
  try {
    await send(result.message);
  } catch (err) {
    onError(err, result.effect);
  }
}

function formatExecutionError(
  command: ExecutableV3SavedWorkflowCommand,
  err: unknown,
  locale: Locale,
): string {
  const errorText = err instanceof Error ? err.message : String(err);
  const matches = (err as { matches?: Array<{ displayName: string; workflowId: string }> }).matches;
  const candidates = matches?.length
    ? `\n${t('workflow.v3.saved.error.candidates', undefined, locale)}\n${matches.map((item) => `- ${item.displayName} — ${item.workflowId}`).join('\n')}`
    : '';
  const runHint = command.kind === 'run' ? `\n${v3SavedWorkflowAdHocRunEscapeHint(locale)}` : '';
  const unsafeSaveHint = command.kind === 'save' &&
    !command.acknowledgeUnsafeLiterals &&
    /Saved Workflow lint requires confirmation|acknowledgeUnsafeLiterals/.test(errorText)
    ? `\n${t('workflow.v3.saved.error.unsafe_hint', undefined, locale)}`
    : '';
  return `❌ ${t('workflow.v3.saved.error.command', { error: errorText }, locale)}${candidates}${runHint}${unsafeSaveHint}`;
}

export async function executeV3SavedWorkflowCommand(
  input: V3SavedWorkflowExecutionInput,
  deps: V3SavedWorkflowExecutionDeps,
): Promise<V3SavedWorkflowExecutionResult> {
  const { command, dataDir, baseDir, context } = input;
  const locale = input.locale ?? getDefaultLocale();
  try {
    if (command.kind === 'list') {
      const listed = await deps.listVisible({ dataDir, context });
      const lines = listed.entries.length === 0
        ? [t('workflow.v3.saved.list.empty', undefined, locale)]
        : listed.entries.map((entry) =>
            `- ${entry.displayName} — \`${entry.workflowId}\` · ${savedWorkflowScopeLabel(entry.scope, locale)} · ${entry.status}`,
          );
      return { effect: 'read_completed', message: lines.join('\n') };
    }

    if (command.kind === 'show') {
      const loaded = await deps.loadVisible({ dataDir, ref: command.ref, context });
      const metadata = loaded.metadata;
      const params = Object.keys(loaded.revision.payload.inputs);
      return {
        effect: 'read_completed',
        message: [
          t('workflow.v3.saved.show.title', { name: metadata.displayName }, locale),
          `workflowId: ${metadata.workflowId}`,
          `scope: ${savedWorkflowScopeLabel(metadata.scope, locale)}`,
          `status: ${metadata.status}`,
          `revision: v${loaded.revision.payload.humanVersion} (${loaded.revision.revisionId})`,
          `params: ${params.length > 0 ? params.join(', ') : t('workflow.v3.saved.none', undefined, locale)}`,
        ].join('\n'),
      };
    }

    if (command.kind === 'cancel') {
      const runDir = safeRunDir(baseDir, command.runId);
      const binding = deps.readRunBinding(runDir);
      if (!binding) {
        throw new Error(
          t('workflow.v3.saved.cancel.missing', { runId: command.runId }, locale),
        );
      }
      if (binding.larkAppId !== context.actor.larkAppId || binding.chatId !== context.chatId) {
        throw new Error(t('workflow.v3.saved.cancel.binding', undefined, locale));
      }
      const isOwner = binding.ownerOpenId === context.actor.openId;
      if (!isOwner && !input.operatorCanOperate) {
        throw new Error(t('workflow.v3.saved.cancel.permission', undefined, locale));
      }

      const outcome = deps.requestCancel(baseDir, command.runId, {
        by: context.actor.openId,
        reason: 'cancelled via /workflow cancel',
      });
      if (outcome.kind === 'stale-run') {
        throw new Error(t('workflow.v3.saved.cancel.stale', undefined, locale));
      }
      if (outcome.kind === 'already-terminal') {
        return {
          effect: 'cancel_terminal',
          message: t('workflow.v3.saved.cancel.terminal', { runId: command.runId, status: outcome.status }, locale),
        };
      }
      if (outcome.kind === 'already-cancelled') {
        return {
          effect: 'cancel_terminal',
          message: t('workflow.v3.saved.cancel.cancelled', { runId: command.runId }, locale),
        };
      }

      let wakeWarning = '';
      try {
        // Both first and repeated requests wake the runner: this repairs the
        // durable-intent -> process-crash window without creating a new intent.
        deps.cancelAndDrive(command.runId, outcome.cancelRequestId);
      } catch {
        // The journal intent is already durable. Never report a false failure
        // that would encourage repeated mutation; cold attach will converge it.
        wakeWarning = `\n${t('workflow.v3.saved.cancel.wake_warning', undefined, locale)}`;
      }
      return {
        effect: 'cancel_requested',
        message:
          `${t(outcome.kind === 'already-requested'
            ? 'workflow.v3.saved.cancel.already_requested'
            : 'workflow.v3.saved.cancel.requested', undefined, locale)}: ` +
          `\`${command.runId}\`\nstatus: cancelling${wakeWarning}`,
      };
    }

    if (command.kind === 'save') {
      if (command.distill) {
        throw new Error(t('workflow.v3.saved.save.distill_host_only', undefined, locale));
      }
      const runDir = await deps.resolveOwnedRun({ baseDir, source: command.source, context });
      const result = await deps.saveRun({
        dataDir,
        runDir,
        context,
        ...(command.displayName ? { displayName: command.displayName } : {}),
        scope: command.global ? 'global' : 'chat',
        acknowledgeUnsafeLiterals: command.acknowledgeUnsafeLiterals,
      });
      return {
        effect: 'save_committed',
        message: [
          t('workflow.v3.saved.save.completed', { name: result.metadata.displayName }, locale),
          `workflowId: ${result.metadata.workflowId}`,
          `revision: v${result.revision.payload.humanVersion} (${result.revision.revisionId})`,
          `scope: ${savedWorkflowScopeLabel(result.metadata.scope, locale)}`,
          `status: ${result.metadata.status}`,
        ].join('\n'),
      };
    }

    const rawParams = Object.create(null) as Record<string, RawParamInput>;
    for (const [name, value] of Object.entries(command.rawParams)) {
      rawParams[name] = { kind: 'string', value };
    }
    const materialized = await deps.instantiate({
      dataDir,
      ref: command.ref,
      context,
      rawParams,
      bots: deps.loadBots(),
      baseDir,
    });
    try {
      deps.persistStartIntent(materialized.runId, materialized.runDir);
      deps.driveDetached(materialized.runId);
    } catch (err) {
      return {
        effect: 'run_materialized_not_started',
        message:
          t('workflow.v3.saved.run.materialized_not_started', {
            runId: materialized.runId,
            error: err instanceof Error ? err.message : String(err),
          }, locale),
      };
    }
    return {
      effect: 'run_started',
      message:
        `${t('workflow.v3.saved.run.started', { runId: materialized.runId }, locale)}\n` +
        `definition: ${materialized.envelope.source.workflowId} v${materialized.envelope.source.humanVersion}`,
    };
  } catch (err) {
    return { effect: 'failed', message: formatExecutionError(command, err, locale) };
  }
}

export const defaultV3SavedWorkflowExecutionServices = {
  listVisible: listVisibleSavedWorkflows,
  loadVisible: loadVisibleSavedWorkflow,
  resolveOwnedRun: resolveOwnedTerminalRunDir,
  saveRun: saveTerminalRunAsWorkflow,
  instantiate: instantiatePublishedSavedWorkflow,
  readRunBinding: readV3RunChatBinding,
  requestCancel: requestV3RunCancel,
} satisfies Pick<
  V3SavedWorkflowExecutionDeps,
  | 'listVisible'
  | 'loadVisible'
  | 'resolveOwnedRun'
  | 'saveRun'
  | 'instantiate'
  | 'readRunBinding'
  | 'requestCancel'
>;
