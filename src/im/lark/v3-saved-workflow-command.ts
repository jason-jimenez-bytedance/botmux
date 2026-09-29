/** Lightweight IM parser for the Saved Workflow portion of `/workflow`. */

import { getDefaultLocale, t, type Locale } from '../../i18n/index.js';

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const FORBIDDEN_PARAM_NAMES = new Set(['__proto__', 'prototype', 'constructor']);

export type V3SavedWorkflowCommand =
  | {
      kind: 'save';
      source: 'last' | string;
      displayName?: string;
      global: boolean;
      acknowledgeUnsafeLiterals: boolean;
      /** Ask the host to propose a parameterized definition before publishing. */
      distill: boolean;
    }
  | { kind: 'run'; ref: string; rawParams: Record<string, string> }
  | { kind: 'cancel'; runId: string }
  | { kind: 'list' }
  | { kind: 'show'; ref: string }
  | { kind: 'invalid'; error: string };

/**
 * Return null for ordinary ad-hoc goals and non-workflow messages. The daemon
 * invokes this before the grill parser, so reserved verbs can never become an
 * accidental natural-language DAG goal.
 */
export function parseV3SavedWorkflowCommand(
  content: string,
  locale: Locale = getDefaultLocale(),
): V3SavedWorkflowCommand | null {
  const match = /^\/workflow(?:\s+([\s\S]*))?$/.exec(content.trim());
  if (!match) return null;
  const tail = (match[1] ?? '').trim();
  if (!tail) return null;
  const tokens = tail.split(/\s+/);
  const sub = tokens[0]!.toLowerCase();
  if (!['save', 'run', 'cancel', 'list', 'show', 'resume'].includes(sub)) return null;

  if (sub === 'resume') {
    return {
      kind: 'invalid',
      error: t('workflow.v3.saved.parse.resume_retired', undefined, locale),
    };
  }

  if (sub === 'cancel') {
    if (tokens.length !== 2) {
      return { kind: 'invalid', error: t('workflow.v3.saved.parse.cancel_usage', undefined, locale) };
    }
    const runId = tokens[1]!;
    if (!SAFE_RUN_ID.test(runId)) {
      return { kind: 'invalid', error: t('workflow.v3.saved.parse.cancel_invalid', undefined, locale) };
    }
    return { kind: 'cancel', runId };
  }

  if (sub === 'list') {
    return tokens.length === 1
      ? { kind: 'list' }
      : { kind: 'invalid', error: t('workflow.v3.saved.parse.list_args', undefined, locale) };
  }
  if (sub === 'show') {
    const ref = tokens.slice(1).join(' ').trim();
    if (!ref) return { kind: 'invalid', error: t('workflow.v3.saved.parse.show_usage', undefined, locale) };
    return { kind: 'show', ref };
  }
  if (sub === 'save') {
    const firstSaveArg = tokens[1];
    // Flags do not force callers to spell the optional `last` source:
    // `/workflow save --ack-unsafe` retries the latest owned run.
    const source = firstSaveArg && !firstSaveArg.startsWith('--') ? firstSaveArg : 'last';
    if (source !== 'last' && !SAFE_RUN_ID.test(source)) {
      return { kind: 'invalid', error: t('workflow.v3.saved.parse.save_run_invalid', undefined, locale) };
    }
    const rest = tokens.slice(source === 'last' && firstSaveArg?.startsWith('--') ? 1 : 2);
    const supportedFlags = new Set(['--global', '--ack-unsafe', '--distill']);
    const malformedDistill = rest.find((token) =>
      token === '--distil' || token.startsWith('--distill='));
    if (malformedDistill) {
      return { kind: 'invalid', error: t('workflow.v3.saved.parse.save_unsupported', { arg: malformedDistill }, locale) };
    }
    const global = rest.includes('--global');
    const acknowledgeUnsafeLiterals = rest.includes('--ack-unsafe');
    const distill = rest.includes('--distill');
    // Exact-save historically allowed tokens beginning with `--` in a
    // multi-word display name. Preserve that surface. Once `--distill` opts
    // into the stricter model-backed path, however, every flag must be known
    // so a typo can never silently alter the requested operation.
    const unknownFlag = rest.find((token) => token.startsWith('--') && !supportedFlags.has(token));
    if (distill && unknownFlag) {
      return { kind: 'invalid', error: t('workflow.v3.saved.parse.save_unsupported', { arg: unknownFlag }, locale) };
    }
    const nameTokens = rest.filter((token) => !supportedFlags.has(token));
    const displayName = nameTokens.join(' ').trim();
    if (distill && !displayName) {
      return {
        kind: 'invalid',
        error: t('workflow.v3.saved.parse.distill_name', undefined, locale),
      };
    }
    if (distill && global) {
      return { kind: 'invalid', error: t('workflow.v3.saved.parse.distill_scope', undefined, locale) };
    }
    if (distill && acknowledgeUnsafeLiterals) {
      return { kind: 'invalid', error: t('workflow.v3.saved.parse.distill_ack', undefined, locale) };
    }
    return {
      kind: 'save',
      source,
      ...(displayName ? { displayName } : {}),
      global,
      acknowledgeUnsafeLiterals,
      distill,
    };
  }

  const runTokens = tokenizeWorkflowRunTail(tail.slice(tokens[0]!.length).trim());
  if (!runTokens) {
    return { kind: 'invalid', error: t('workflow.v3.saved.parse.run_quote', undefined, locale) };
  }
  const firstParamIndex = runTokens.findIndex((token) => token.includes('='));
  const refTokens = firstParamIndex === -1 ? runTokens : runTokens.slice(0, firstParamIndex);
  const ref = refTokens.join(' ').trim();
  if (!ref) {
    return {
      kind: 'invalid',
      error: `${t('workflow.v3.saved.parse.run_usage', undefined, locale)} ${v3SavedWorkflowAdHocRunEscapeHint(locale)}`,
    };
  }
  const rawParams = Object.create(null) as Record<string, string>;
  const paramTokens = firstParamIndex === -1 ? [] : runTokens.slice(firstParamIndex);
  for (const token of paramTokens) {
    const eq = token.indexOf('=');
    if (eq <= 0) {
      return {
        kind: 'invalid',
        error: `${t('workflow.v3.saved.parse.param_format', { token }, locale)} ${v3SavedWorkflowAdHocRunEscapeHint(locale)}`,
      };
    }
    const key = token.slice(0, eq);
    if (!SAFE_PARAM_NAME.test(key) || FORBIDDEN_PARAM_NAMES.has(key)) {
      return { kind: 'invalid', error: t('workflow.v3.saved.parse.param_name', { key }, locale) };
    }
    if (Object.prototype.hasOwnProperty.call(rawParams, key)) {
      return { kind: 'invalid', error: t('workflow.v3.saved.parse.param_duplicate', { key }, locale) };
    }
    rawParams[key] = token.slice(eq + 1);
  }
  return { kind: 'run', ref, rawParams };
}

/** Minimal IM quoting: preserve ordinary bytes, but let a value contain spaces
 * via `key="..."` or `key='...'`. This is intentionally not a shell parser and
 * never performs expansion or command substitution. */
function tokenizeWorkflowRunTail(value: string): string[] | undefined {
  const tokens: string[] = [];
  let token = '';
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else if (quote === '"' && char === '\\' && (value[i + 1] === '"' || value[i + 1] === '\\')) {
        token += value[++i]!;
      } else {
        token += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (/\s/.test(char)) {
      if (token) {
        tokens.push(token);
        token = '';
      }
    } else {
      token += char;
    }
  }
  if (quote) return undefined;
  if (token) tokens.push(token);
  return tokens;
}

export function v3SavedWorkflowUsage(locale: Locale = getDefaultLocale()): string {
  return t('workflow.v3.saved.usage', undefined, locale);
}

/** Actionable hint shared by the IM execution adapter when a multi-word
 * `run ...` lookup fails and the user may have intended an ad-hoc goal. */
export function v3SavedWorkflowAdHocRunEscapeHint(locale: Locale = getDefaultLocale()): string {
  return t('workflow.v3.saved.ad_hoc_hint', undefined, locale);
}
