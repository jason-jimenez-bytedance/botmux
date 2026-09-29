#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { buildV3ProgressCard } from '../dist/im/lark/v3-progress-card.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = join(root, 'docs-site', 'static', 'img');
for (const [path, family] of [
  ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 'Pilot Sans'],
  ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 'Pilot Sans'],
  ['/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf', 'Pilot Emoji'],
]) {
  if (existsSync(path)) GlobalFonts.registerFromPath(path, family);
}

const counts = (overrides = {}) => ({
  total: 4, done: 0, running: 0, waiting: 0, blocked: 0,
  failed: 0, skipped: 0, cancelled: 0, pending: 0, ...overrides,
});

const states = [
  {
    name: 'success', caption: 'Successful workflow',
    view: {
      runId: 'pilot-release-2026-09-29', status: 'succeeded', title: 'Workbench release candidate',
      source: { kind: 'saved_definition', workflowId: 'release-candidate', humanVersion: 3 },
      counts: counts({ done: 4 }), currentNodeIds: [], waitingNodeIds: [], loops: [],
      revisit: { count: 0, refreshedNodeIds: [] }, updatedAt: '2026-09-29T01:00:00.000Z',
    },
  },
  {
    name: 'empty', caption: 'Waiting with no runnable nodes',
    view: {
      runId: 'pilot-awaiting-input-2026-09-29', status: 'waiting', title: 'Waiting for project selection',
      source: { kind: 'ad_hoc' }, counts: counts(), currentNodeIds: [], waitingNodeIds: [], loops: [],
      revisit: { count: 0, refreshedNodeIds: [] }, updatedAt: '2026-09-29T01:01:00.000Z',
    },
  },
  {
    name: 'failure', caption: 'Authentication failure',
    view: {
      runId: 'pilot-auth-recovery-2026-09-29', status: 'failed', title: 'Deploy preview',
      source: { kind: 'ad_hoc' }, counts: counts({ done: 2, failed: 1, pending: 1 }),
      currentNodeIds: [], waitingNodeIds: [], loops: [], revisit: { count: 0, refreshedNodeIds: [] },
      issue: { nodeId: 'publish-preview', errorClass: 'authentication', errorCode: 'AUTH_REQUIRED' },
      updatedAt: '2026-09-29T01:02:00.000Z',
    },
  },
];

const colors = { green: '#34a853', orange: '#e09b29', red: '#d84a4a', blue: '#3b82f6', grey: '#737b86' };

function plain(value) {
  return String(value ?? '').replace(/\\([_*])/g, '$1').replace(/\*\*/g, '').replace(/`/g, '');
}

function wrap(ctx, text, width) {
  const lines = [];
  for (const sourceLine of plain(text).split('\n')) {
    const words = sourceLine.split(/\s+/);
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(candidate).width > width) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    lines.push(line);
  }
  return lines;
}

function drawCard(card, caption) {
  const canvas = createCanvas(900, 650);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f4f6f8';
  ctx.fillRect(0, 0, 900, 650);
  ctx.fillStyle = '#637083';
  ctx.font = '15px "Pilot Sans", "Pilot Emoji"';
  ctx.fillText(`Automated preview from production Lark card JSON · ${caption}`, 70, 48);

  const left = 70;
  const top = 68;
  const width = 760;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.roundRect(left, top, width, 520, 14);
  ctx.fill();
  ctx.strokeStyle = '#dfe3ea';
  ctx.stroke();

  ctx.save();
  ctx.beginPath();
  ctx.roundRect(left, top, width, 64, [14, 14, 0, 0]);
  ctx.clip();
  ctx.fillStyle = colors[card.header.template] ?? colors.blue;
  ctx.fillRect(left, top, width, 64);
  ctx.restore();
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 22px "Pilot Sans", "Pilot Emoji"';
  ctx.fillText(plain(card.header.title.content), left + 24, top + 39);

  let y = top + 94;
  const bodyLeft = left + 24;
  const bodyWidth = width - 48;
  for (const element of card.elements) {
    if (element.tag === 'hr') {
      ctx.strokeStyle = '#e8ebf0';
      ctx.beginPath(); ctx.moveTo(bodyLeft, y); ctx.lineTo(bodyLeft + bodyWidth, y); ctx.stroke();
      y += 14;
      continue;
    }
    if (element.tag === 'div' && Array.isArray(element.fields)) {
      const columnWidth = bodyWidth / 2 - 12;
      let maxLines = 0;
      element.fields.forEach((field, index) => {
        const column = index % 2;
        const row = Math.floor(index / 2);
        const lines = wrap(ctx, field.text?.content, columnWidth);
        maxLines = Math.max(maxLines, row * 3 + lines.length);
        ctx.fillStyle = '#243147'; ctx.font = '15px "Pilot Sans", "Pilot Emoji"';
        lines.forEach((line, lineIndex) => ctx.fillText(line, bodyLeft + column * (columnWidth + 24), y + row * 64 + lineIndex * 22));
      });
      y += Math.max(68, Math.ceil(element.fields.length / 2) * 64);
      continue;
    }
    if (element.tag === 'note') {
      ctx.fillStyle = '#778196'; ctx.font = '13px "Pilot Sans", "Pilot Emoji"';
      ctx.fillText(plain(element.elements?.[0]?.content), bodyLeft, y);
      y += 28;
      continue;
    }
    if (element.tag === 'div') {
      ctx.fillStyle = '#243147'; ctx.font = '15px "Pilot Sans", "Pilot Emoji"';
      for (const line of wrap(ctx, element.text?.content, bodyWidth)) {
        ctx.fillText(line, bodyLeft, y);
        y += 22;
      }
      y += 8;
      continue;
    }
    if (element.tag === 'action') {
      let x = bodyLeft;
      ctx.font = 'bold 14px "Pilot Sans", "Pilot Emoji"';
      for (const action of element.actions ?? []) {
        const label = plain(action.text?.content);
        const buttonWidth = Math.min(230, ctx.measureText(label).width + 28);
        ctx.fillStyle = '#f8fafc'; ctx.fillRect(x, y, buttonWidth, 36);
        ctx.strokeStyle = '#cbd2dd'; ctx.strokeRect(x, y, buttonWidth, 36);
        ctx.fillStyle = '#315caa'; ctx.fillText(label, x + 14, y + 23);
        x += buttonWidth + 10;
      }
      y += 50;
    }
  }
  return canvas.toBuffer('image/png');
}

await mkdir(outputDir, { recursive: true });
for (const state of states) {
  const card = JSON.parse(buildV3ProgressCard(state.view, {
    locale: 'en',
    webDetailUrl: `https://workbench.example.test/runs/${state.view.runId}`,
  }));
  await writeFile(join(outputDir, `workbench-card-${state.name}.png`), drawCard(card, state.caption));
}

console.log(`wrote ${states.length} Workbench card screenshots to ${outputDir}`);
