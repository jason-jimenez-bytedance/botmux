/**
 * v3 run-level progress card.
 *
 * This is intentionally a pure renderer: the journal/envelope projection lives
 * in `workflows/v3/progress-projection.ts`, while daemon-side send/PATCH
 * lifecycle lives elsewhere.  Keeping the card on the projected allowlist is
 * also a data-boundary — goals, parameter values, error messages and local
 * paths never reach this renderer.
 */

import { config } from '../../config.js';
import { buildV3RunDetailUrl, buildV3TerminalUrl } from '../../core/dashboard-url.js';
import type { V3ProgressView } from '../../workflows/v3/progress-projection.js';
import type { V3RunSaveActionValue } from './v3-run-save-card.js';
import { DEFAULT_LOCALE, t, type Locale } from '../../i18n/index.js';

export interface V3ProgressCardOptions {
  /** Override the dashboard link (primarily for tests). */
  webDetailUrl?: string;
  /**
   * Pre-authorized action payloads prepared from the immutable run envelope.
   * The renderer never derives identity or nonces itself.
   */
  saveActions?: {
    chat: V3RunSaveActionValue;
  };
  locale?: Locale;
}

const MAX_INLINE_IDS = 5;

export function v3ProgressRunDetailUrl(runId: string): string {
  return buildV3RunDetailUrl(runId, { host: config.dashboard.externalHost, port: config.dashboard.port });
}

