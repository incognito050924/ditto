import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import {
  type LabelerLabel,
  type OracleClaim,
  type OracleEnforcementTier,
  type OracleVerdict,
  isDecidableOraclePattern,
} from '~/schemas/coverage';
import { codePointerMapsTo } from '~/schemas/work-item';

/**
 * 2-mode deterministic coverage oracle (wi_260706n4w n4, ac-1/ac-7).
 *
 * presence = the cited file:line really exists (codePointerMapsTo vocabulary);
 * absence = "`pattern` does not occur under `scope_path`", refuted-or-confirmed
 * by `git grep`. NO LLM judgment lives here — every verdict is a deterministic
 * function of the claim + the working tree. Loop wiring is n5's; this module
 * only evaluates one claim into one `OracleVerdict` (schema layer, ADR-0002).
 *
 * SECURITY — a claim is UNTRUSTED LLM output. The trust boundary is the shape
 * gate + argv exec (mirrors cleanup-scan's exec safety, diverges on exit
 * handling):
 *  - argv array only, never `sh -c` / string interpolation;
 *  - `-F` fixed-string (regex metas are inert), `-e` binds the pattern (a
 *    leading `-` cannot become a flag), `--` cuts the pathspec (same for
 *    scope_path);
 *  - scope_path containment BEFORE exec: absolute / `..`-escaping paths are
 *    rejected (cleanup-scan precedent), plus `:`-leading paths — git pathspec
 *    magic such as `:(exclude)*` empties the search set and exits 1, which
 *    would false-confirm a fabricated absence claim (probed 2026-07-07);
 *  - scope_path must EXIST under repoRoot: `git grep` exits 1 (no-match, NOT
 *    ≥2) on a nonexistent pathspec on this host (probed 2026-07-07 — diverges
 *    from the design contract's exit-≥2 assumption), so without this check a
 *    fabricated scope would coerce to CONFIRMED absent.
 *
 * Exit 3-way branch (MANDATORY — never collapse like the cleanup-scan
 * `exitCode !== 0` anti-pattern): exit 1 → confirmed absent; exit 0 → refuted
 * (the claimed-absent token is real → fabricated claim); anything else
 * (≥2 / signal) → advisory_unverified. An error is NEVER coerced to "absent".
 *
 * ADR-0006: grep-only — no AST / CodeQL here; structural absence ("no caller
 * of X") is out of scope. ADR-0018: a missing `git` binary degrades to an
 * advisory verdict (tool_absent), never a hard gate (ac-7).
 */

/** Executor options — `gitBin` exists for the ADR-0018 tool-absent seam. */
export interface OracleExecOptions {
  gitBin?: string;
}

export type AbsenceCheckResult =
  | { kind: 'confirmed_absent'; exit_code: number }
  | { kind: 'refuted_present'; exit_code: number }
  | { kind: 'shape_rejected'; detail: string }
  | { kind: 'exec_error'; exit_code?: number; detail?: string }
  | { kind: 'tool_absent'; detail?: string };

/**
 * Containment gate over an untrusted repo-relative path (cleanup-scan:188-189
 * precedent + the pathspec-magic and traversal cases a claim can smuggle).
 */
export function containScopePath(
  p: string,
  repoRoot: string,
): { ok: true; abs: string } | { ok: false; detail: string } {
  if (p.length === 0) return { ok: false, detail: 'empty scope_path' };
  if (isAbsolute(p)) return { ok: false, detail: `absolute scope_path rejected: ${p}` };
  if (p.startsWith('..')) return { ok: false, detail: `parent-escaping scope_path rejected: ${p}` };
  if (p.startsWith(':')) {
    // git pathspec magic (`:(exclude)…`, `:/…`) — probed: it can empty the
    // search set into a no-match exit 1, i.e. a false CONFIRMED absent.
    return { ok: false, detail: `git pathspec magic rejected: ${p}` };
  }
  const root = resolve(repoRoot);
  const abs = resolve(root, p);
  if (abs !== root && !abs.startsWith(root + sep)) {
    return { ok: false, detail: `scope_path escapes repoRoot: ${p}` };
  }
  return { ok: true, abs };
}

/**
 * Absence executor (the net-new piece): does `pattern` occur under
 * `scope_path`? Shape gate + containment live INSIDE the executor so an
 * ungated caller can never reach exec with unsafe input.
 */
