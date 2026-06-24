import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defineCommand } from 'citty';
import { z } from 'zod';
import { findRepoRoot, resolveRepoRootForCreate } from '~/core/fs';
import { knowledgeUpdateGate } from '~/core/gates';
import { fileExists } from '~/core/hosts/shared';
import {
  RUNTIME_ERROR_EXIT,
  USAGE_ERROR_EXIT,
  parseOutputFormat,
  writeError,
  writeHuman,
  writeJson,
} from '../util';

/**
 * `ditto knowledge gate` — surface the axis-4 durable-change trigger gate
 * (`knowledgeUpdateGate`) so the knowledge-update skill / knowledge-curator can
 * machine-check its recording decision instead of relying on prose heuristic.
 * The caller declares which of the three triggers fired and the per-update record
 * delta it produced; the gate rejects under-recording (a fired trigger with no
 * matching content) and over-recording (content with no trigger). A non-zero exit
 * means the recording is inconsistent — fix it before closing the knowledge node.
 */
const gateInput = z.object({
  triggers: z.object({
    adr_worthy_decision: z.boolean(),
    new_agreed_term: z.boolean(),
    repeated_pattern: z.boolean(),
  }),
  delta: z.object({
    decisions: z.number().int().nonnegative(),
    glossary_terms: z.number().int().nonnegative(),
    patterns: z.number().int().nonnegative(),
    learnings: z.number().int().nonnegative(),
  }),
});

