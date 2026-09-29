/**
 * v3 humanGate 审批卡 — 复用 v0.2 审批卡的视觉（header 配色 / 字段 / freeze 态），
 * 但**自带 action namespace + value 形态**（codex review #4）：
 *   - action: `v3_gate_approve` / `v3_gate_reject`
 *   - value: `{ action, runId, waitId, nodeId, nonce, selected }`
 * 刻意不复用已下线的 v2 wait path —— v3 的 wait 权威是
 * `waits/<id>.json + journal.ndjson`，跟 v0.2 events schema 不同（见 humanGate
 * daemon-card 设计 §4.3）。本文件**纯函数**，不碰 daemon / IO，单测友好。
 */

import { config } from '../../config.js';
import { buildV3RunDetailUrl } from '../../core/dashboard-url.js';
import { DEFAULT_LOCALE, t, type Locale } from '../../i18n/index.js';
import { DEFAULT_HUMAN_GATE_OPTIONS } from '../../workflows/v3/dag.js';
import { splitV3HostGatePrompt } from '../../workflows/v3/host-bindings.js';

export const V3_GATE_APPROVE_ACTION = 'v3_gate_approve';
export const V3_GATE_REJECT_ACTION = 'v3_gate_reject';

export type V3GateResolutionKind = 'approved' | 'rejected';

/** card 按钮回传的 value 形态——v3-gate-card-handler 据此解析。 */
export interface V3GateActionValue {
  action: typeof V3_GATE_APPROVE_ACTION | typeof V3_GATE_REJECT_ACTION;
  runId: string;
  /** waitId = `${nodeId}-gate`；nodeId 单独带，免得 handler 去 strip 后缀（节点名可能含 -gate）。 */
  waitId: string;
  nodeId: string;
  nonce: string;
  selected?: string;
}

export interface V3GateCardInput {
  runId: string;
  waitId: string;
  nodeId: string;
  prompt: string;
  /** 卡 nonce（防 stale 卡重复触发）；省略则按 runId/waitId 推导。 */
  nonce?: string;
  webDetailUrl?: string;
  promptMaxChars?: number;
  locale?: Locale;
  options?: string[];
  approveOptions?: string[];
  approvers?: string[];
  /** Host-only trusted identity. The hash is rendered independently from the
   * authored prompt so a long prompt can never truncate away what is approved. */
  hostApproval?: { attemptId: string; approvalDigest: string; inputHash: string };
  /** 有值 → 渲染冻结的「已通过 / 已拒绝」卡（无按钮，防 stale UI 重复提交）。 */
  resolution?: { kind: V3GateResolutionKind; by?: string; selected?: string };
}

const DEFAULT_PROMPT_MAX_CHARS = 500;

/** 稳定 nonce：同一 run 同一 wait 的卡 nonce 固定，重发卡也一致（幂等校验用）。 */
export function v3GateCardNonce(runId: string, waitId: string): string {
  return `v3gate:${runId}:${waitId}`;
}

/** v3 run 在 dashboard 的详情页 URL（跟 v0.2 的 #/workflows 对称，走 #/v3）。
 *  远程访问开+已绑定时走平台子域，否则 BOTMUX_PUBLIC_URL / 本地——详见
 *  {@link buildV3RunDetailUrl}，让远程用户点卡片够得着 SPA 才能触发一键登录。 */
export function v3RunDetailUrl(runId: string): string {
  return buildV3RunDetailUrl(runId, { host: config.dashboard.externalHost, port: config.dashboard.port });
}

