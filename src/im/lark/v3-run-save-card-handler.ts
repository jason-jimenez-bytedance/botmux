/** Terminal progress-card action: save one succeeded ad-hoc v3 run. */

import { join } from 'node:path';

import {
  saveTerminalRunAsWorkflowIdempotent,
  type SavedWorkflowActorContext,
} from '../../workflows/v3/library-service.js';
import { SavedWorkflowUnsafeLiteralError } from '../../workflows/v3/library-materialize.js';
import { loadAuthorizedV3Run } from '../../workflows/v3/run-envelope.js';
import { defaultBaseDir } from '../../workflows/v3/grill-state.js';
import { isValidRunId } from '../../workflows/v3/ops-projection.js';
import { readJournal } from '../../workflows/v3/journal.js';
import { materialize } from '../../workflows/v3/state.js';
import { freezeV3ProgressCard } from './v3-progress-card-manager.js';
import {
  V3_RUN_SAVE_ACTION,
  V3_RUN_SAVE_CONFIRM_ACTION,
  buildV3RunSavedCard,
  buildV3RunSaveWarningCard,
  v3RunSaveNonce,
  type V3RunSaveActionValue,
} from './v3-run-save-card.js';
import { localeForBot, t, type Locale } from '../../i18n/index.js';

export function isV3RunSaveAction(action: unknown): boolean {
  return action === V3_RUN_SAVE_ACTION || action === V3_RUN_SAVE_CONFIRM_ACTION;
}

export interface V3RunSaveCardHandlerDeps {
  baseDir?: string;
  dataDir: string;
  saveRun?: typeof saveTerminalRunAsWorkflowIdempotent;
  onError?: (runId: string, error: unknown) => void;
}