const knowledgeGate = defineCommand({
  meta: {
    name: 'gate',
    description:
      'Check a durable-knowledge recording against the three axis-4 triggers (under/over-recording)',
  },
  args: {
    json: {
      type: 'string',
      description:
        'JSON: {triggers:{adr_worthy_decision,new_agreed_term,repeated_pattern}, delta:{decisions,glossary_terms,patterns,learnings}}',
      required: true,
    },
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: async ({ args }) => {
    let format: ReturnType<typeof parseOutputFormat>;
    try {
      format = parseOutputFormat(args.output);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(args.json);
    } catch (err) {
      writeError(`--json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const parsed = gateInput.safeParse(raw);
    if (!parsed.success) {
      writeError('--json failed schema validation:');
      for (const issue of parsed.error.issues) {
        writeError(`  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
      }
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const result = knowledgeUpdateGate(parsed.data.triggers, parsed.data.delta);
    if (format === 'json') {
      writeJson({ pass: result.pass, reasons: result.reasons });
    } else {
      writeHuman(`knowledge gate: ${result.pass ? 'PASS' : 'FAIL'}`);
      for (const r of result.reasons) writeHuman(`  - ${r}`);
    }
    if (!result.pass) process.exit(RUNTIME_ERROR_EXIT);
  },
});

/**
 * Slug charset: lowercase alphanumeric words joined by single hyphens.
 * Rejects uppercase, underscores, leading/trailing/double hyphens, and empties —
 * the slug becomes part of the ADR's immutable filename id, so it stays strict.
 */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Two-digit zero-padded helper. */
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** YYYYMMDD in UTC — mirrors `generateId`'s UTC date convention in src/core/id.ts. */
function ymdCompact(now: Date): string {
  return `${now.getUTCFullYear()}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}`;
}

/** YYYY-MM-DD in UTC for the human-readable "결정 일자" body line. */
function ymdDashed(now: Date): string {
  return `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}-${pad2(now.getUTCDate())}`;
}

function adrSkeletonBody(id: string, dateDashed: string): string {
  return `# ${id}: <제목>

- 상태: proposed
- 결정 일자: ${dateDashed}
- 결정자: <작성자>

## 컨텍스트

<무엇이 결정을 강제했는가 — 현황·제약·관측된 문제. 큐레이터가 채운다.>

## 결정

<무엇으로 결정했는가. 큐레이터가 채운다.>

## 근거 (rationale)

<왜 이 결정인가 — 기각한 대안과 트레이드오프. 큐레이터가 채운다.>

## 변경 조건 (change_condition)

<어떤 사실이 관측되면 이 결정을 재검토/철회하는가. 큐레이터가 채운다.>
`;
}

/**
 * Create a new ADR skeleton file `ADR-YYYYMMDD-<slug>.md` under
 * `.ditto/knowledge/adr/`. The whole filename stem is the ADR's immutable id
 * (no separate number/uid). Fail-closed:
 *   - invalid slug → throw (never write).
 *   - target file already exists → throw (never overwrite; a same-day same-slug
 *     collision is a real conflict).
 * `now` is an injectable clock seam (mirrors the `now`-injection convention in
 * `generateId`, src/core/id.ts) so the date is deterministic in tests. The id is
 * date+user-slug only — deterministic, NO random suffix — so unlike generateId
 * there is no random-retry; a clash is surfaced, not silently re-rolled.
 */
export async function createAdrSkeleton(opts: {
  repoRoot: string;
  slug: string;
  now?: Date;
}): Promise<{ id: string; path: string }> {
  const now = opts.now ?? new Date();
  if (!SLUG_RE.test(opts.slug)) {
    throw new Error(
      `invalid --slug "${opts.slug}"; expected lowercase alphanumeric words joined by single hyphens (e.g. my-feature)`,
    );
  }
  const id = `ADR-${ymdCompact(now)}-${opts.slug}`;
  const path = join(opts.repoRoot, '.ditto', 'knowledge', 'adr', `${id}.md`);
  if (await fileExists(path)) {
    throw new Error(`refusing to overwrite existing ADR: ${path}`);
  }
  await writeFile(path, adrSkeletonBody(id, ymdDashed(now)), 'utf8');
  return { id, path };
}

/**
 * Extract an ADR's identifier from its filename, mirroring the canonical
 * extraction in `src/core/knowledge-bridge.ts` (`ADR_ID_RE`). That symbol is NOT
 * exported, and editing the bridge is out of this node's file_scope, so this is a
 * deliberate local copy. The 8-digit(+slug) branch MUST precede `\d{4}`: `\d{4}`
 * is a prefix of `\d{8}`, so a `\d{4}`-first alternation would truncate
 * `ADR-20260624-bar` to `ADR-2026`. For legacy `ADR-NNNN-<slug>.md` this yields
 * the 4-digit prefix `ADR-NNNN`; for new `ADR-YYYYMMDD-<slug>.md` it yields the
 * full stem `ADR-YYYYMMDD-<slug>`.
 * Canonical id grammar source: `src/schemas/knowledge-record.ts` (`adrId` regex).
 */
const ADR_ID_RE = /^ADR-(?:\d{8}-[a-z0-9]+(?:-[a-z0-9]+)*|\d{4})/;

/**
 * Match a *whole* well-formed ADR filename. A legacy file is
 * `ADR-NNNN-<slug>.md` and a new file is `ADR-YYYYMMDD-<slug>.md`, where the
 * slug (`SLUG_RE`) is required after the number. Bare `ADR-NNNN.md` /
 * `ADR-YYYYMMDD.md` (no slug) and `ADR-xyz.md` are malformed.
 */
const ADR_FILENAME_RE = /^ADR-(?:\d{8}|\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;

/** Extract the identifier from a filename, or null when the name is malformed. */
function adrIdFromFilename(filename: string): string | null {
  if (!ADR_FILENAME_RE.test(filename)) return null;
  return filename.match(ADR_ID_RE)?.[0] ?? null;
}

export interface AdrConsistencyResult {
  ok: boolean;
  violations: string[];
  /** Count of well-formed ADR files NOT referenced by knowledge.json (INFO only). */
  unindexedCount: number;
}

const adrCheckIndexSchema = z.object({
  decisions: z.array(z.object({ id: z.string(), path: z.string() })).default([]),
});

/**
 * Fail-closed consistency check over `.ditto/knowledge/adr/`. Returns the full
 * list of violations (empty ⇒ clean). Three checks:
 *   1. Filename format — every `*.md` must be legacy `ADR-NNNN-<slug>.md` or new
 *      `ADR-YYYYMMDD-<slug>.md`.
 *   2. Identifier uniqueness — no two files may extract the same identifier
 *      (e.g. two legacy `ADR-0026-*.md`).
 *   3. Index→file consistency — every `knowledge.json` `decisions[]` `path` must
 *      exist AND its extracted identifier must equal the entry's `id`.
 * Scope guards: files absent from the index are NOT a violation (known
 * out-of-scope index drift, surfaced as `unindexedCount`); number-sequence gaps
 * are never flagged; legacy `ADR-NNNN-*.md` files pass unchanged.
 */
export async function checkAdrConsistency(repoRoot: string): Promise<AdrConsistencyResult> {
  const adrDir = join(repoRoot, '.ditto', 'knowledge', 'adr');
  const violations: string[] = [];

  let files: string[] = [];
  try {
    files = (await readdir(adrDir)).filter((f) => f.endsWith('.md')).sort();
  } catch {
    files = [];
  }

  // Check 1 + identifier extraction.
  const idToFiles = new Map<string, string[]>();
  const indexedIds = new Set<string>();
  for (const f of files) {
    const id = adrIdFromFilename(f);
    if (id === null) {
      violations.push(
        `malformed ADR filename: ${f} (expected ADR-NNNN-<slug>.md or ADR-YYYYMMDD-<slug>.md)`,
      );
      continue;
    }
    indexedIds.add(id);
    const bucket = idToFiles.get(id) ?? [];
    bucket.push(f);
    idToFiles.set(id, bucket);
  }

  // Check 2: identifier uniqueness.
  for (const [id, owners] of idToFiles) {
    if (owners.length > 1) {
      violations.push(`duplicate ADR identifier ${id}: ${owners.join(', ')}`);
    }
  }

  // Load the index (absence ⇒ no index→file checks, not a violation).
  let decisions: { id: string; path: string }[] = [];
  const indexPath = join(repoRoot, '.ditto', 'knowledge', 'knowledge.json');
  try {
    const raw = JSON.parse(await readFile(indexPath, 'utf8'));
    const parsed = adrCheckIndexSchema.safeParse(raw);
    if (parsed.success) decisions = parsed.data.decisions;
  } catch {
    decisions = [];
  }

  // Check 3: index→file consistency (path exists + id matches). One direction
  // only — files missing from the index are intentionally NOT required here.
  const referenced = new Set<string>();
  for (const entry of decisions) {
    const abs = join(repoRoot, entry.path);
    let body: string | null = null;
    try {
      body = await readFile(abs, 'utf8');
    } catch {
      body = null;
    }
    if (body === null) {
      violations.push(`index entry ${entry.id}: path does not exist: ${entry.path}`);
      continue;
    }
    const filename = entry.path.split('/').pop() ?? entry.path;
    referenced.add(filename);
    const extracted = adrIdFromFilename(filename);
    if (extracted === null) {
      violations.push(
        `index entry ${entry.id}: referenced file has a malformed name: ${entry.path}`,
      );
    } else if (extracted !== entry.id) {
      violations.push(
        `index entry id mismatch: ${entry.path} extracts ${extracted}, but the index says ${entry.id}`,
      );
    }
  }

  // INFO: well-formed files not referenced by the index (drift, never a violation).
  const unindexedCount = files.filter(
    (f) => adrIdFromFilename(f) !== null && !referenced.has(f),
  ).length;

  return { ok: violations.length === 0, violations, unindexedCount };
}

const knowledgeAdrCheck = defineCommand({
  meta: {
    name: 'adr-check',
    description:
      'Fail-closed consistency check over .ditto/knowledge/adr/ (filename format, id uniqueness, index→file)',
  },
  args: {
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: async ({ args }) => {
    let format: ReturnType<typeof parseOutputFormat>;
    try {
      format = parseOutputFormat(args.output);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const repoRoot = await findRepoRoot();
    const result = await checkAdrConsistency(repoRoot);
    if (format === 'json') {
      writeJson({
        ok: result.ok,
        violations: result.violations,
        unindexedCount: result.unindexedCount,
      });
    } else {
      writeHuman(`knowledge adr-check: ${result.ok ? 'OK' : 'FAIL'}`);
      for (const v of result.violations) writeHuman(`  - ${v}`);
      writeHuman(`  (info) un-indexed ADR files: ${result.unindexedCount}`);
    }
    if (!result.ok) process.exit(RUNTIME_ERROR_EXIT);
  },
});

const knowledgeAdrNew = defineCommand({
  meta: {
    name: 'adr-new',
    description:
      'Generate a new ADR skeleton ADR-YYYYMMDD-<slug>.md (the filename stem is the immutable id)',
  },
  args: {
    slug: {
      type: 'string',
      description: 'Slug for the ADR id: lowercase alphanumeric words joined by single hyphens',
      required: true,
    },
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: async ({ args }) => {
    let format: ReturnType<typeof parseOutputFormat>;
    try {
      format = parseOutputFormat(args.output);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const repoRoot = await resolveRepoRootForCreate();
    let created: Awaited<ReturnType<typeof createAdrSkeleton>>;
    try {
      created = await createAdrSkeleton({ repoRoot, slug: args.slug });
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(RUNTIME_ERROR_EXIT);
      return;
    }
    if (format === 'json') {
      writeJson({ id: created.id, path: created.path });
    } else {
      writeHuman(`created ADR skeleton: ${created.path}`);
    }
  },
});

export const knowledgeCommand = defineCommand({
  meta: {
    name: 'knowledge',
    description: 'Durable-knowledge (axis-4) helpers: trigger gate for the recording decision',
  },
  subCommands: {
    gate: knowledgeGate,
    'adr-new': knowledgeAdrNew,
    'adr-check': knowledgeAdrCheck,
  },
});
