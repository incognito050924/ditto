import { defineCommand } from 'citty';

import {
  decideCompletionAuthority,
  type CompletionAuthorityInput,
} from '../../verify/completion-authority';
import {
  checkRedFirst,
  type CompletionTestRecord,
  type RedFirstInput,
} from '../../verify/red-first';
import {
  checkStructuralAnchor,
  observedStructure,
  structuralExpectation,
  type ObservedStructure,
  type StructuralExpectation,
} from '../../verify/structural-anchor';
import { codexCrossCheck, liveCodexDeps } from '../../verify/codex';
import { RUNTIME_ERROR_EXIT, USAGE_ERROR_EXIT, parseOutputFormat, writeError, writeHuman, writeJson } from '../util';

/**
 * `ditto verify` (rebuild host surface) — a thin front over the REBUILT verify
 * engine, which is a set of INDEPENDENT decision functions (not an orchestrator).
 * Each verb maps plain CLI inputs onto one decision and renders its verdict:
 *  - completion-authority : decideCompletionAuthority (test-green AND external codex "verified")
 *  - red-first            : checkRedFirst             (red-before-green earned honestly)
 *  - structural-anchor    : checkStructuralAnchor     (change shape matches locked AC structure)
 *  - codex-crosscheck     : codexCrossCheck           (independent maker≠checker verdict)
 *
 * The old `verify` command ran a user command after `--` and wrote a verdict via
 * the record store. That orchestrator is DELIBERATELY not rebuilt here: the
 * rebuilt engine exposes pure decisions, and `recordVerdict` needs a known
 * acceptance criterion plus Verdict/Evidence objects — a real record mutation,
 * not a clean CLI-flag composition. The two codex-backed verbs degrade
 * gracefully when the optional `codex` CLI is absent (ADR-0018): the cross-check
 * returns `unverified`/`codexAvailable:false` and never throws, so the flow is
 * never broken by tool absence — it fail-closes the completion instead.
 */

/** Parse an integer flag; throws a usage-shaped Error on a non-integer. */
function parseIntFlag(name: string, value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error(`${name} must be an integer; got "${value}"`);
  return n;
}

/** Parse "<int>" or "null" into number|null; throws on anything else. */
function parseIntOrNull(name: string, value: string): number | null {
  if (value === 'null') return null;
  return parseIntFlag(name, value);
}

/**
 * `ditto verify completion-authority` — the external completion authority. A
 * completion may be declared only when BOTH facets hold: a real-test fail-closed
 * green (--test-exit-code 0) AND an independent codex "verified" verdict over the
 * claim/evidence. Any other codex outcome (absent, ambiguous, refuted, non-zero)
 * WITHHOLDS completion. Exits non-zero when completion is withheld.
 */
