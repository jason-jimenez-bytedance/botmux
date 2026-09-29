/**
 * v3 humanGate 审批卡点击处理 —— card-handler 的 v3 分支（对称于 v0.2 的
 * 走 v3 自己的 wait/journal 权威，不复用已下线的 v2 wait
 * path）。把一次点击翻译成：权限校验 → `resolveV3GateClick`（幂等 + terminal-safe）
 * → 冻结卡 / toast + 触发 `driveV3Run` 续跑。
 *
 * 纯逻辑 + 注入 seam（resolveClick / driveRun / canResolve），单测友好；真正的
 * Lark 发送 / driveV3Run 由 daemon 在 deps 里接。
 */

import { join } from 'node:path';
import {
  V3_GATE_APPROVE_ACTION,
  V3_GATE_REJECT_ACTION,
  buildV3GateCard,
  v3GateCardNonce,
  type V3GateActionValue,
} from './v3-gate-card.js';
import { readV3RunChatBinding, resolveV3GateClick } from '../../workflows/v3/daemon-run.js';
import {
  defaultBaseDir,
  type RunChatBinding,
} from '../../workflows/v3/grill-state.js';
import { readWait } from '../../workflows/v3/human-gate.js';
import { isValidRunId, isValidWaitId } from '../../workflows/v3/ops-projection.js';
import { getDefaultLocale, localeForBot, t } from '../../i18n/index.js';

export function isV3GateAction(action: unknown): boolean {
  return action === V3_GATE_APPROVE_ACTION || action === V3_GATE_REJECT_ACTION;
}

export interface V3GateCardHandlerDeps {
  baseDir?: string;
  /** Re-enter the run after a resolved gate.  Fire-and-forget; the daemon logs
   *  errors (this is the `driveV3Run` wiring with postGateCard/onTerminal). */
  driveRun: (runId: string) => void;
  /** Permission: may this operator resolve gates for this run?  Default: allow
   *  (MVP — daemon injects a canOperate-backed check). */
  canResolve?: (binding: RunChatBinding | undefined, operatorOpenId: string | undefined) => boolean;
  /** Injectable for tests. Default = real resolveV3GateClick. */
  resolveClick?: typeof resolveV3GateClick;
}

/**
 * Handle a v3 gate card click.  Returns the Lark card-action response: a frozen
 * card object (replaces the clicked card so its buttons can't re-submit), or a
 * `{ toast }` wrapper.  Triggers `driveRun` as a side effect on a real resolve.
 */
export async function handleV3GateAction(
  value: V3GateActionValue,
  operatorOpenId: string | undefined,
  deps: V3GateCardHandlerDeps,
): Promise<unknown> {
  const baseDir = deps.baseDir ?? defaultBaseDir();
  // Guard BOTH externally-supplied ids before any path join: waitId flows into
  // `runDir/waits/<waitId>.json` (resolveV3GateClick → human-gate), and the
  // reproducible non-secret nonce can't stop a `../..` waitId on its own.
  if (!isValidRunId(value.runId)) {
    return { toast: { type: 'warning', content: t('workflow.v3.toast.invalid_run', undefined, getDefaultLocale()) } };
  }
  if (typeof value.waitId !== 'string' || !isValidWaitId(value.waitId)) {
    return { toast: { type: 'warning', content: t('workflow.v3.toast.invalid_wait', undefined, getDefaultLocale()) } };
  }
  // Nonce check (codex medium): the card carries a stable nonce; a value whose
  // nonce doesn't match the run/wait pair is a tampered/foreign card → stale.
  if (value.nonce !== v3GateCardNonce(value.runId, value.waitId)) {
    return { toast: { type: 'warning', content: t('workflow.v3.toast.stale_card', undefined, getDefaultLocale()) } };
  }
  const runDir = join(baseDir, value.runId);
  const binding = readV3RunChatBinding(runDir);
  const locale = localeForBot(binding?.larkAppId);

  if (deps.canResolve && !deps.canResolve(binding, operatorOpenId)) {
    return { toast: { type: 'warning', content: t('workflow.v3.toast.unauthorized_gate', undefined, locale) } };
  }

  const selected = value.selected ?? (value.action === V3_GATE_APPROVE_ACTION ? 'approve' : 'reject');
  const resolveClick = deps.resolveClick ?? resolveV3GateClick;

  let outcome;
  try {
    outcome = resolveClick(baseDir, value.runId, {
      waitId: value.waitId,
      selected,
      by: operatorOpenId ?? 'unknown',
    });
  } catch (err) {
    // journal append failed after resolveWait (codex #5): warn + don't fake
    // success; the card stays clickable, cold-attach reconcile heals on restart.
    return {
      toast: {
        type: 'error',
        content: t('workflow.v3.toast.action_failed', {
          action: t('workflow.v3.gate.approval', undefined, locale),
          error: err instanceof Error ? err.message : String(err),
        }, locale),
      },
    };
  }

  if (outcome.kind === 'stale-run') {
    return {
      toast: {
        type: 'warning',
        content: t(
          outcome.reason === 'terminal' ? 'workflow.v3.toast.run_finished' : 'workflow.v3.toast.action_expired',
          undefined,
          locale,
        ),
      },
    };
  }
  if (outcome.kind === 'already-settled') {
    // Idempotent recovery (codex nit #14): if a prior click already APPROVED the
    // gate but its driveRun didn't land (transient), a re-click should re-drive
    // instead of dead-ending at an info toast — mirrors the blocked/loop grant
    // handlers' already-granted branch. driveRun is terminal-safe (short-circuits
    // a finished run), so this is harmless if the run already moved on. A rejected
    // gate is terminal-ish, so don't re-drive it.
    if (outcome.status === 'approved') deps.driveRun(value.runId);
    return {
      toast: {
        type: 'info',
        content: t('workflow.v3.toast.already_settled', {
          status: t(outcome.status === 'approved'
            ? 'workflow.v3.toast.status_approved'
            : 'workflow.v3.toast.status_rejected', undefined, locale),
        }, locale),
      },
    };
  }
  if (outcome.kind === 'unauthorized') {
    return {
      toast: {
        type: 'warning',
        content: t('workflow.v3.toast.not_approver', undefined, locale),
      },
    };
  }

  // resolved → drive the run forward (fresh replay) + freeze this card.
  deps.driveRun(value.runId);
  const prompt = readWait(runDir, value.waitId)?.prompt ?? '';
  const hostApproval = readWait(runDir, value.waitId)?.hostApproval;
  const frozen = buildV3GateCard({
    runId: value.runId,
    waitId: value.waitId,
    nodeId: value.nodeId,
    prompt,
    hostApproval,
    resolution: { kind: outcome.resolution, by: operatorOpenId, selected },
    locale,
  });
  return JSON.parse(frozen);
}
