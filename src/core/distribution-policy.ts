import { readGlobalConfig } from '../global-config.js';

/** This downstream is distributed exclusively through this fork's GitHub Releases. */
export const BOTMUX_DISTRIBUTION_REPOSITORY = process.env.BOTMUX_GITHUB_REPO?.trim()
  || 'jason-jimenez-bytedance/botmux';

export const BOTMUX_DISTRIBUTION_SOURCE = 'github-release' as const;

/** Exact semver accepted for an approved Workbench rollout. */
export function normalizeApprovedVersion(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().replace(/^v/i, '');
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(normalized)
    ? normalized
    : undefined;
}

/**
 * Workbench may pin a reviewed build either in the machine config or in the
 * service environment. The environment wins so a managed service can enforce
 * policy without rewriting a user's config file.
 */
export function approvedDistributionVersion(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return normalizeApprovedVersion(env.BOTMUX_APPROVED_VERSION)
    ?? normalizeApprovedVersion(readGlobalConfig().distribution?.approvedVersion);
}
