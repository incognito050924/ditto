import { defineCommand } from 'citty';
import { PLACEHOLDER_AC_STATEMENT } from '~/core/charter';
import { CompletionStore, assembleCompletionFromWorkItem } from '~/core/completion-store';
import { resolveRepoRootForCreate } from '~/core/fs';
import { acceptanceTestable, completionEvidenceGate, completionGate } from '~/core/gates';
import { IntentStore } from '~/core/intent-store';
import {
  InvalidBaseRefError,
  InvalidHeadRefError,
  writeWorkItemHandoff,
} from '~/core/work-item-handoff';
import { WorkItemStore } from '~/core/work-item-store';
import { declarerRole } from '~/schemas/common';
import type { AcceptanceCriterion, WorkItem } from '~/schemas/work-item';
import {
  RUNTIME_ERROR_EXIT,
  USAGE_ERROR_EXIT,
  parseOutputFormat,
  writeError,
  writeHuman,
  writeJson,
} from '../util';

/**
 * Parse a `--criteria` string into per-AC statements: split on `;`, trim, drop
 * empties. Shared by `work start --criteria` and `work set-criteria` so both
 * surfaces build acceptance criteria the same way.
 */
function parseCriteriaStatements(raw: string): string[] {
  return raw
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ac-3: the work item's declared risk axis. Same vocabulary as gates.ts RiskAxes
// (non_local/irreversible/unaudited); shared by `work start --risk` and
// `work set-criteria --risk`.
const RISK_FLAGS = ['non_local', 'irreversible', 'unaudited'] as const;

/**
 * Parse a `--risk "non_local,irreversible"` string into `declared_risk` flags.
 * Comma-separated; each token must be a known risk flag (an unknown token is
 * reported so a typo is not silently dropped). `risk` is undefined when no flag
 * was set (so an empty `--risk ""` records nothing).
 */
function parseRiskFlags(raw: string): { risk?: WorkItem['declared_risk']; unknown: string[] } {
  const tokens = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const unknown: string[] = [];
  const risk: Record<string, boolean> = {};
  for (const t of tokens) {
    if ((RISK_FLAGS as readonly string[]).includes(t)) risk[t] = true;
    else unknown.push(t);
  }
  return { risk: Object.keys(risk).length > 0 ? risk : undefined, unknown };
}

/** True iff any declared_risk flag is set on the work item. */
function hasDeclaredRisk(item: WorkItem): boolean {
  const r = item.declared_risk;
  return !!r && (r.non_local === true || r.irreversible === true || r.unaudited === true);
}

/**
 * Observability gate: reuse the deterministic `acceptanceTestable` (gates.ts) on
 * each statement so the setter rejects a vague term or a statement with no
 * observable predicate. Returns a per-statement rejection message for every
 * statement that fails; empty when all are testable. Callers reject the WHOLE
 * batch on any failure (no partial write).
 */
function rejectNonObservableCriteria(statements: string[]): string[] {
  const errors: string[] = [];
  statements.forEach((statement, i) => {
    const result = acceptanceTestable({ statement });
    if (!result.pass) errors.push(`ac-${i + 1} "${statement}": ${result.reasons.join('; ')}`);
  });
  return errors;
}

interface SupersededRecord {
  statement: string;
  reason: string;
}

/**
 * Provenance records for the new criterion at `index`: the prior criterion's
 * existing supersession history, plus its statement when it was graded
 * (non-`unverified`) — replacing a graded statement is what we must not lose. The
 * LAST new criterion also absorbs the provenance of any graded prior criteria
 * beyond the new count, so a dropped graded statement is never silently lost.
 */
function supersededRecordsFor(
  prior: readonly AcceptanceCriterion[],
  index: number,
  newCount: number,
  reason: string,
): SupersededRecord[] {
  const records: SupersededRecord[] = [];
  const old = prior[index];
  if (old) {
    records.push(...(old.superseded ?? []));
    if (old.verdict !== 'unverified') records.push({ statement: old.statement, reason });
  }
  if (index === newCount - 1) {
    for (const c of prior.slice(newCount)) {
      if (c.verdict !== 'unverified') records.push({ statement: c.statement, reason });
    }
  }
  return records;
}

/**
 * Build fresh (`unverified`) acceptance criteria from the statements. When
 * `reason` is defined (an explicit `--supersede`), prior graded statements are
 * preserved in each new criterion's `superseded` provenance; when undefined
 * (plain replace, no graded criteria locked), criteria carry no provenance.
 */
function buildCriteria(
  statements: string[],
  prior: readonly AcceptanceCriterion[],
  reason: string | undefined,
) {
  const newCount = statements.length;
  return statements.map((statement, i) => {
    const records = reason === undefined ? [] : supersededRecordsFor(prior, i, newCount, reason);
    return {
      id: `ac-${i + 1}`,
      statement,
      verdict: 'unverified' as const,
      evidence: [],
      ...(records.length > 0 ? { superseded: records } : {}),
    };
  });
}

const workStart = defineCommand({
  meta: {
    name: 'start',
    description: 'Create a new work item from a request and initial goal',
  },
  args: {
    goal: {
      type: 'positional',
      description: 'Observable outcome stated in project terms',
      required: true,
    },
    request: {
      type: 'string',
      description: 'Verbatim user request that produced this work item',
      required: true,
    },
    title: {
      type: 'string',
      description: 'Short title; defaults to goal truncated',
      required: false,
    },
    criteria: {
      type: 'string',
      description:
        'Real observable acceptance criteria, semicolon-separated — set at creation instead of the placeholder',
      required: false,
    },
    risk: {
      type: 'string',
      description:
        'Declared risk flags, comma-separated: non_local,irreversible,unaudited (drives the heavy-path nudge + lightweight-close override gate)',
      required: false,
    },
    profile: {
      type: 'string',
      description: 'Owner profile: read-only|workspace-write|networked|reviewer|isolated',
      default: 'workspace-write',
    },
    output: {
      type: 'string',
      description: 'Output format: human|json',
      default: 'human',
    },
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
    const store = new WorkItemStore(repoRoot);
    const profile = args.profile as
      | 'read-only'
      | 'workspace-write'
      | 'networked'
      | 'reviewer'
      | 'isolated';
    const title = args.title ?? args.goal.slice(0, 80);
    const realStatements = args.criteria ? parseCriteriaStatements(args.criteria) : [];
    if (realStatements.length > 0) {
      const errors = rejectNonObservableCriteria(realStatements);
      if (errors.length > 0) {
        writeError(`--criteria rejected (not observable/testable): ${errors.join('; ')}`);
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
    }
    let declared_risk: WorkItem['declared_risk'];
    if (args.risk !== undefined) {
      const parsed = parseRiskFlags(args.risk);
      if (parsed.unknown.length > 0) {
        writeError(
          `--risk has unknown flag(s) ${parsed.unknown.join(', ')}; allowed: ${RISK_FLAGS.join(', ')}`,
        );
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
      declared_risk = parsed.risk;
    }
    const acceptance_criteria =
      realStatements.length > 0
        ? realStatements.map((statement, i) => ({
            id: `ac-${i + 1}`,
            statement,
            verdict: 'unverified' as const,
            evidence: [],
          }))
        : [
            {
              id: 'ac-1',
              // Single source of truth (V1): the placeholder detector in
              // user-prompt-submit matches this exact string to fire the
              // deep-interview directive, so the CLI must emit the same constant
              // rather than a hand-written sibling that silently bypasses it.
              statement: PLACEHOLDER_AC_STATEMENT,
              verdict: 'unverified' as const,
              evidence: [],
            },
          ];
    try {
      const created = await store.create({
        title,
        source_request: args.request,
        goal: args.goal,
        owner_profile: profile,
        acceptance_criteria,
        ...(declared_risk !== undefined ? { declared_risk } : {}),
      });
      if (format === 'json') {
        writeJson({
          work_item_id: created.id,
          path: `.ditto/local/work-items/${created.id}/work-item.json`,
          status: created.status,
          repo_root: repoRoot,
        });
      } else {
        writeHuman(`Created work item ${created.id}`);
        writeHuman(`  goal: ${created.goal}`);
        writeHuman(`  status: ${created.status}`);
        writeHuman(`  path: ${repoRoot}/.ditto/local/work-items/${created.id}/work-item.json`);
        writeHuman('Next steps:');
        writeHuman(
          '  1. /ditto:deep-interview (or: ditto deep-interview start → record-turn → check-readiness → finalize) — writes intent.json',
        );
        writeHuman(
          `  2. ditto autopilot bootstrap --workItem ${created.id} (requires intent.json from finalize)`,
        );
      }
    } catch (err) {
      writeError(`work start failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

const workSetCriteria = defineCommand({
  meta: {
    name: 'set-criteria',
    description:
      'Replace placeholder acceptance criteria with real, observable criteria (semicolon-separated)',
  },
  args: {
    workId: {
      type: 'positional',
      description: 'Work item id to set acceptance criteria on',
      required: true,
    },
    criteria: {
      type: 'string',
      description:
        'Observable criteria, semicolon-separated — one acceptance criterion (ac-1, ac-2, …) each',
      required: true,
    },
    supersede: {
      type: 'boolean',
      description:
        'Override the lock on already-graded criteria. Requires --reason; prior statements are preserved as provenance.',
      default: false,
    },
    reason: {
      type: 'string',
      description: 'Why the graded criteria are being replaced (required with --supersede)',
      required: false,
    },
    risk: {
      type: 'string',
      description:
        'Declared risk flags, comma-separated: non_local,irreversible,unaudited (recorded on the work item)',
      required: false,
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
    const supersede = args.supersede === true;
    if (supersede && !args.reason) {
      writeError('--supersede requires --reason "<why the graded criteria are being replaced>"');
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const statements = parseCriteriaStatements(args.criteria);
    if (statements.length === 0) {
      writeError('--criteria must contain at least one non-empty statement (semicolon-separated)');
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const observabilityErrors = rejectNonObservableCriteria(statements);
    if (observabilityErrors.length > 0) {
      writeError(
        `--criteria rejected (not observable/testable): ${observabilityErrors.join('; ')}`,
      );
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    let declared_risk: WorkItem['declared_risk'];
    if (args.risk !== undefined) {
      const parsed = parseRiskFlags(args.risk);
      if (parsed.unknown.length > 0) {
        writeError(
          `--risk has unknown flag(s) ${parsed.unknown.join(', ')}; allowed: ${RISK_FLAGS.join(', ')}`,
        );
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
      declared_risk = parsed.risk;
    }
    const repoRoot = await resolveRepoRootForCreate();
    const store = new WorkItemStore(repoRoot);
    try {
      const current = await store.get(args.workId);
      // Lock-with-provenance (charter §4-6): a criterion that already carries a
      // verdict must not be silently overwritten (goalpost-moving). Block by
      // default; require explicit --supersede --reason to override.
      const graded = current.acceptance_criteria.filter((c) => c.verdict !== 'unverified');
      if (graded.length > 0 && !supersede) {
        writeError(
          `work ${args.workId} has graded criteria (${graded
            .map((c) => `${c.id}=${c.verdict}`)
            .join(
              ', ',
            )}); set-criteria would overwrite verified results. Re-run with --supersede --reason "<why>" to override (prior statements are preserved as provenance).`,
        );
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
      const nextCriteria = buildCriteria(
        statements,
        current.acceptance_criteria,
        supersede ? (args.reason as string) : undefined,
      );
      const updated = await store.update(args.workId, (cur) => ({
        ...cur,
        acceptance_criteria: nextCriteria,
        ...(declared_risk !== undefined ? { declared_risk } : {}),
      }));
      if (format === 'json') {
        writeJson({
          work_item_id: updated.id,
          acceptance_criteria: updated.acceptance_criteria.map((c) => ({
            id: c.id,
            statement: c.statement,
          })),
        });
      } else {
        writeHuman(
          `Set ${updated.acceptance_criteria.length} acceptance criteria on ${updated.id}:`,
        );
        for (const c of updated.acceptance_criteria) writeHuman(`  ${c.id}: ${c.statement}`);
      }
    } catch (err) {
      writeError(`work set-criteria failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(USAGE_ERROR_EXIT);
    }
  },
});

const workStatus = defineCommand({
  meta: {
    name: 'status',
    description: 'Show current state of one or all work items',
  },
  args: {
    workId: {
      type: 'positional',
      description: 'Work item id; if omitted, lists all work items',
      required: false,
    },
    output: {
      type: 'string',
      description: 'Output format: human|json',
      default: 'human',
    },
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
    let repoRoot: string;
    try {
      repoRoot = await resolveRepoRootForCreate();
    } catch (err) {
      writeError(`cannot find repo root: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const store = new WorkItemStore(repoRoot);
    if (!args.workId) {
      const list = await store.list();
      if (format === 'json') {
        writeJson({ items: list });
      } else if (list.length === 0) {
        writeHuman('No work items.');
      } else {
        for (const s of list) {
          writeHuman(`${s.id}\t${s.status}\t${s.updated_at}\t${s.title}`);
        }
      }
      return;
    }
    try {
      const item = await store.get(args.workId);
      if (format === 'json') {
        writeJson(item);
      } else {
        writeHuman(`id:     ${item.id}`);
        writeHuman(`title:  ${item.title}`);
        writeHuman(`status: ${item.status}`);
        writeHuman(`goal:   ${item.goal}`);
        writeHuman(`updated_at: ${item.updated_at}`);
        writeHuman('acceptance:');
        for (const ac of item.acceptance_criteria) {
          writeHuman(`  - ${ac.id} [${ac.verdict}] ${ac.statement}`);
        }
      }
    } catch (err) {
      writeError(`work status failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(USAGE_ERROR_EXIT);
    }
  },
});

const workHandoff = defineCommand({
  meta: {
    name: 'handoff',
    description: 'Generate or refresh the handoff document for a work item',
  },
  args: {
    workId: {
      type: 'positional',
      description: 'Work item id to hand off',
      required: true,
    },
    base: {
      type: 'string',
      description:
        'Git ref to diff against when collecting changed_files. Default tries started_at_sha, origin/main, origin/master, main, master.',
      required: false,
    },
    head: {
      type: 'string',
      description:
        'Git ref to diff up to when collecting changed_files. Default HEAD. Useful for correcting past handoffs (base...head frozen range).',
      required: false,
    },
    'declared-by': {
      type: 'string',
      description:
        'Agent role that declares this completion (who judged): main|planner|implementer|verifier|reviewer|researcher|synthesizer. Default main.',
      default: 'main',
    },
    output: {
      type: 'string',
      description: 'Output format: human|json',
      default: 'human',
    },
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
    const declaredBy = declarerRole.safeParse(args['declared-by']);
    if (!declaredBy.success) {
      writeError(
        `--declared-by must be one of ${declarerRole.options.join('|')}; got "${args['declared-by']}"`,
      );
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const repoRoot = await resolveRepoRootForCreate();
    const store = new WorkItemStore(repoRoot);
    try {
      let result: Awaited<ReturnType<typeof writeWorkItemHandoff>>;
      try {
        result = await writeWorkItemHandoff(repoRoot, store, args.workId, {
          ...(args.base ? { base: args.base } : {}),
          ...(args.head ? { head: args.head } : {}),
          declaredBy: declaredBy.data,
        });
      } catch (err) {
        if (err instanceof InvalidBaseRefError || err instanceof InvalidHeadRefError) {
          writeError(err.message);
          process.exit(USAGE_ERROR_EXIT);
          return;
        }
        throw err;
      }
      if (format === 'json') {
        writeJson({
          work_item_id: args.workId,
          final_verdict: result.completion.final_verdict,
          handoff_path: result.handoffPath,
          completion_path: result.completionPath,
          base_used: result.baseUsed,
          changed_files: result.collectedChangedFiles,
        });
      } else {
        writeHuman(`Handoff for ${args.workId}`);
        writeHuman(`  final_verdict:  ${result.completion.final_verdict}`);
        writeHuman(`  base_used:      ${result.baseUsed ?? '(none)'}`);
        writeHuman(`  changed_files:  ${result.collectedChangedFiles.length}`);
        writeHuman(`  handoff:        ${result.handoffPath}`);
        writeHuman(`  completion.json: ${result.completionPath}`);
      }
    } catch (err) {
      writeError(`work handoff failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(USAGE_ERROR_EXIT);
    }
  },
});

const TERMINAL_STATUSES = ['done', 'abandoned'] as const;

const workAbandon = defineCommand({
  meta: {
    name: 'abandon',
    description: 'Close a work item as abandoned (give up; no evidence required)',
  },
  args: {
    workId: { type: 'positional', description: 'Work item id to abandon', required: true },
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
    const store = new WorkItemStore(repoRoot);
    try {
      const cur = await store.get(args.workId);
      if (cur.status === 'done' || cur.status === 'abandoned') {
        writeError(`work ${args.workId} is already terminal (status=${cur.status})`);
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
      const closed = await store.close(args.workId, 'abandoned');
      if (format === 'json') {
        writeJson({ id: closed.id, status: closed.status, closed_at: closed.closed_at });
      } else {
        writeHuman(
          `Abandoned ${closed.id} (was ${cur.status}). Archive with: ditto work archive <label>`,
        );
      }
    } catch (err) {
      writeError(`work abandon failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(USAGE_ERROR_EXIT);
    }
  },
});

const PARK_STATUSES = ['partial', 'blocked'] as const;

const workDone = defineCommand({
  meta: {
    name: 'done',
    description:
      'Close a work item: done (completion final_verdict=pass evidence gate), or --status partial|blocked to park it as resumable with re_entry',
  },
  args: {
    workId: { type: 'positional', description: 'Work item id to mark done', required: true },
    status: {
      type: 'string',
      description:
        'Park as a resumable status instead of done: partial|blocked. Requires --re-entry-command or --needs (re_entry is mandatory for these statuses).',
      required: false,
    },
    're-entry-command': {
      type: 'string',
      description: 'Concrete command to resume work, recorded in re_entry.command (with --status)',
      required: false,
    },
    needs: {
      type: 'string',
      description:
        'Semicolon-separated evidence still needed before resuming → re_entry.fresh_evidence_needed (with --status)',
      required: false,
    },
    'override-heavy': {
      type: 'boolean',
      description:
        'Allow the lightweight close on a declared-risk WI without going through the heavy (deep-interview) path. Requires --reason; the reason is recorded as an auditable risk note.',
      default: false,
    },
    reason: {
      type: 'string',
      description:
        'Why a lightweight close is acceptable for a declared-risk WI (with --override-heavy)',
      required: false,
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
    const store = new WorkItemStore(repoRoot);
    const completions = new CompletionStore(repoRoot);

    // Park path (ac-2 B): close as a resumable partial/blocked status instead of
    // done. Distinct from the evidence-gated pass close below — a partially-done
    // WI that cannot be verified is parked, not forced into a false done/abandon.
    if (args.status !== undefined) {
      if (!(PARK_STATUSES as readonly string[]).includes(args.status)) {
        writeError(
          `--status must be one of ${PARK_STATUSES.join('|')} (to park a resumable WI); got "${args.status}". Omit --status to close as done.`,
        );
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
      const command = args['re-entry-command'];
      const needs = args.needs ? parseCriteriaStatements(args.needs) : [];
      if (!command && needs.length === 0) {
        writeError(
          `--status ${args.status} requires re_entry: pass --re-entry-command "<resume cmd>" and/or --needs "<evidence; …>".`,
        );
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
      try {
        const parked = await store.park(args.workId, args.status as 'partial' | 'blocked', {
          ...(command ? { command } : {}),
          fresh_evidence_needed: needs,
        });
        if (format === 'json') {
          writeJson({ id: parked.id, status: parked.status, re_entry: parked.re_entry });
        } else {
          writeHuman(`Parked ${parked.id} as ${parked.status} (resumable).`);
          if (parked.re_entry?.command) writeHuman(`  resume: ${parked.re_entry.command}`);
          if ((parked.re_entry?.fresh_evidence_needed ?? []).length > 0)
            writeHuman(`  needs:  ${parked.re_entry?.fresh_evidence_needed.join(', ')}`);
        }
      } catch (err) {
        writeError(
          `work done --status failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(USAGE_ERROR_EXIT);
      }
      return;
    }
    try {
      const item = await store.get(args.workId); // throws with a clear error if unknown
      // Evidence gate: done requires a completion contract with final_verdict=pass.
      // If none exists — a work item fixed directly, outside the autopilot pipeline
      // (wi_2606200ec) — synthesize one from the work item's OWN acceptance
      // verdicts/evidence (populated by `ditto verify`) through the SAME
      // buildCompletion + completionGate + completionEvidenceGate the autopilot path
      // uses. One evidence gate, no weaker parallel path; no intent.json/graph needed.
      if (!(await completions.exists(args.workId))) {
        const placeholders = item.acceptance_criteria.filter(
          (c) => c.statement === PLACEHOLDER_AC_STATEMENT,
        );
        if (placeholders.length > 0) {
          writeError(
            `work ${args.workId} still has placeholder acceptance criteria (${placeholders
              .map((c) => c.id)
              .join(
                ', ',
              )}) — lock real criteria via /ditto:deep-interview, or \`ditto work abandon\` to give up`,
          );
          process.exit(USAGE_ERROR_EXIT);
          return;
        }
        // ac-3 C: a declared-risk WI must not close silently on the lightweight
        // synthesis path (no intent.json = the heavy review never ran). Block
        // unless an explicit, recorded override is given. A WI that went heavy
        // (intent.json present) is unaffected — its review already happened.
        if (hasDeclaredRisk(item) && !(await new IntentStore(repoRoot).exists(args.workId))) {
          const overrideHeavy = args['override-heavy'] === true;
          if (!overrideHeavy) {
            writeError(
              `work ${args.workId} declares risk (${RISK_FLAGS.filter(
                (f) => item.declared_risk?.[f] === true,
              ).join(
                ', ',
              )}) but has no intent.json — the lightweight close skips the heavy review. Run /ditto:deep-interview (or \`ditto work promote ${args.workId}\`), or override with \`ditto work done ${args.workId} --override-heavy --reason "<why light is acceptable>"\`.`,
            );
            process.exit(USAGE_ERROR_EXIT);
            return;
          }
          if (!args.reason) {
            writeError(
              '--override-heavy requires --reason "<why a lightweight close is acceptable for this declared-risk WI>"',
            );
            process.exit(USAGE_ERROR_EXIT);
            return;
          }
          // Persist the override as an auditable risk note (not just printed).
          await store.update(args.workId, (cur) => ({
            ...cur,
            risks: [
              ...cur.risks,
              {
                description: `lightweight-close override (declared_risk present): ${args.reason}`,
                severity: 'medium' as const,
              },
            ],
          }));
        }
        const synthesized = assembleCompletionFromWorkItem(item, {
          declaredBy: 'main',
          summary: `Closed via lightweight completion path (ditto verify evidence) for ${args.workId}.`,
        });
        const gateReasons = [
          ...completionGate(item, synthesized).reasons,
          ...completionEvidenceGate(synthesized).reasons,
        ];
        if (synthesized.final_verdict !== 'pass' || gateReasons.length > 0) {
          const notPass = synthesized.acceptance
            .filter((a) => a.verdict !== 'pass')
            .map((a) => a.criterion_id);
          const detail =
            gateReasons.length > 0
              ? gateReasons.join('; ')
              : `not-pass criteria: ${notPass.join(', ')}`;
          writeError(
            `work ${args.workId} cannot close: ${detail}. Verify each criterion with \`ditto verify ${args.workId} --criterion <ac> -- <command>\`, or \`ditto work abandon\`.`,
          );
          process.exit(USAGE_ERROR_EXIT);
          return;
        }
        await completions.write(synthesized);
      }
      const completion = await completions.get(args.workId);
      if (completion.final_verdict !== 'pass') {
        writeError(
          `work ${args.workId} completion final_verdict=${completion.final_verdict} (not pass) — cannot mark done`,
        );
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
      const closed = await store.close(args.workId, 'done');
      if (format === 'json') {
        writeJson({ id: closed.id, status: closed.status, closed_at: closed.closed_at });
      } else {
        writeHuman(
          `Done ${closed.id} (completion final_verdict=pass). Archive with: ditto work archive <label>`,
        );
      }
    } catch (err) {
      writeError(`work done failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(USAGE_ERROR_EXIT);
    }
  },
});

const workPromote = defineCommand({
  meta: {
    name: 'promote',
    description:
      'Upgrade a lightweight work item to the heavy (deep-interview) path IN PLACE — preserves the existing criteria, verdicts, evidence, and the WI id (no abandon+recreate)',
  },
  args: {
    workId: { type: 'positional', description: 'Work item id to promote', required: true },
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
    const store = new WorkItemStore(repoRoot);
    try {
      // In-place: set the heavy-path marker only. acceptance_criteria, verdicts,
      // evidence, and the id are left untouched (no reset to placeholder), so a WI
      // that already has real criteria carries them into the heavy path with no
      // data loss. The marker keeps the risk-driven heavy nudge firing.
      const promoted = await store.update(args.workId, (cur) => ({
        ...cur,
        promoted_to_heavy: true,
      }));
      if (format === 'json') {
        writeJson({
          work_item_id: promoted.id,
          promoted_to_heavy: promoted.promoted_to_heavy === true,
          acceptance_criteria: promoted.acceptance_criteria.map((c) => c.id),
        });
      } else {
        writeHuman(`Promoted ${promoted.id} to the heavy path (criteria + id preserved).`);
        writeHuman('Next: /ditto:deep-interview to deepen the existing criteria.');
      }
    } catch (err) {
      writeError(`work promote failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(USAGE_ERROR_EXIT);
    }
  },
});

const workArchive = defineCommand({
  meta: {
    name: 'archive',
    description:
      'Move terminal (done/abandoned) work items to .ditto/local/archive/<label> (ADR-0005 D3)',
  },
  args: {
    label: {
      type: 'positional',
      description: 'Archive label / batch name (e.g. 2026-Q2). [A-Za-z0-9._-]+',
      required: true,
    },
    'dry-run': {
      type: 'boolean',
      description: 'List what would move without moving',
      default: false,
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
    const store = new WorkItemStore(repoRoot);
    try {
      if (args['dry-run']) {
        const candidates = (await store.list()).filter((s) =>
          (TERMINAL_STATUSES as readonly string[]).includes(s.status),
        );
        if (format === 'json') {
          writeJson({
            dry_run: true,
            label: args.label,
            would_archive: candidates.map((c) => c.id),
          });
        } else {
          writeHuman(`dry-run: ${candidates.length} item(s) would move to archive/${args.label}:`);
          for (const c of candidates) writeHuman(`  ${c.id}\t${c.status}\t${c.title}`);
        }
        return;
      }
      const moved = await store.archive(args.label);
      if (format === 'json') {
        writeJson({ label: args.label, archived: moved });
      } else {
        writeHuman(`Archived ${moved.length} item(s) to .ditto/local/archive/${args.label}.`);
        for (const id of moved) writeHuman(`  ${id}`);
      }
    } catch (err) {
      writeError(`work archive failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(USAGE_ERROR_EXIT);
    }
  },
});

export const workCommand = defineCommand({
  meta: {
    name: 'work',
    description: 'Manage work items (start, status, handoff, done, abandon, promote, archive)',
  },
  subCommands: {
    start: workStart,
    'set-criteria': workSetCriteria,
    status: workStatus,
    handoff: workHandoff,
    done: workDone,
    abandon: workAbandon,
    promote: workPromote,
    archive: workArchive,
  },
});
