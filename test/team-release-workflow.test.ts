import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import {
  BOTMUX_DISTRIBUTION_REPOSITORY,
  BOTMUX_DISTRIBUTION_SOURCE,
  approvedDistributionVersion,
  normalizeApprovedVersion,
} from '../src/core/distribution-policy.js';

const ASSETS = [
  'botmux-linux-x64',
  'botmux-linux-arm64',
  'botmux-linux-x64-musl',
  'botmux-linux-arm64-musl',
  'botmux-darwin-x64',
  'botmux-darwin-arm64',
] as const;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('fork distribution policy', () => {
  it('uses only this fork and normalizes exact approved versions', () => {
    expect(BOTMUX_DISTRIBUTION_SOURCE).toBe('github-release');
    expect(BOTMUX_DISTRIBUTION_REPOSITORY).toBe('jason-jimenez-bytedance/botmux');
    expect(normalizeApprovedVersion(' v3.31.0-rc.2 ')).toBe('3.31.0-rc.2');
    expect(normalizeApprovedVersion('latest')).toBeUndefined();
    expect(normalizeApprovedVersion('03.31.0')).toBeUndefined();
    expect(normalizeApprovedVersion('3.31.0-..')).toBeUndefined();
  });

  it('lets a managed environment pin override the machine config lookup', () => {
    expect(approvedDistributionVersion({ BOTMUX_APPROVED_VERSION: 'v3.31.0' }))
      .toBe('3.31.0');
  });
});

