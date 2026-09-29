/** Natural-language `/workflow` entry for the v3 grill. */
import { DEFAULT_LOCALE, t, type Locale } from '../../i18n/index.js';

export const workflowUsage = (locale: Locale = DEFAULT_LOCALE): string =>
  t('workflow.v3.command.usage', undefined, locale);
export const WORKFLOW_USAGE = workflowUsage();

export type WorkflowGrillTrigger =
  | { kind: 'goal'; goal: string }
  | { kind: 'usage' };

/**
 * Parse only the v3 grill entry. Reserved v3 verbs are handled by the saved
 * workflow/daemon command paths before this parser is called.
 */
export function parseWorkflowGrillTrigger(content: string): WorkflowGrillTrigger | null {
  const trimmed = content.trim();
  const match = /^\/workflow(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) return null;
  const tail = (match[1] ?? '').trim();
  if (!tail) return { kind: 'usage' };
  const firstToken = tail.split(/\s+/)[0]!;
  if (['run', 'save', 'list', 'show', 'cancel', 'resume'].includes(firstToken)) return null;
  const goal = firstToken === 'new' ? tail.slice(firstToken.length).trim() : tail;
  return goal ? { kind: 'goal', goal } : { kind: 'usage' };
}

export function buildWorkflowGrillPrompt(goal: string, locale: Locale = DEFAULT_LOCALE): string {
  return t('workflow.v3.command.grill_prompt', { goal }, locale);
}

/** `/template` is a stable tombstone after the v2 runtime retirement. */
export function isLegacyTemplateCommand(content: string): boolean {
  return /^\/template(?:\s|$)/.test(content.trim());
}

export const legacyTemplateRetiredMessage = (locale: Locale = DEFAULT_LOCALE): string =>
  t('workflow.v3.command.legacy_retired', undefined, locale);
export const LEGACY_TEMPLATE_RETIRED_MESSAGE = legacyTemplateRetiredMessage();

/** Shown when a user tries to start / author a workflow while the machine-wide
 *  workflow feature is turned off (global config `workflow.enabled=false` or
 *  `BOTMUX_WORKFLOW_ENABLED` set falsy). In-flight run management (cancel /
 *  retry / grant) is intentionally NOT gated, so a run started before the flip
 *  can still be wound down. */
export const workflowDisabledMessage = (locale: Locale = DEFAULT_LOCALE): string =>
  t('workflow.v3.command.disabled', undefined, locale);
export const WORKFLOW_DISABLED_MESSAGE = workflowDisabledMessage();