export function runAbsenceCheck(
  pattern: string,
  scopePath: string,
  repoRoot: string,
  opts: OracleExecOptions = {},
): AbsenceCheckResult {
  if (!isDecidableOraclePattern(pattern)) {
    return {
      kind: 'shape_rejected',
      detail:
        'pattern is not a decidable token (single non-whitespace fixed string within the length cap)',
    };
  }
  const scope = containScopePath(scopePath, repoRoot);
  if (!scope.ok) return { kind: 'shape_rejected', detail: scope.detail };
  if (!existsSync(scope.abs)) {
    // Probed divergence: git grep exits 1 (no-match) on a nonexistent
    // pathspec — the 3-way branch alone would false-confirm a fabricated scope.
    return { kind: 'shape_rejected', detail: `scope_path not found in repo: ${scopePath}` };
  }

  let proc: ReturnType<typeof Bun.spawnSync>;
  try {
    proc = Bun.spawnSync([opts.gitBin ?? 'git', 'grep', '-F', '-e', pattern, '--', scopePath], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch (err) {
    // ADR-0018: the scan tool being unusable degrades to advisory, never a
    // hard verdict and never a hard gate (ac-7).
    return { kind: 'tool_absent', detail: err instanceof Error ? err.message : String(err) };
  }

  const exit = proc.exitCode;
  if (exit === 1) return { kind: 'confirmed_absent', exit_code: 1 };
  if (exit === 0) return { kind: 'refuted_present', exit_code: 0 };
  // exit ≥2 or signal-terminated (null): an error, NEVER "absent".
  return {
    kind: 'exec_error',
    ...(typeof exit === 'number' ? { exit_code: exit } : {}),
    detail: (proc.stderr?.toString() ?? '').slice(0, 200),
  };
}

export type PresenceCheckResult =
  | { kind: 'confirmed' }
  | { kind: 'refuted'; detail: string }
  | { kind: 'shape_rejected'; detail: string }
  | { kind: 'exec_error'; detail: string };

/** Content line count: a trailing newline does not open a phantom last line. */
function countLines(content: string): number {
  if (content.length === 0) return 0;
  const parts = content.split('\n');
  return content.endsWith('\n') ? parts.length - 1 : parts.length;
}

/**
 * Presence executor: does the cited `file:line` (codePointerMapsTo grammar —
 * REUSED from work-item.ts, no new citation syntax) really exist? Decidable
 * iff the suffix is a line number `N` or an in-order range `N-M`; a
 * `path:symbol` suffix is grammar-valid but not line-checkable → shape gate.
 */
export function runPresenceCheck(mapsTo: string, repoRoot: string): PresenceCheckResult {
  if (!codePointerMapsTo.test(mapsTo)) {
    return {
      kind: 'shape_rejected',
      detail: 'citation is not a file:line code pointer (codePointerMapsTo grammar)',
    };
  }
  const cut = mapsTo.lastIndexOf(':');
  const filePart = mapsTo.slice(0, cut);
  const lineSpec = mapsTo.slice(cut + 1);
  const m = /^(\d+)(?:-(\d+))?$/.exec(lineSpec);
  if (!m || m[1] === undefined) {
    return { kind: 'shape_rejected', detail: `suffix "${lineSpec}" is not a checkable line/range` };
  }
  const start = Number(m[1]);
  const end = m[2] === undefined ? start : Number(m[2]);
  if (end < start) {
    return { kind: 'shape_rejected', detail: `reversed line range "${lineSpec}"` };
  }
  const contained = containScopePath(filePart, repoRoot);
  if (!contained.ok) return { kind: 'shape_rejected', detail: contained.detail };

  let content: string;
  try {
    content = readFileSync(contained.abs, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { kind: 'refuted', detail: `cited file does not exist: ${filePart}` };
    }
    // Unreadable for another reason (EACCES/EISDIR/…): an error, never a hard verdict.
    return {
      kind: 'exec_error',
      detail: `cited file unreadable (${code ?? 'unknown'}): ${filePart}`,
    };
  }
  const lines = countLines(content);
  if (start >= 1 && end <= lines) return { kind: 'confirmed' };
  return {
    kind: 'refuted',
    detail: `cited line ${lineSpec} does not exist (${filePart} has ${lines} lines)`,
  };
}

/**
 * Risk-tier categories (coverage-taxonomy floor ids): a DECIDABLE-refuted
 * claim in these fails closed (hard_reject); everything else is advisory.
 */
export const RISK_TIER_CATEGORY_IDS = ['injection', 'secret-exposure'] as const;

/**
 * Enforcement strength for a claim's category. Accepts both the bare floor id
 * and the seeded `cov-cat-<id>` node id (the verdict schema allows either).
 * The tier is the category's STATIC strength class — decidability is carried
 * by the outcome; `isHardRejected` combines the two.
 */
export function enforcementTierForCategory(categoryId?: string): OracleEnforcementTier {
  if (categoryId === undefined) return 'advisory';
  const bare = categoryId.startsWith('cov-cat-') ? categoryId.slice('cov-cat-'.length) : categoryId;
  return (RISK_TIER_CATEGORY_IDS as readonly string[]).includes(bare) ? 'hard_reject' : 'advisory';
}

/**
 * The fail-closed decision (ac-1): ONLY a decidable-refuted claim in the risk
 * tier hard-rejects. A refuted claim can only come out of the executor, so
 * `outcome === 'refuted'` already implies decidability; every advisory
 * (shape gate / exec error / tool absent, ac-7) stays a signal — never a gate.
 */
export function isHardRejected(verdict: OracleVerdict): boolean {
  return verdict.tier === 'hard_reject' && verdict.outcome === 'refuted';
}

// ── fabrication correlation — the deterministic CORRELATE slot (ac-5, n9) ──
// oracle = ENFORCE, labeler = JUDGE, this function = CORRELATE: the fabrication
// measurement joins the two INDEPENDENT sets ({oracle verdicts} × {verdict-blind
// labeler labels}) on claim_id — computed by deterministic ditto code, never by
// either agent (the third circularity blocker of the design contract).

/** Deterministic correlation of the ENFORCE set × the JUDGE set (ac-5). */
export interface FabricationCorrelation {
  /** Oracle outcome counts (ENFORCE set, deduped by claim_id — last wins). */
  oracle: { claims: number; confirmed: number; refuted: number; advisory_unverified: number };
  /** Labeler label counts (JUDGE set, deduped by claim_id — last wins). */
  labeler: { claims: number; real: number; fabricated: number };
  /** Contingency matrix over claim_ids present in BOTH sets. */
  joint: {
    pairs: number;
    confirmed_real: number;
    confirmed_fabricated: number;
    refuted_real: number;
    refuted_fabricated: number;
    advisory_real: number;
    advisory_fabricated: number;
  };
  /**
   * Claims visible to only one set — kept visible, never silently dropped.
   * `labeler_only` also guards the routing blind spot: a claim self-declaring a
   * user-intent category bypasses the oracle and never lands in the sidecar, so
   * the labeler's observable population is the code-verify-routed claims; a
   * label with no matching verdict is an anomaly the measurement must surface.
   */
  unmatched: { oracle_only: number; labeler_only: number };
  /**
   * Rates are `null` when the denominator is 0 — an unmeasured rate is
   * UNMEASURABLE, never 0% (no fabricated numbers, ac-5).
   */
  rates: {
    /** refuted / (confirmed + refuted) — decidable oracle outcomes only. */
    oracle_fabrication_rate: number | null;
    /** fabricated / (real + fabricated). */
    labeler_fabrication_rate: number | null;
    /** (confirmed×real + refuted×fabricated) / decidable joint pairs. */
    decidable_agreement_rate: number | null;
  };
}

/** null-not-zero: a 0-denominator rate is unmeasurable, never 0%. */
function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

/**
 * Correlate the two independent measurement sets into the fabrication tally
 * (ac-5). Pure and deterministic — no I/O, no agent judgment.
 */
export function correlateFabrication(
  oracleVerdicts: readonly OracleVerdict[],
  labelerLabels: readonly LabelerLabel[],
): FabricationCorrelation {
  // Dedupe by claim_id, last wins — the same merge semantics the
  // oracle-provenance sidecar applies (coverage-loop appendOracleVerdicts).
  const verdictById = new Map(oracleVerdicts.map((v) => [v.claim_id, v]));
  const labelById = new Map(labelerLabels.map((l) => [l.claim_id, l]));
  const verdicts = [...verdictById.values()];
  const labels = [...labelById.values()];
  const countOutcome = (outcome: OracleVerdict['outcome']): number =>
    verdicts.filter((v) => v.outcome === outcome).length;
  const countLabel = (label: LabelerLabel['label']): number =>
    labels.filter((l) => l.label === label).length;
  const oracle = {
    claims: verdicts.length,
    confirmed: countOutcome('confirmed'),
    refuted: countOutcome('refuted'),
    advisory_unverified: countOutcome('advisory_unverified'),
  };
  const labeler = {
    claims: labels.length,
    real: countLabel('real'),
    fabricated: countLabel('fabricated'),
  };
  const joint = {
    pairs: 0,
    confirmed_real: 0,
    confirmed_fabricated: 0,
    refuted_real: 0,
    refuted_fabricated: 0,
    advisory_real: 0,
    advisory_fabricated: 0,
  };
  const cell = (
    outcome: OracleVerdict['outcome'],
    label: LabelerLabel['label'],
  ): keyof typeof joint => {
    const row = outcome === 'advisory_unverified' ? 'advisory' : outcome;
    return `${row}_${label}` as keyof typeof joint;
  };
  let oracleOnly = 0;
  for (const v of verdicts) {
    const label = labelById.get(v.claim_id);
    if (label === undefined) {
      oracleOnly += 1;
      continue;
    }
    joint.pairs += 1;
    joint[cell(v.outcome, label.label)] += 1;
  }
  const labelerOnly = labels.filter((l) => !verdictById.has(l.claim_id)).length;
  return {
    oracle,
    labeler,
    joint,
    unmatched: { oracle_only: oracleOnly, labeler_only: labelerOnly },
    rates: {
      oracle_fabrication_rate: ratio(oracle.refuted, oracle.confirmed + oracle.refuted),
      labeler_fabrication_rate: ratio(labeler.fabricated, labeler.real + labeler.fabricated),
      decidable_agreement_rate: ratio(
        joint.confirmed_real + joint.refuted_fabricated,
        joint.confirmed_real +
          joint.confirmed_fabricated +
          joint.refuted_real +
          joint.refuted_fabricated,
      ),
    },
  };
}

/** One raw claim handed to the oracle (untrusted; ids are the correlation keys). */
export interface OracleClaimInput {
  claim_id: string;
  category_id?: string;
  claim: OracleClaim;
}

/**
 * Evaluate one 2-mode claim into a raw `OracleVerdict` (ENFORCE set). Every
 * degradation is self-describing via `advisory_reason` (schema superRefine).
 */
export function evaluateOracleClaim(
  input: OracleClaimInput,
  repoRoot: string,
  opts: OracleExecOptions = {},
): OracleVerdict {
  const base = {
    claim_id: input.claim_id,
    ...(input.category_id !== undefined ? { category_id: input.category_id } : {}),
    claim: input.claim,
    tier: enforcementTierForCategory(input.category_id),
  };

  if (input.claim.mode === 'presence') {
    const p = runPresenceCheck(input.claim.maps_to, repoRoot);
    switch (p.kind) {
      case 'confirmed':
        return { ...base, outcome: 'confirmed' };
      case 'refuted':
        return { ...base, outcome: 'refuted', detail: p.detail };
      case 'shape_rejected':
        return {
          ...base,
          outcome: 'advisory_unverified',
          advisory_reason: 'shape_gate',
          detail: p.detail,
        };
      case 'exec_error':
        return {
          ...base,
          outcome: 'advisory_unverified',
          advisory_reason: 'exec_error',
          detail: p.detail,
        };
    }
  }

  const r = runAbsenceCheck(input.claim.pattern, input.claim.scope_path, repoRoot, opts);
  switch (r.kind) {
    case 'confirmed_absent':
      return { ...base, outcome: 'confirmed', exit_code: r.exit_code };
    case 'refuted_present':
      return { ...base, outcome: 'refuted', exit_code: r.exit_code };
    case 'shape_rejected':
      return {
        ...base,
        outcome: 'advisory_unverified',
        advisory_reason: 'shape_gate',
        detail: r.detail,
      };
    case 'exec_error':
      return {
        ...base,
        outcome: 'advisory_unverified',
        advisory_reason: 'exec_error',
        ...(r.exit_code !== undefined ? { exit_code: r.exit_code } : {}),
        ...(r.detail !== undefined ? { detail: r.detail } : {}),
      };
    case 'tool_absent':
      return {
        ...base,
        outcome: 'advisory_unverified',
        advisory_reason: 'tool_absent',
        ...(r.detail !== undefined ? { detail: r.detail } : {}),
      };
  }
}