const completionAuthorityCommand = defineCommand({
  meta: {
    name: 'completion-authority',
    description:
      'Declare completion only when tests are green AND an independent codex cross-check verifies the claim. Withholds (non-zero) otherwise. codex absent → withheld (fail-closed).',
  },
  args: {
    'test-exit-code': { type: 'string', description: 'Exit code of the real test run (0 = green)', required: true },
    claim: { type: 'string', description: 'The claim to independently cross-check (maker-supplied, untrusted)', required: true },
    evidence: { type: 'string', description: 'The evidence the checker reads (maker-supplied, untrusted)', required: true },
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: ({ args }) => {
    let format: ReturnType<typeof parseOutputFormat>;
    try {
      format = parseOutputFormat(args.output);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
    }
    let testExitCode: number;
    try {
      testExitCode = parseIntFlag('--test-exit-code', args['test-exit-code']);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
    }
    const input: CompletionAuthorityInput = {
      testExitCode,
      claim: args.claim,
      evidence: args.evidence,
    };
    const decision = decideCompletionAuthority(input, liveCodexDeps);
    if (format === 'json') {
      writeJson(decision);
    } else {
      writeHuman(`completion-authority: ${decision.complete ? 'COMPLETE' : 'WITHHELD'}`);
      writeHuman(`  test:       ${decision.testGreen ? 'green' : 'red'}`);
      writeHuman(`  crosscheck: ${decision.crossCheck}${decision.codexAvailable ? '' : ' (codex absent)'}`);
      for (const r of decision.reasons) writeHuman(`  - ${r}`);
    }
    if (!decision.complete) process.exit(RUNTIME_ERROR_EXIT);
  },
});

/**
 * `ditto verify red-first` — proves a completion round earned its green: the
 * completion test was authored externally (not self-authored), observed RED
 * before green, and the frozen red test survived intact (content hash unchanged).
 * Pure/fail-closed. Exits non-zero when the round is rejected.
 */
const redFirstCommand = defineCommand({
  meta: {
    name: 'red-first',
    description:
      'Prove a completion round earned green honestly: external-authored test, observed red-before-green, frozen test intact (hash match). Rejects (non-zero) on any doubt.',
  },
  args: {
    author: { type: 'string', description: 'Completion-test author: external|loop', required: true },
    'red-exit-code': { type: 'string', description: 'Exit code of the FIRST (pre-impl) run, or "null" if none. Non-zero = real red.', required: true },
    'green-exit-code': { type: 'string', description: 'Exit code of the post-impl run, or "null". 0 = green.', required: true },
    'captured-hash': { type: 'string', description: 'SHA-256 of the frozen test taken at capture', required: true },
    'current-content': { type: 'string', description: 'Current on-disk content of the frozen test (omit = deleted)', required: false },
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: ({ args }) => {
    let format: ReturnType<typeof parseOutputFormat>;
    try {
      format = parseOutputFormat(args.output);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
    }
    if (args.author !== 'external' && args.author !== 'loop') {
      writeError(`--author must be external|loop; got "${args.author}"`);
      process.exit(USAGE_ERROR_EXIT);
    }
    let redRunExitCode: number | null;
    let greenRunExitCode: number | null;
    try {
      redRunExitCode = parseIntOrNull('--red-exit-code', args['red-exit-code']);
      greenRunExitCode = parseIntOrNull('--green-exit-code', args['green-exit-code']);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
    }
    const test: CompletionTestRecord = {
      author: args.author,
      redRunExitCode,
      greenRunExitCode,
    };
    const input: RedFirstInput = {
      test,
      frozen: {
        capturedHash: args['captured-hash'],
        currentContent: args['current-content'] ?? null,
      },
    };
    const decision = checkRedFirst(input);
    if (format === 'json') {
      writeJson(decision);
    } else {
      writeHuman(`red-first: ${decision.accepted ? 'ACCEPTED' : 'REJECTED'}`);
      for (const r of decision.reasons) writeHuman(`  - ${r}`);
    }
    if (!decision.accepted) process.exit(RUNTIME_ERROR_EXIT);
  },
});

/**
 * `ditto verify structural-anchor` — an independent check that a change's SHAPE
 * matches the locked acceptance-criteria structure (separate from a test pass: a
 * green test on the wrong structure is still caught). Both sides are JSON arrays
 * validated against the engine's schemas. Exits non-zero on a mismatch or when
 * there is nothing to check (unverified, fail-closed).
 */
const structuralAnchorCommand = defineCommand({
  meta: {
    name: 'structural-anchor',
    description:
      'Check that the change shape matches the locked AC structure. Blocks (non-zero) on a mismatch or when there are no locked expectations (unverified).',
  },
  args: {
    'expected-json': {
      type: 'string',
      description: 'JSON array of locked expectations: [{criterion_id,kind:file|symbol|shape,target}]',
      required: true,
    },
    'observed-json': {
      type: 'string',
      description: 'JSON array of observed artifacts: [{kind:file|symbol|shape,target}]',
      required: true,
    },
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: ({ args }) => {
    let format: ReturnType<typeof parseOutputFormat>;
    try {
      format = parseOutputFormat(args.output);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
    }
    let expected: StructuralExpectation[];
    let observed: ObservedStructure[];
    try {
      expected = structuralExpectation.array().parse(JSON.parse(args['expected-json']));
    } catch (err) {
      writeError(`--expected-json invalid: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(USAGE_ERROR_EXIT);
    }
    try {
      observed = observedStructure.array().parse(JSON.parse(args['observed-json']));
    } catch (err) {
      writeError(`--observed-json invalid: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(USAGE_ERROR_EXIT);
    }
    const result = checkStructuralAnchor(expected, observed);
    if (format === 'json') {
      writeJson(result);
    } else {
      writeHuman(`structural-anchor: ${result.status.toUpperCase()}`);
      for (const r of result.reasons) writeHuman(`  - ${r}`);
    }
    if (result.status !== 'matched') process.exit(RUNTIME_ERROR_EXIT);
  },
});

/**
 * `ditto verify codex-crosscheck` — the raw independent maker≠checker cross-check
 * over a claim/evidence pair, calling the external `codex` CLI directly. Graceful
 * degradation (ADR-0018): codex absent → `unverified`/`codexAvailable:false`, no
 * throw. Exits non-zero unless the verdict is an explicit `verified`.
 */
const codexCrosscheckCommand = defineCommand({
  meta: {
    name: 'codex-crosscheck',
    description:
      'Independent codex cross-check of a claim against its evidence (maker≠checker). Only an explicit "verified" passes; codex absent/refuted/ambiguous → non-zero (fail-closed).',
  },
  args: {
    claim: { type: 'string', description: 'The claim to cross-check', required: true },
    evidence: { type: 'string', description: 'The evidence the checker reads', required: true },
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: ({ args }) => {
    let format: ReturnType<typeof parseOutputFormat>;
    try {
      format = parseOutputFormat(args.output);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
    }
    const result = codexCrossCheck({ claim: args.claim, evidence: args.evidence }, liveCodexDeps);
    if (format === 'json') {
      writeJson(result);
    } else {
      writeHuman(`codex-crosscheck: ${result.outcome.toUpperCase()}${result.codexAvailable ? '' : ' (codex absent)'}`);
      writeHuman(`  ${result.detail}`);
    }
    if (result.outcome !== 'verified') process.exit(RUNTIME_ERROR_EXIT);
  },
});

export const verifyCommand = defineCommand({
  meta: {
    name: 'verify',
    description:
      'Rebuilt verify decisions — completion authority (completion-authority), red-before-green (red-first), structural anchor (structural-anchor), codex cross-check (codex-crosscheck)',
  },
  subCommands: {
    'completion-authority': completionAuthorityCommand,
    'red-first': redFirstCommand,
    'structural-anchor': structuralAnchorCommand,
    'codex-crosscheck': codexCrosscheckCommand,
  },
});
