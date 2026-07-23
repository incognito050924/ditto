import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { atomicWriteText } from '../util/fs';
import { loadKnowledgeSources, renderKnowledgeSummary } from './projection';

/**
 * Project the knowledge summary into CLAUDE.md under a dedicated
 * `ditto:knowledge:start/end` marker family. The block carries the sha256 of
 * its normalized body as the drift key, so "is the projection current?" is a
 * pure content comparison — index and projection can never silently disagree
 * (the projection-consistency half of the guardrail's upstream contract).
 */

export const KNOWLEDGE_END = '<!-- ditto:knowledge:end -->';
const KNOWLEDGE_BLOCK_RE_G =
  /<!--\s*ditto:knowledge:start\s+sha256=([a-f0-9]{64})\s*-->\n?([\s\S]*?)<!--\s*ditto:knowledge:end\s*-->/g;

/** Line-ending + trailing-whitespace normalization applied before hashing and writing. */
function normalizeProjectedText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n');
}

/** sha256 of the normalized text — the drift key stamped into the start marker. */
function normalizedSha256(text: string): string {
  return createHash('sha256').update(normalizeProjectedText(text)).digest('hex');
}

export type KnowledgeSyncAction =
  | 'created'
  | 'updated'
  | 'unchanged'
  | 'would-create'
  | 'would-update'
  | 'would-be-unchanged'
  | 'refused-multiple-markers';

export interface KnowledgeSyncResult {
  path: string;
  action: KnowledgeSyncAction;
  oldSha256: string | null;
  newSha256: string;
  message?: string;
}

function knowledgeBlock(summary: string, sha256: string): string {
  return `<!-- ditto:knowledge:start sha256=${sha256} -->\n${summary}\n${KNOWLEDGE_END}`;
}

interface KnowledgeProjectionState {
  kind: 'missing' | 'no_marker' | 'multiple_markers' | 'ok';
  content?: string;
  count?: number;
  markerSha256?: string;
  startIndex?: number;
  endIndex?: number;
}

function loadProjectionState(content: string | null): KnowledgeProjectionState {
  if (content === null) return { kind: 'missing' };
  const matches = [...content.matchAll(KNOWLEDGE_BLOCK_RE_G)];
  if (matches.length === 0) return { kind: 'no_marker', content };
  if (matches.length > 1) return { kind: 'multiple_markers', content, count: matches.length };
  const match = matches[0];
  if (!match || match.index === undefined) return { kind: 'no_marker', content };
  return {
    kind: 'ok',
    content,
    markerSha256: match[1] ?? '',
    startIndex: match.index,
    endIndex: match.index + match[0].length,
  };
}

/**
 * Sync CLAUDE.md's knowledge block with the current `.ditto/knowledge` sources.
 * Missing file → create; no marker → append below existing content (never
 * touching it); one marker → replace in place (no-op when identical); more
 * than one marker → refuse without writing. `check: true` is a dry-run that
 * reports the would-be action.
 */
export async function syncKnowledgeProjection(
  repoRoot: string,
  options: { check?: boolean } = {},
): Promise<KnowledgeSyncResult> {
  const sources = await loadKnowledgeSources(repoRoot);
  const summary = normalizeProjectedText(renderKnowledgeSummary(sources));
  const sha256 = normalizedSha256(summary);
  const block = knowledgeBlock(summary, sha256);
  const path = join(repoRoot, 'CLAUDE.md');
  const check = options.check === true;

  const existing = await readFile(path, 'utf8').catch(() => null);
  const projection = loadProjectionState(existing);

  if (projection.kind === 'missing') {
    if (!check) await atomicWriteText(path, `${block}\n`);
    return {
      path,
      action: check ? 'would-create' : 'created',
      oldSha256: null,
      newSha256: sha256,
      message: 'created new knowledge block',
    };
  }

  if (projection.kind === 'no_marker') {
    const base = projection.content ?? '';
    const separator = base.endsWith('\n') ? '\n' : '\n\n';
    const next = `${base}${separator}${block}\n`;
    if (!check) await atomicWriteText(path, next);
    return {
      path,
      action: check ? 'would-update' : 'updated',
      oldSha256: null,
      newSha256: sha256,
      message: 'appended new knowledge block',
    };
  }

  if (projection.kind === 'multiple_markers') {
    return {
      path,
      action: 'refused-multiple-markers',
      oldSha256: null,
      newSha256: sha256,
      message: `CLAUDE.md contains ${projection.count} ditto:knowledge blocks; clean up to exactly one before re-running`,
    };
  }

  const content = projection.content ?? '';
  const next = `${content.slice(0, projection.startIndex)}${block}${content.slice(projection.endIndex)}`;
  const unchanged = next === content;
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
    oldSha256: projection.markerSha256 ?? null,
    newSha256: sha256,
  };
}

/** 0 when CLAUDE.md's knowledge block is current with the sources, 1 otherwise. */
export async function knowledgeProjectionDrift(repoRoot: string): Promise<number> {
  const result = await syncKnowledgeProjection(repoRoot, { check: true });
  return result.action === 'would-be-unchanged' ? 0 : 1;
}
