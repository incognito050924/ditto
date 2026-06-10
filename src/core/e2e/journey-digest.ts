import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/**
 * Journey DSL digest + provenance mechanics (wi_260610p9h ac-4/ac-8).
 *
 * Every generated artifact (`e2e/generated/*.spec.ts`, `support/*.block.ts`)
 * carries a header embedding the source DSL path and the sha256 of the source
 * file bytes. That makes two things mechanical:
 *  - ac-4: a DSL edited after its last generation is detected as STALE
 *    (header digest ≠ current source digest) — no human memory involved.
 *  - ac-8: derived specs are identified by the `@ditto-generated` marker;
 *    human-authored specs (no marker) are never mistaken for derived ones.
 */

export function sha256Hex(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export interface GeneratedHeaderInput {
  /** Repo-relative path of the source DSL file (e.g. e2e/journeys/x.journey.md). */
  sourcePath: string;
  /** sha256 (64-hex) of the source file BYTES at generation time. */
  digest: string;
  kind: 'journey' | 'block';
  /** journey id (jrn-…) or block id, depending on kind. */
  id: string;
}

/** Render the provenance header to place at the top of a generated file. */
export function renderGeneratedHeader(input: GeneratedHeaderInput): string {
  const idTag = input.kind === 'journey' ? '@ditto-journey' : '@ditto-block';
  return [
    '/**',
    ' * @ditto-generated',
    ` * @ditto-source ${input.sourcePath}`,
    ` * @ditto-digest sha256:${input.digest}`,
    ` * ${idTag} ${input.id}`,
    ' */',
  ].join('\n');
}

export interface GeneratedHeader {
  source: string;
  digest: string;
  journey?: string;
  block?: string;
}

const headerLine = (tag: string) => new RegExp(`^\\s*\\*\\s*${tag}\\s+(\\S+)\\s*$`, 'm');
// Marker must START a line (modulo comment decoration) — a mid-line mention in
// prose or a string literal does not identify a file as generated.
const generatedMarker = /^\s*(?:\/\/|\/?\*+)?\s*@ditto-generated\s*$/m;

/** Whether file content is a DITTO-generated artifact (ac-8 식별의 절반). */
export function isDittoGenerated(content: string): boolean {
  return generatedMarker.test(content);
}

/** Parse the provenance header out of a generated file; null when absent. */
export function parseGeneratedHeader(content: string): GeneratedHeader | null {
  if (!isDittoGenerated(content)) return null;
  const source = headerLine('@ditto-source').exec(content)?.[1];
  const digest = /^\s*\*\s*@ditto-digest\s+sha256:([a-f0-9]{64})\s*$/m.exec(content)?.[1];
  if (!source || !digest) return null;
  const journey = headerLine('@ditto-journey').exec(content)?.[1];
  const block = headerLine('@ditto-block').exec(content)?.[1];
  return {
    source,
    digest,
    ...(journey ? { journey } : {}),
    ...(block ? { block } : {}),
  };
}

export interface StaleVerdict {
  stale: boolean;
  reason: string;
}

/**
 * ac-4: is the generated file out of date w.r.t. its source DSL? Missing or
 * header-less generated files are stale (freshness cannot be proven), and a
 * digest mismatch means the DSL changed after the last generation.
 */
export async function detectStale(sourceAbs: string, generatedAbs: string): Promise<StaleVerdict> {
  let sourceBytes: Uint8Array;
  try {
    sourceBytes = await readFile(sourceAbs);
  } catch {
    return { stale: true, reason: `source DSL not readable: ${sourceAbs}` };
  }
  let generated: string;
  try {
    generated = await readFile(generatedAbs, 'utf8');
  } catch {
    return {
      stale: true,
      reason: `generated file not readable (never generated?): ${generatedAbs}`,
    };
  }
  const header = parseGeneratedHeader(generated);
  if (!header) {
    return {
      stale: true,
      reason: 'generated file has no @ditto-digest header; freshness unprovable',
    };
  }
  const current = sha256Hex(sourceBytes);
  if (header.digest !== current) {
    return {
      stale: true,
      reason: `digest mismatch: header sha256:${header.digest} ≠ current source sha256:${current} (DSL changed after last generation)`,
    };
  }
  return { stale: false, reason: 'header digest matches current source bytes' };
}

export interface SpecPartition {
  /** dir-relative POSIX paths of DITTO-generated files. */
  generated: string[];
  /** dir-relative POSIX paths of human-authored files. */
  manual: string[];
}

/** ac-8: scan a directory (recursive) and split .ts files into derived vs manual. */
export async function partitionSpecFiles(dirAbs: string): Promise<SpecPartition> {
  const entries = await readdir(dirAbs, { recursive: true, withFileTypes: true });
  const generated: string[] = [];
  const manual: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    const abs = join(entry.parentPath, entry.name);
    const rel = relative(dirAbs, abs).split(sep).join('/');
    const content = await readFile(abs, 'utf8');
    (isDittoGenerated(content) ? generated : manual).push(rel);
  }
  return { generated, manual };
}