describe('team release manifest', () => {
  function fixture(): string {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-release-manifest-'));
    dirs.push(dir);
    for (const [index, asset] of ASSETS.entries()) {
      const body = Buffer.from(`artifact-${index}-${asset}`);
      writeFileSync(join(dir, asset), body);
      const digest = createHash('sha256').update(body).digest('hex');
      writeFileSync(join(dir, `${asset}.sha256`), `${digest}  ${asset}\n`);
    }
    return dir;
  }

  function generate(dir: string): void {
    execFileSync(process.execPath, [
      resolve('scripts/generate-release-manifest.mjs'),
      '--dir', dir,
      '--repo', 'jason-jimenez-bytedance/botmux',
      '--commit', 'a'.repeat(40),
      '--version', '3.31.0-rc.2',
      '--traex-version', '0.207.1',
    ], { stdio: 'pipe' });
  }

  it('records provenance, supported targets, URLs, libc constraints, and verified SHA-256 values', () => {
    const dir = fixture();
    generate(dir);
    const manifest = JSON.parse(readFileSync(join(dir, 'botmux-manifest.json'), 'utf8'));

    expect(manifest).toMatchObject({
      schemaVersion: 1,
      distribution: 'github-release',
      sourceRepository: 'jason-jimenez-bytedance/botmux',
      sourceCommit: 'a'.repeat(40),
      version: '3.31.0-rc.2',
      tag: 'v3.31.0-rc.2',
      testedTraexVersion: '0.207.1',
    });
    expect(manifest.artifacts.map((artifact: { file: string }) => artifact.file)).toEqual(ASSETS);
    for (const artifact of manifest.artifacts) {
      expect(artifact.url).toBe(
        `https://github.com/jason-jimenez-bytedance/botmux/releases/download/v3.31.0-rc.2/${artifact.file}`,
      );
      expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(manifest.artifacts.find((artifact: { file: string }) => artifact.file === 'botmux-linux-x64'))
      .toMatchObject({ platform: 'linux', arch: 'x64', libc: 'glibc', minimumLibc: 'glibc 2.28' });
    expect(manifest.artifacts.find((artifact: { file: string }) => artifact.file === 'botmux-linux-arm64-musl'))
      .toMatchObject({ platform: 'linux', arch: 'arm64', libc: 'musl' });
  });

  it('fails closed when checksum contents do not match an artifact', () => {
    const dir = fixture();
    writeFileSync(join(dir, 'botmux-linux-x64.sha256'), `${'0'.repeat(64)}  botmux-linux-x64\n`);
    expect(() => generate(dir)).toThrow();
    expect(() => readFileSync(join(dir, 'botmux-manifest.json'))).toThrow();
  });
});

describe('team-release.yml', () => {
  const path = resolve('.github/workflows/team-release.yml');
  const document = parseYaml(readFileSync(path, 'utf8')) as {
    jobs: Record<string, { needs?: string | string[]; steps?: Array<{ name?: string; run?: string }> }>;
  };
  const jobs = document.jobs;
  const runs = (job: string): string => (jobs[job].steps ?? []).map(step => step.run ?? '').join('\n');

  it('gates every build on tests and smoke-tests every published target', () => {
    expect(runs('quality')).toContain('bun run build');
    expect(runs('quality')).toContain('bun run test');
    expect(jobs.native.needs).toBe('quality');
    expect(jobs.musl.needs).toBe('quality');
    expect(runs('native')).toContain('smoke-bun-binary.mjs');
    expect(runs('musl')).toContain('smoke-bun-binary.mjs');
  });

  it('pins Linux builders and records the tested TRAEx version in the manifest', () => {
    expect(readFileSync(resolve('scripts/build-linux-glibc-baseline.sh'), 'utf8')).toMatch(/manylinux_2_28_x86_64@sha256:/);
    expect(readFileSync(resolve('scripts/build-linux-glibc-baseline.sh'), 'utf8')).toMatch(/manylinux_2_28_aarch64@sha256:/);
    expect(runs('musl')).toMatch(/node:22\.22\.0-alpine3\.22@sha256:/);
    expect(runs('publish')).toContain('--traex-version "0.207.1"');
  });

  it('builds and smokes each macOS target on its matching native architecture', () => {
    const matrix = JSON.stringify(jobs.native);
    const source = readFileSync(resolve('scripts/build-bun-binary.mjs'), 'utf8');
    expect(matrix).toContain('macos-15-intel');
    expect(matrix).toContain('bun-darwin-x64');
    expect(matrix).toContain('"expected_uname":"x86_64"');
    expect(matrix).toContain('macos-14');
    expect(matrix).toContain('bun-darwin-arm64');
    expect(matrix).toContain('"expected_uname":"arm64"');
    expect(runs('native')).toContain('test "$(uname -m)" = "${{ matrix.expected_uname }}"');
    expect(source).not.toContain("'bun-darwin-x64-baseline'");
  });

  it('resolves an annotated tag to its commit without passing literal quotes to git', () => {
    const provenance = 'test "$(git rev-parse HEAD)" = "$(git rev-parse "${GITHUB_REF_NAME}^{commit}")"';
    expect(runs('native')).toContain(provenance);
    expect(runs('musl')).toContain(provenance);
    expect(runs('native')).not.toContain('git rev-parse \\"${GITHUB_REF_NAME}^{commit}\\"');
    expect(runs('musl')).not.toContain('git rev-parse \\"${GITHUB_REF_NAME}^{commit}\\"');
  });

  it('verifies checksum contents, refuses overwrite, and leaves a complete draft for live acceptance', () => {
    const publish = runs('publish');
    expect(publish).toContain('sha256sum -c ./*.sha256');
    expect(publish).toContain('generate-release-manifest.mjs');
    expect(publish.indexOf('gh release view')).toBeLessThan(publish.indexOf('gh release create'));
    expect(publish).toContain('--draft');
    expect(publish).toContain('--prerelease');
    expect(publish).not.toContain('--draft=false');
    for (const asset of ASSETS) expect(publish).toContain(asset);
  });
});

describe('docs-deploy.yml fork guard', () => {
  const path = resolve('.github/workflows/docs-deploy.yml');
  const document = parseYaml(readFileSync(path, 'utf8')) as {
    on: Record<string, unknown>;
    jobs: Record<string, { if?: string }>;
  };

  it('cannot publish from a fork master push or without explicit upstream confirmation', () => {
    expect(document.on).not.toHaveProperty('push');
    expect(document.on).toHaveProperty('workflow_dispatch');
    expect(document.jobs.deploy.if).toContain("github.repository == 'deepcoldy/botmux'");
    expect(document.jobs.deploy.if).toContain('inputs.publish == true');
  });
});