export async function handleV3RunSaveAction(
  value: V3RunSaveActionValue,
  operatorOpenId: string | undefined,
  receivingLarkAppId: string | undefined,
  deps: V3RunSaveCardHandlerDeps,
): Promise<unknown> {
  const locale = localeForBot(receivingLarkAppId);
  if (!isV3RunSaveAction(value.action)) return toast('workflow.v3.save.toast.invalid_action', locale);
  if (!isValidRunId(value.runId)) return toast('workflow.v3.save.toast.invalid_run', locale);
  if (value.scope !== 'chat' && value.scope !== 'global') return toast('workflow.v3.save.toast.invalid_scope', locale);
  if (!operatorOpenId || !receivingLarkAppId) return toast('workflow.v3.save.toast.identity', locale);

  const baseDir = deps.baseDir ?? defaultBaseDir();
  const runDir = join(baseDir, value.runId);
  let loaded;
  try {
    loaded = loadAuthorizedV3Run(runDir, {
      expectedRunId: value.runId,
      allowedSources: ['ad_hoc', 'legacy_v3'],
    });
  } catch (err) {
    deps.onError?.(value.runId, err);
    return toast('workflow.v3.save.toast.integrity', locale);
  }

  const binding = loaded.envelope.chatBinding;
  if (
    !binding?.ownerOpenId ||
    binding.ownerOpenId !== operatorOpenId ||
    binding.larkAppId !== receivingLarkAppId
  ) {
    return toast('workflow.v3.save.toast.owner_only', locale);
  }
  if (loaded.envelope.source.kind === 'legacy_v3' && loaded.envelope.source.original !== 'grill') {
    return toast('workflow.v3.save.toast.legacy_source', locale);
  }

  let status: string;
  try {
    status = materialize(readJournal(join(runDir, 'journal.ndjson'))).runStatus;
  } catch (err) {
    deps.onError?.(value.runId, err);
    return toast('workflow.v3.save.toast.journal', locale);
  }
  if (status !== 'succeeded') return toast('workflow.v3.save.toast.status', locale, { status });

  const warningDigest = value.action === V3_RUN_SAVE_CONFIRM_ACTION
    ? value.warningDigest
    : undefined;
  if (
    value.action === V3_RUN_SAVE_CONFIRM_ACTION &&
    (typeof warningDigest !== 'string' || !/^[0-9a-f]{64}$/.test(warningDigest))
  ) return toast('workflow.v3.save.toast.digest', locale);
  if (
    value.nonce !== v3RunSaveNonce(loaded.envelope, value.scope, warningDigest) ||
    (value.action === V3_RUN_SAVE_CONFIRM_ACTION && !warningDigest)
  ) {
    return toast('workflow.v3.save.toast.nonce', locale);
  }
  if (value.scope === 'global') {
    return toast('workflow.v3.save.toast.global', locale, { runId: value.runId });
  }

  const context: SavedWorkflowActorContext = {
    actor: { openId: operatorOpenId, larkAppId: receivingLarkAppId },
    chatId: binding.chatId,
    ...(binding.rootMessageId ? { rootMessageId: binding.rootMessageId } : {}),
    ...(binding.sessionId ? { sessionId: binding.sessionId } : {}),
  };
  const saveRun = deps.saveRun ?? saveTerminalRunAsWorkflowIdempotent;

  // Confirmation clicks must recompute the warnings from immutable artifacts;
  // warningDigest from action.value is never trusted on its own.
  if (value.action === V3_RUN_SAVE_CONFIRM_ACTION) {
    try {
      const alreadySaved = await saveRun({
        dataDir: deps.dataDir,
        runDir,
        context,
        scope: value.scope,
        acknowledgeUnsafeLiterals: false,
      });
      // A code upgrade may have removed the warning rule since this card was
      // rendered. ack=false is the real save seam, so a successful probe has
      // already committed (or replayed) the idempotent definition — report it
      // honestly instead of claiming the action went stale.
      await freezeV3ProgressCard(runDir).catch((freezeErr) => deps.onError?.(value.runId, freezeErr));
      return JSON.parse(buildV3RunSavedCard({
        runId: value.runId,
        displayName: alreadySaved.metadata.displayName,
        workflowId: alreadySaved.metadata.workflowId,
        humanVersion: alreadySaved.revision.payload.humanVersion,
        revisionId: alreadySaved.revision.revisionId,
        scope: alreadySaved.metadata.scope.kind,
        requestedScope: value.scope,
        locale,
      }));
    } catch (err) {
      if (!(err instanceof SavedWorkflowUnsafeLiteralError)) {
        deps.onError?.(value.runId, err);
        return failed(value.runId, locale);
      }
      if (err.warningDigest !== warningDigest) {
        return toast('workflow.v3.save.toast.changed', locale);
      }
    }
  }

  try {
    const result = await saveRun({
      dataDir: deps.dataDir,
      runDir,
      context,
      scope: value.scope,
      acknowledgeUnsafeLiterals: value.action === V3_RUN_SAVE_CONFIRM_ACTION,
    });
    await freezeV3ProgressCard(runDir).catch((err) => deps.onError?.(value.runId, err));
    return JSON.parse(buildV3RunSavedCard({
      runId: value.runId,
      displayName: result.metadata.displayName,
      workflowId: result.metadata.workflowId,
      humanVersion: result.revision.payload.humanVersion,
      revisionId: result.revision.revisionId,
      scope: result.metadata.scope.kind,
      requestedScope: value.scope,
      locale,
    }));
  } catch (err) {
    if (err instanceof SavedWorkflowUnsafeLiteralError) {
      await freezeV3ProgressCard(runDir).catch((freezeErr) => deps.onError?.(value.runId, freezeErr));
      return JSON.parse(buildV3RunSaveWarningCard({
        envelope: loaded.envelope,
        scope: value.scope,
        warnings: err.warnings,
        warningDigest: err.warningDigest,
        locale,
      }));
    }
    deps.onError?.(value.runId, err);
    return failed(value.runId, locale);
  }
}

function toast(key: string, locale: Locale, params?: Record<string, string | number>): unknown {
  return { toast: { type: 'warning', content: t(key, params, locale) } };
}

function failed(runId: string, locale: Locale): unknown {
  return {
    toast: {
      type: 'error',
      content: t('workflow.v3.save.toast.failed', { runId }, locale),
    },
  };
}