/** Render one complete Feishu card body from the safe v3 progress projection. */
export function buildV3ProgressCard(
  view: V3ProgressView,
  options: V3ProgressCardOptions = {},
): string {
  const locale = options.locale ?? DEFAULT_LOCALE;
  const chrome = statusChrome(view.status, locale);
  const completed = view.counts.done + view.counts.skipped + view.counts.cancelled;
  const webDetailUrl = options.webDetailUrl ?? v3ProgressRunDetailUrl(view.runId);
  const terminalUrl = view.terminal
    ? buildV3TerminalUrl(view.terminal.sessionId, {
        host: config.dashboard.externalHost,
        webPort: view.terminal.webPort,
        viewToken: view.terminal.viewToken,
      })
    : null;
  const source = sourceLabel(view.source, locale);
  const elements: Array<Record<string, unknown>> = [
    {
      tag: 'div',
      fields: [
        {
          is_short: true,
          text: { tag: 'lark_md', content: `**${t('workflow.v3.field.status', undefined, locale)}**\n${chrome.emoji} ${chrome.label}` },
        },
        {
          is_short: true,
          text: {
            tag: 'lark_md',
            content: `**${t('workflow.v3.field.progress', undefined, locale)}**\n${t('workflow.v3.progress.nodes_complete', { completed, total: view.counts.total }, locale)}`,
          },
        },
        {
          is_short: true,
          text: { tag: 'lark_md', content: `**${t('workflow.v3.field.source', undefined, locale)}**\n${escapeMd(source)}` },
        },
        {
          is_short: true,
          text: { tag: 'lark_md', content: `**Run ID**\n${escapeMd(view.runId)}` },
        },
      ],
    },
    {
      tag: 'note',
      elements: [{ tag: 'plain_text', content: t('workflow.v3.updated_at', { time: formatUpdatedAt(view.updatedAt) }, locale) }],
    },
  ];

  if (view.currentNodeIds.length > 0) {
    appendSection(elements, t('workflow.v3.section.current_nodes', undefined, locale), formatIdList(view.currentNodeIds, locale));
  }

  if (view.waitingNodeIds.length > 0) {
    appendSection(elements, t('workflow.v3.section.waiting', undefined, locale), formatIdList(view.waitingNodeIds, locale));
  }

  if (view.loops.length > 0) {
    appendSection(
      elements,
      t('workflow.v3.section.loops', undefined, locale),
      view.loops.map((loop) => {
        const effectiveMax = loop.maxIterations + loop.granted;
        const budget = effectiveMax > 0 ? ` / ${effectiveMax}` : '';
        const grant = loop.granted > 0
          ? t('workflow.v3.loop.granted', { count: loop.granted }, locale)
          : '';
        const decision = loop.lastDecision ? ` · ${loopDecisionLabel(loop.lastDecision, locale)}` : '';
        return `${escapeMd(loop.loopId)}: ${t('workflow.v3.loop.round', {
          iteration: loop.iteration,
          budget,
          grant,
          decision,
        }, locale)}`;
      }).join('\n'),
    );
  }

  if (view.revisit.count > 0) {
    const refreshed = view.revisit.refreshedNodeIds.length > 0
      ? t('workflow.v3.revisit.refreshed', { nodes: formatIdList(view.revisit.refreshedNodeIds, locale) }, locale)
      : '';
    appendSection(elements, t('workflow.v3.section.revisits', undefined, locale), t('workflow.v3.revisit.count', { count: view.revisit.count, refreshed }, locale));
  }

  if (view.issue) {
    const parts: string[] = [];
    if (view.issue.nodeId) parts.push(t('workflow.v3.issue.node', { node: escapeMd(view.issue.nodeId) }, locale));
    if (view.issue.errorClass) parts.push(escapeMd(view.issue.errorClass));
    if (view.issue.errorCode) parts.push(`\`${escapeMd(view.issue.errorCode)}\``);
    appendSection(elements, t('workflow.v3.section.error_code', undefined, locale), parts.length > 0 ? parts.join(' · ') : 'UNKNOWN');
  }

  if (view.feishuHostFailed) {
    appendSection(
      elements,
      t('workflow.v3.section.host_failed', undefined, locale),
      view.upstreamNonHostFinished
        ? t('workflow.v3.host_failed.after_upstream', undefined, locale)
        : t('workflow.v3.host_failed.general', undefined, locale),
    );
  }

  if (view.uncertainHostEffectCount && view.uncertainHostEffectCount > 0) {
    appendSection(
      elements,
      t('workflow.v3.section.uncertain_effects', undefined, locale),
      t('workflow.v3.uncertain_effects', { count: view.uncertainHostEffectCount }, locale),
    );
  }

  appendTerminalHint(elements, view, locale);

  if (
    view.status === 'starting' ||
    view.status === 'running' ||
    view.status === 'waiting' ||
    view.status === 'blocked'
  ) {
    appendSection(elements, t('workflow.v3.section.stop', undefined, locale), `\`/workflow cancel ${escapeMd(view.runId)}\``);
  }

  if (view.status === 'succeeded' && view.source.kind === 'ad_hoc' && options.saveActions) {
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: t('workflow.v3.button.save_chat', undefined, locale) },
          type: 'primary',
          value: options.saveActions.chat,
        },
      ],
    });
  }

  if (terminalUrl) {
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: t('workflow.v3.button.terminal', undefined, locale) },
          type: 'primary',
          multi_url: {
            url: terminalUrl,
            pc_url: terminalUrl,
            android_url: terminalUrl,
            ios_url: terminalUrl,
          },
        },
      ],
    });
  }

  elements.push({
    tag: 'action',
    actions: [
      {
        tag: 'button',
        text: { tag: 'plain_text', content: t('workflow.v3.button.web', undefined, locale) },
        type: 'default',
        multi_url: {
          url: webDetailUrl,
          pc_url: webDetailUrl,
          android_url: webDetailUrl,
          ios_url: webDetailUrl,
        },
      },
    ],
  });

  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      template: chrome.template,
      title: { tag: 'plain_text', content: headerTitle(view, chrome) },
    },
    elements,
  });
}

function headerTitle(
  view: V3ProgressView,
  chrome: ReturnType<typeof statusChrome>,
): string {
  const title = sanitizePlainTitle(view.title);
  return title
    ? `${chrome.emoji} ${title} · ${chrome.label}`
    : `${chrome.emoji} Workflow v3 · ${chrome.label}`;
}

function appendSection(
  elements: Array<Record<string, unknown>>,
  title: string,
  content: string,
): void {
  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'div',
    text: { tag: 'lark_md', content: `**${title}**\n${content}` },
  });
}

