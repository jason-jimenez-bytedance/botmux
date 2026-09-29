#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ASSETS = [
  { name: 'botmux-linux-x64', platform: 'linux', arch: 'x64', libc: 'glibc', minimumLibc: 'glibc 2.28' },
  { name: 'botmux-linux-arm64', platform: 'linux', arch: 'arm64', libc: 'glibc', minimumLibc: 'glibc 2.28' },
  { name: 'botmux-linux-x64-musl', platform: 'linux', arch: 'x64', libc: 'musl' },
  { name: 'botmux-linux-arm64-musl', platform: 'linux', arch: 'arm64', libc: 'musl' },
  { name: 'botmux-darwin-x64', platform: 'darwin', arch: 'x64' },
  { name: 'botmux-darwin-arm64', platform: 'darwin', arch: 'arm64' },
];

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error(`invalid argument: ${key ?? ''}`);
    out[key.slice(2)] = value;
  }
  return out;
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const input = args(process.argv.slice(2));
for (const key of ['dir', 'repo', 'commit', 'version', 'traex-version']) {
  if (!input[key]) throw new Error(`--${key} is required`);
}
const dir = resolve(input.dir);
const version = input.version.replace(/^v/i, '');
const tag = `v${version}`;
if (!/^[0-9a-f]{40}$/i.test(input.commit)) throw new Error('--commit must be a full Git commit SHA');
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version)) {
  throw new Error('--version must be an exact semantic version');
}

const artifacts = ASSETS.map(spec => {
  const path = join(dir, spec.name);
  const checksumPath = `${path}.sha256`;
  if (!existsSync(path) || !existsSync(checksumPath)) throw new Error(`missing release asset or checksum: ${spec.name}`);
  const actual = sha256(path);
  const checksumText = readFileSync(checksumPath, 'utf8').trim();
  const match = /^([0-9a-f]{64})\s+\*?([^\s]+)$/i.exec(checksumText);
  if (!match || match[2] !== spec.name) throw new Error(`invalid checksum file: ${spec.name}.sha256`);
  if (match[1].toLowerCase() !== actual) throw new Error(`checksum mismatch: ${spec.name}`);
  return {
    ...spec,
    file: spec.name,
    url: `https://github.com/${input.repo}/releases/download/${tag}/${spec.name}`,
    sha256: actual,
  };
});

const manifest = {
  schemaVersion: 1,
  distribution: 'github-release',
  sourceRepository: input.repo,
  sourceCommit: input.commit.toLowerCase(),
  version,
  tag,
  testedTraexVersion: input['traex-version'],
  toolchains: {
    node: '22.22.3',
    bun: '1.4.2',
    linuxGlibcX64Builder: 'quay.io/pypa/manylinux_2_28_x86_64@sha256:407f771c51a2c3e83ebe5a7970b4289ead3a6db21d9b9c089168775cad11d328',
    linuxGlibcArm64Builder: 'quay.io/pypa/manylinux_2_28_aarch64@sha256:c22ffd129ac99a8a42d1f2c2f4e88a9089288dd9ee987a7092da1c7dc48f27a9',
    linuxMuslBuilder: 'node:22.22.0-alpine3.22@sha256:7aa86fa052f6e4b101557ccb56717cb4311be1334381f526fe013418fe157384',
  },
  artifacts,
};

writeFileSync(join(dir, 'botmux-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`verified ${artifacts.length} release artifacts and wrote botmux-manifest.json`);
