import { join } from 'node:path';
import { atomicWriteText } from './fs';
import {
  MANAGED_END,
  loadProjection,
  loadSource,
  normalizeInstructionText,
} from './instruction-bridge';

export type BridgeSyncAction =
  | 'created'
  | 'updated'
  | 'unchanged'
  | 'would-create'
  | 'would-update'
  | 'would-be-unchanged'
  | 'refused-multiple-markers';

export interface BridgeSyncResult {
  path: string;
  action: BridgeSyncAction;
  oldSha256: string | null;
  newSha256: string;
  message?: string;
}

function managedBlock(sourceContent: string, sha256: string): string {
  const body = normalizeInstructionText(sourceContent);
  return `<!-- ditto:managed:start source=AGENTS.md sha256=${sha256} -->\n${body}${MANAGED_END}`;
}

export async function syncClaudeCodeProjection(
  repoRoot: string,
  options: { check?: boolean } = {},
): Promise<BridgeSyncResult> {
  const source = await loadSource(repoRoot);
  if ('kind' in source) throw new Error('AGENTS.md is missing; cannot sync Claude projection');
  const path = join(repoRoot, 'CLAUDE.md');
  const projection = await loadProjection(repoRoot);
  const block = managedBlock(source.content, source.normalizedSha256);
  const check = options.check === true;

  if (projection.kind === 'missing') {
    if (!check) await atomicWriteText(path, `${block}\n`);
    return {
      path,
      action: check ? 'would-create' : 'created',
      oldSha256: null,
      newSha256: source.normalizedSha256,
      message: 'created new managed block',
    };
  }

  if (projection.kind === 'no_marker') {
    const separator = projection.content.endsWith('\n') ? '\n' : '\n\n';
    const next = `${projection.content}${separator}${block}\n`;
    if (!check) await atomicWriteText(path, next);
    return {
      path,
      action: check ? 'would-update' : 'updated',
      oldSha256: null,
      newSha256: source.normalizedSha256,
      message: 'appended new managed block',
    };
  }

  if (projection.kind === 'multiple_markers') {
    return {
      path,
      action: 'refused-multiple-markers',
      oldSha256: null,
      newSha256: source.normalizedSha256,
      message: `CLAUDE.md contains ${projection.count} ditto managed blocks; clean up to exactly one block before re-running bridge sync`,
    };
  }

  const next = `${projection.content.slice(0, projection.startIndex)}${block}${projection.content.slice(
    projection.endIndex,
  )}`;
  const unchanged = next === projection.content;
  if (!unchanged && !check) await atomicWriteText(path, next);
  return {
    path,
    action: unchanged
      ? check
        ? 'would-be-unchanged'
        : 'unchanged'
      : check
        ? 'would-update'
        : 'updated',
    oldSha256: projection.markerSha256,
    newSha256: source.normalizedSha256,
  };
}
