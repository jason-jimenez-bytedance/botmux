/**
 * Terminal v3 run → Saved Workflow actions.
 *
 * The action payload carries no identity or destination. The callback reloads
 * the immutable run envelope and derives owner/app/chat from there. Nonces are
 * consistency/freshness checks, not authorization secrets.
 */

import { createHash } from 'node:crypto';
import type { V3RunEnvelope } from '../../workflows/v3/run-envelope.js';
import { DEFAULT_LOCALE, t, type Locale } from '../../i18n/index.js';

export const V3_RUN_SAVE_ACTION = 'v3_run_save';
export const V3_RUN_SAVE_CONFIRM_ACTION = 'v3_run_save_confirm';

export type V3RunSaveScope = 'chat' | 'global';

export interface V3RunSaveActionValue {
  action: typeof V3_RUN_SAVE_ACTION | typeof V3_RUN_SAVE_CONFIRM_ACTION;
  runId: string;
  scope: V3RunSaveScope;
  nonce: string;
  /** Present only for the explicit unsafe-literal confirmation stage. */
  warningDigest?: string;
}

function envelopeSpecSha256(envelope: V3RunEnvelope): string {
  return 'spec' in envelope.artifacts ? envelope.artifacts.spec?.sha256 ?? '' : '';
}

export function v3RunSaveNonce(
  envelope: V3RunEnvelope,
  scope: V3RunSaveScope,
  warningDigest?: string,
): string {
  const binding = envelope.chatBinding;
  const digest = createHash('sha256')
    .update([
      'v3-run-save-card:v1',
      envelope.runId,
      envelope.artifacts.dag.sha256,
      envelopeSpecSha256(envelope),
      binding?.ownerOpenId ?? '',
      binding?.larkAppId ?? '',
      binding?.chatId ?? '',
      scope,
      warningDigest ? 'confirm' : 'save',
      warningDigest ?? '',
    ].join('\0'))
    .digest('hex')
    .slice(0, 40);
  return `v3save:${digest}`;
}

export function buildV3RunSaveActionValue(
  envelope: V3RunEnvelope,
  scope: V3RunSaveScope,
  warningDigest?: string,
): V3RunSaveActionValue {
  return {
    action: warningDigest ? V3_RUN_SAVE_CONFIRM_ACTION : V3_RUN_SAVE_ACTION,
    runId: envelope.runId,
    scope,
    nonce: v3RunSaveNonce(envelope, scope, warningDigest),
    ...(warningDigest ? { warningDigest } : {}),
  };
}

export function buildV3RunSaveWarningCard(input: {
  envelope: V3RunEnvelope;
  scope: V3RunSaveScope;
  warnings: readonly string[];
  warningDigest: string;
  locale?: Locale;
}): string {
  const locale = input.locale ?? DEFAULT_LOCALE;
  const scopeText = t(input.scope === 'global' ? 'workflow.v3.scope.global' : 'workflow.v3.scope.chat', undefined, locale);
  const warningLines = input.warnings.slice(0, 8).map((warning) => `- ${escapeMd(warning)}`);
  if (input.warnings.length > warningLines.length) {
    warningLines.push(t('workflow.v3.save.warning_more', { count: input.warnings.length - warningLines.length }, locale));
  }
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: t('workflow.v3.save.warning_title', undefined, locale) },
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: t('workflow.v3.save.warning_body', {
            runId: escapeMd(short(input.envelope.runId, 28)),
            scope: scopeText,
            warnings: warningLines.join('\n'),
          }, locale),
        },
      },
      {
        tag: 'note',
        elements: [{
          tag: 'plain_text',
          content: t('workflow.v3.save.warning_note', undefined, locale),
        }],
      },
      {
        tag: 'action',
        actions: [{
          tag: 'button',
          text: { tag: 'plain_text', content: t('workflow.v3.save.confirm', undefined, locale) },
          type: 'danger',
          value: buildV3RunSaveActionValue(
            input.envelope,
            input.scope,
            input.warningDigest,
          ),
        }],
      },
    ],
  });
}

export function buildV3RunSavedCard(input: {
  runId: string;
  displayName: string;
  workflowId: string;
  humanVersion: number;
  revisionId: string;
  scope: V3RunSaveScope;
  /** When a replay requested another scope, first valid commit still wins. */
  requestedScope?: V3RunSaveScope;
  locale?: Locale;
}): string {
  const locale = input.locale ?? DEFAULT_LOCALE;
  const runCommand = `/workflow run ${input.workflowId}`;
  const scopeText = t(input.scope === 'global' ? 'workflow.v3.scope.global' : 'workflow.v3.scope.chat', undefined, locale);
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      template: 'green',
      title: { tag: 'plain_text', content: t('workflow.v3.save.saved_title', { name: plainTitle(input.displayName, 80) }, locale) },
    },
    elements: [
      {
        tag: 'div',
        fields: [
          { is_short: true, text: { tag: 'lark_md', content: `**Run**\n${escapeMd(short(input.runId, 28))}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**${t('workflow.v3.save.field.scope', undefined, locale)}**\n${scopeText}` } },
          { is_short: false, text: { tag: 'lark_md', content: `**Definition**\n\`${input.workflowId}\` · v${input.humanVersion} · \`${short(input.revisionId, 18)}\`` } },
        ],
      },
      { tag: 'hr' },
      {
        tag: 'div',
        text: { tag: 'lark_md', content: t('workflow.v3.save.run_again', { command: escapeMd(runCommand) }, locale) },
      },
      ...(input.requestedScope && input.requestedScope !== input.scope ? [{
        tag: 'note',
        elements: [{
          tag: 'plain_text',
          content: t('workflow.v3.save.already_saved', {
            scope: scopeText,
            requestedScope: t(input.requestedScope === 'global' ? 'workflow.v3.scope.global' : 'workflow.v3.scope.chat', undefined, locale),
          }, locale),
        }],
      }] : []),
    ],
  });
}

function short(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function plainTitle(value: string, max: number): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(normalized || 'Saved Workflow');
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max).join('')}…`;
}

function escapeMd(value: string): string {
  return value.replace(/[\\*_~`\[\]]/g, (char) => `\\${char}`);
}