export function buildV3GateCard(input: V3GateCardInput): string {
  const locale = input.locale ?? DEFAULT_LOCALE;
  const nonce = input.nonce ?? v3GateCardNonce(input.runId, input.waitId);
  const webDetailUrl = input.webDetailUrl ?? v3RunDetailUrl(input.runId);
  const promptMax = input.promptMaxChars ?? DEFAULT_PROMPT_MAX_CHARS;
  const hostPrompt = input.hostApproval ? splitV3HostGatePrompt(input.prompt) : undefined;
  const prompt = truncate(hostPrompt?.authoredPrompt ?? input.prompt, promptMax);
  const resolution = input.resolution;
  const options = input.options ?? [...DEFAULT_HUMAN_GATE_OPTIONS];
  const approveOptions = input.approveOptions ?? (options.includes('approve') ? ['approve'] : [options[0]!]);

  const title = resolution
    ? t(
      resolution.kind === 'approved' ? 'workflow.v3.gate.title.approved' : 'workflow.v3.gate.title.rejected',
      { node: titleText(input.nodeId) },
      locale,
    )
    : t('workflow.v3.gate.title.pending', { node: titleText(input.nodeId) }, locale);
  const template = resolution ? (resolution.kind === 'approved' ? 'green' : 'red') : 'blue';

  const elements: Array<Record<string, unknown>> = [
    {
      tag: 'div',
      fields: [
        { is_short: true, text: { tag: 'lark_md', content: `**Run**\n${escapeMd(short(input.runId, 24))}` } },
        { is_short: true, text: { tag: 'lark_md', content: `**${t('workflow.v3.gate.field.node', undefined, locale)}**\n${escapeMd(input.nodeId)}` } },
      ],
    },
    { tag: 'hr' },
    {
      tag: 'div',
      text: { tag: 'lark_md', content: `**${t('workflow.v3.gate.approval', undefined, locale)}**` },
    },
    {
      tag: 'div',
      // Gate prompts can contain user/agent-authored data. Keep them out of
      // lark_md so Lark tags such as <at id=all></at> cannot turn displaying
      // an approval card into a pre-approval notification side effect.
      text: { tag: 'plain_text', content: prompt },
    },
  ];

  if (input.hostApproval) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'div',
      text: {
        tag: 'plain_text',
        content: t('workflow.v3.gate.input_hash', { hash: input.hostApproval.inputHash }, locale),
      },
    });
    if (hostPrompt?.preview) {
      elements.push({
        tag: 'div',
        // The preview is derived from upstream result data. Rendering it as
        // plain text is a security boundary: markdown escaping alone does not
        // neutralize Lark-native tags (<at>, links, etc.).
        text: {
          tag: 'plain_text',
          content: t('workflow.v3.gate.input_preview', { preview: hostPrompt.preview }, locale),
        },
      });
    }
  }

  if (resolution) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'div',
      text: {
        tag: 'plain_text',
        content:
          t(
            resolution.kind === 'approved'
              ? 'workflow.v3.gate.resolved.approved'
              : 'workflow.v3.gate.resolved.rejected',
            undefined,
            locale,
          ) +
          (resolution.selected ? ` · ${short(resolution.selected, 20)}` : '') +
          (resolution.by ? ` · by ${short(resolution.by, 20)}` : ''),
      },
    });
  } else {
    elements.push({
      tag: 'action',
      actions: options.map((opt) => optionButton(opt, approveOptions, input, nonce, locale)),
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
          url: webDetailUrl, pc_url: webDetailUrl, android_url: webDetailUrl, ios_url: webDetailUrl,
        },
      },
    ],
  });

  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: { template, title: { tag: 'plain_text', content: title } },
    elements,
  });
}

function actionValue(
  action: V3GateActionValue['action'],
  runId: string,
  waitId: string,
  nodeId: string,
  nonce: string,
  selected?: string,
): V3GateActionValue {
  return { action, runId, waitId, nodeId, nonce, selected };
}

function optionButton(
  selected: string,
  approveOptions: string[],
  input: V3GateCardInput,
  nonce: string,
  locale: Locale,
): Record<string, unknown> {
  const approved = approveOptions.includes(selected);
  const label =
    selected === 'approve' ? t('workflow.v3.gate.button.approve', undefined, locale)
    : selected === 'reject' ? t('workflow.v3.gate.button.reject', undefined, locale)
    : selected;
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: label },
    type: approved ? 'primary' : 'danger',
    value: actionValue(
      approved ? V3_GATE_APPROVE_ACTION : V3_GATE_REJECT_ACTION,
      input.runId,
      input.waitId,
      input.nodeId,
      nonce,
      selected,
    ),
  };
}

function titleText(nodeId: string): string {
  return `humanGate · ${nodeId}`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

function short(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/** 转义 lark_md 里会被解析的字符，防 prompt 注入破坏卡片结构。 */
function escapeMd(s: string): string {
  return s.replace(/[\\*_~`\[\]]/g, (c) => `\\${c}`);
}
