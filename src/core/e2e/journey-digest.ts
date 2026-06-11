import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { parseYaml } from '../hosts/shared';
import { splitFrontMatter } from './journey-dsl';

/**
 * Journey DSL digest + provenance mechanics (wi_260610p9h ac-4/ac-8).
 *
 * Every generated artifact (`e2e/generated/*.spec.ts`, `support/*.block.ts`)
 * carries a header embedding the source DSL path and the sha256 of the source.
 * That makes two things mechanical:
 *  - ac-4: a DSL edited after its last generation is detected as STALE
 *    (header digest ≠ current source digest) — no human memory involved.
 *  - ac-8: derived specs are identified by the `@ditto-generated` marker;
 *    human-authored specs (no marker) are never mistaken for derived ones.
 *
 * Digest input is the CANONICAL source text (`computeSourceDigest`): the
 * `flaky_history` front-matter field is operational metadata written by the
 * verdict ledger, not journey behavior — including it would turn every flaky
 * verdict into a false-stale regeneration demand (dialectic-1 O-2). Raw-bytes
 * digests from artifacts generated before this rule are still accepted.
 */

export function sha256Hex(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Canonical digest text: the source with operational metadata (front-matter
 * `flaky_history`) removed. Non-front-matter documents, non-mapping
 * front-matter, and YAML parse failures fall back to the raw text — the digest
 * never throws on user input.
 */
export function canonicalDigestText(text: string): string {
  const split = splitFrontMatter(text);
  if (!split) return text;
  let raw: unknown;
  try {
    raw = parseYaml(split.frontMatter);
  } catch {
    return text;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return text;
  // Always re-stringify (not only when flaky_history is present): the verdict
  // ledger writes front-matter through the same YAML stringifier, so canonical
  // equality must not depend on the author's original YAML formatting.
  const { flaky_history: _omitted, ...record } = raw as Record<string, unknown>;
  return `---\n${stringifyYaml(record)}---\n${split.body}`;
}

/** sha256 of the canonical source text — what generated headers must embed. */
export function computeSourceDigest(text: string): string {
  return sha256Hex(canonicalDigestText(text));
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
 * digest mismatch means the DSL changed after the last generation. The header
 * digest may be canonical (current convention) or raw-bytes (pre-O-2
 * artifacts) — either match proves freshness. When `expectedSource` is given,
 * a header `@ditto-source` pointing elsewhere is stale (O-15: provenance is
 * source path + digest, not digest alone).
 */
export async function detectStale(
  sourceAbs: string,
  generatedAbs: string,
  expectedSource?: string,
): Promise<StaleVerdict> {
  let sourceText: string;
  try {
    sourceText = await readFile(sourceAbs, 'utf8');
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
  if (expectedSource !== undefined && header.source !== expectedSource) {
    return {
      stale: true,
      reason: `@ditto-source mismatch: header points at ${header.source}, expected ${expectedSource} — provenance unprovable`,
    };
  }
  const canonical = computeSourceDigest(sourceText);
  const raw = sha256Hex(sourceText);
  if (header.digest !== canonical && header.digest !== raw) {
    return {
      stale: true,
      reason: `digest mismatch: header sha256:${header.digest} ≠ current source sha256:${canonical} (DSL changed after last generation)`,
    };
  }
  return { stale: false, reason: 'header digest matches current source' };
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