function appendTerminalHint(
  elements: Array<Record<string, unknown>>,
  view: V3ProgressView,
  locale: Locale,
): void {
  if (view.status !== 'succeeded') return;

  if (view.source.kind === 'ad_hoc') {
    appendSection(
      elements,
      t('workflow.v3.section.save', undefined, locale),
      `\`/workflow save ${escapeMd(view.runId)} [${t('workflow.v3.name_placeholder', undefined, locale)}]\``,
    );
  } else if (view.source.kind === 'saved_definition') {
    appendSection(
      elements,
      t('workflow.v3.section.run_again', undefined, locale),
      `${t('workflow.v3.saved_source', { workflowId: escapeMd(view.source.workflowId), version: view.source.humanVersion }, locale)}\n` +
        `\`/workflow run ${escapeMd(view.source.workflowId)}\``,
    );
  }
}

function sourceLabel(source: V3ProgressView['source'], locale: Locale): string {
  switch (source.kind) {
    case 'ad_hoc': return t('workflow.v3.source.ad_hoc', undefined, locale);
    case 'saved_definition': return t('workflow.v3.source.saved', { workflowId: source.workflowId, version: source.humanVersion }, locale);
    case 'manual_cli': return t('workflow.v3.source.manual_cli', undefined, locale);
    case 'legacy_v3': return t('workflow.v3.source.legacy', undefined, locale);
  }
}

function statusChrome(status: V3ProgressView['status'], locale: Locale): {
  emoji: string;
  label: string;
  template: string;
} {
  switch (status) {
    case 'starting': return { emoji: '⏳', label: t('workflow.v3.status.starting', undefined, locale), template: 'blue' };
    case 'running': return { emoji: '🔄', label: t('workflow.v3.status.running', undefined, locale), template: 'blue' };
    case 'cancelling': return { emoji: '⏹', label: t('workflow.v3.status.cancelling', undefined, locale), template: 'orange' };
    case 'cancelled': return { emoji: '⏹', label: t('workflow.v3.status.cancelled', undefined, locale), template: 'grey' };
    case 'waiting': return { emoji: '⏸', label: t('workflow.v3.status.waiting', undefined, locale), template: 'orange' };
    case 'blocked': return { emoji: '🚧', label: t('workflow.v3.status.blocked', undefined, locale), template: 'orange' };
    case 'succeeded': return { emoji: '✅', label: t('workflow.v3.status.succeeded', undefined, locale), template: 'green' };
    case 'failed': return { emoji: '❌', label: t('workflow.v3.status.failed', undefined, locale), template: 'red' };
  }
}

function loopDecisionLabel(decision: NonNullable<V3ProgressView['loops'][number]['lastDecision']>, locale: Locale): string {
  switch (decision) {
    case 'exit': return t('workflow.v3.loop.decision.exit', undefined, locale);
    case 'continue': return t('workflow.v3.loop.decision.continue', undefined, locale);
    case 'exhausted': return t('workflow.v3.loop.decision.exhausted', undefined, locale);
  }
}

function formatIdList(ids: readonly string[], locale: Locale): string {
  const visible = ids.slice(0, MAX_INLINE_IDS).map(escapeMd);
  const remaining = ids.length - visible.length;
  return `${visible.join(locale === 'en' ? ', ' : '、')}${remaining > 0 ? t('workflow.v3.id.more', { count: remaining }, locale) : ''}`;
}

function formatUpdatedAt(iso: string): string {
  // Projection emits an ISO timestamp.  Keep it timezone-explicit and avoid
  // host-locale output so PATCHes/tests are deterministic across machines.
  return escapePlainText(
    iso.replace('T', ' ').replace(/\.\d{3}Z$/, 'Z'),
  );
}

function sanitizePlainTitle(value: string | undefined): string | undefined {
  if (!value) return undefined;
  // Plain text cannot inject markdown, but line/control characters can still
  // distort the header. Collapse them, then truncate by Unicode code point so
  // an emoji/surrogate pair is never cut in half.
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  const chars = Array.from(normalized);
  return chars.length <= 60 ? normalized : `${chars.slice(0, 60).join('')}…`;
}

/** Escape user-controlled identifiers in Lark markdown fields. */
function escapeMd(value: string): string {
  return value.replace(/[\\*_~`\[\]<>]/g, (char) => `\\${char}`);
}

/** Plain-text card fields do not parse markdown but must not accept newlines. */
function escapePlainText(value: string): string {
  return value.replace(/[\r\n]+/g, ' ');
}
