import { defineCommand } from 'citty';

import {
  type ArchitectureObservation,
  type ArchitectureSpec,
  type ForbiddenDependency,
  architectureSpec,
  buildCandidateSpec,
  evaluateConformance,
  fitnessFunction,
  ratifyCandidateSpec,
} from '../../acg';
import { type AnalysisResult, analysisResult } from '../../analysis';
import { RUNTIME_ERROR_EXIT, USAGE_ERROR_EXIT, parseOutputFormat, writeError, writeHuman, writeJson } from '../util';

/**
 * `ditto acg` (rebuild host surface) — a thin front over the REBUILT ACG
 * (architecture-conformance / governance) engine. It exposes exactly the verbs
 * the rebuild backs today with plain, host-free inputs:
 *
 *  - propose     : buildCandidateSpec   (observe → NON-authoritative candidate spec)
 *  - ratify      : ratifyCandidateSpec  (human promotes candidate → authoritative)
 *  - conformance : evaluateConformance  (fold a supplied AnalysisResult → verdict)
 *
 * OMITTED — `fitness run`: the rebuilt runner `runFitness` (rebuild/acg/fitness.ts)
 * needs a `StaticAnalysisHost` to actually scan, and the ONLY implementation in
 * rebuild/ is `FakeStaticAnalysisHost` (rebuild/analysis/fake-host.ts) — there is
 * no real (codeql/lsp) host yet. Exposing `fitness run` would run governance
 * against a FAKE analyzer and dress the output up as a real scan, which is
 * dishonest, so the live-scan verb is host-blocked and left off.
 *
 * `conformance` is NOT that verb: it never invokes an analyzer. It is the pure
 * fold `evaluateConformance(fn, result)` over an AnalysisResult the caller
 * SUPPLIES (e.g. produced elsewhere). The honest-unverified rule holds — a
 * `degraded` supplied result yields verdict=unverified, never a pass.
 */

/** citty repeatable string arg is undefined|string|string[]; normalize to array. */
function asArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Parse a `--forbid "from,to,reason"` token. All three fields are required.
 * `reason` may itself contain commas, so only the first two commas split fields
 * and the remainder is rejoined as the reason.
 */
function parseForbidden(tokens: string[]): ForbiddenDependency[] {
  return tokens.map((t) => {
    const [from, to, ...rest] = t.split(',').map((s) => s.trim());
    const reason = rest.join(',').trim();
    if (!from || !to || !reason) {
      throw new Error(`--forbid expected "from,to,reason", got "${t}"`);
    }
    return { from, to, reason };
  });
}

/**
 * `ditto acg propose` — the ADR-0004 Q3 agent-candidate path. Assembles a
 * NON-authoritative candidate spec (produced_by=agent) from OBSERVED structure:
 * layer names + cross-layer public surfaces, and NEVER any forbidden_dependencies
 * (rules are the human's, declared at ratify). Prints the candidate for review;
 * it writes nothing and can never overwrite an authoritative spec.
 */
const acgPropose = defineCommand({
  meta: {
    name: 'propose',
    description:
      'Build a NON-authoritative candidate ArchitectureSpec (produced_by=agent) from observed layer + surface names. No forbidden deps (declared at ratify).',
  },
  args: {
    layer: { type: 'string', description: 'Observed layer name (repeatable)', required: false },
    surface: { type: 'string', description: 'Observed public surface (repeatable)', required: false },
    'produced-at': { type: 'string', description: 'ISO timestamp for produced_at (default: now)', required: false },
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
    const obs: ArchitectureObservation = {
      layers: asArray(args.layer),
      publicSurfaces: asArray(args.surface),
    };
    const producedAt = args['produced-at'] ?? new Date().toISOString();
    const spec = buildCandidateSpec(obs, producedAt);
    if (format === 'json') {
      writeJson(spec);
    } else {
      writeHuman(`acg propose: candidate spec (produced_by=${spec.produced_by})`);
      writeHuman(`  layers:  ${Object.keys(spec.layers).join(', ') || '(none)'}`);
      writeHuman(`  surfaces: ${spec.public_surfaces.join(', ') || '(none)'}`);
      writeHuman('  forbidden_dependencies: (none — declare at ratify)');
    }
  },
});

/**
 * `ditto acg ratify` — the human promotion path. Reads a candidate spec (inline
 * JSON), attaches ONLY the human-declared forbidden dependencies (never
 * auto-derived), and promotes it to authoritative (produced_by=user). Refuses a
 * spec that is already authoritative — re-ratifying would clobber a human-owned
 * spec — and exits with a usage error in that case.
 */
const acgRatify = defineCommand({
  meta: {
    name: 'ratify',
    description:
      'Promote a candidate ArchitectureSpec to authoritative (produced_by=user), attaching only the human-declared --forbid rules. Refuses an already-authoritative spec.',
  },
  args: {
    'candidate-json': {
      type: 'string',
      description: 'Candidate ArchitectureSpec as inline JSON (from `acg propose`)',
      required: true,
    },
    forbid: {
      type: 'string',
      description: 'Forbidden dependency "from,to,reason" (repeatable). Human-declared only.',
      required: false,
    },
    'ratified-at': { type: 'string', description: 'ISO timestamp for produced_at (default: now)', required: false },
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

    let raw: unknown;
    try {
      raw = JSON.parse(args['candidate-json']);
    } catch (err) {
      writeError(`--candidate-json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(USAGE_ERROR_EXIT);
    }
    const parsed = architectureSpec.safeParse(raw);
    if (!parsed.success) {
      writeError('--candidate-json failed ArchitectureSpec validation:');
      for (const issue of parsed.error.issues) writeError(`  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
      process.exit(USAGE_ERROR_EXIT);
    }
    const candidate: ArchitectureSpec = parsed.data;

    let forbidden: ForbiddenDependency[];
    try {
      forbidden = parseForbidden(asArray(args.forbid));
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
    }
    const ratifiedAt = args['ratified-at'] ?? new Date().toISOString();

    let spec: ArchitectureSpec;
    try {
      spec = ratifyCandidateSpec(candidate, { forbidden, ratifiedAt });
    } catch (err) {
      // ratifyCandidateSpec refuses an already-authoritative spec.
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
    }
    if (format === 'json') {
      writeJson(spec);
    } else {
      writeHuman(`acg ratify: authoritative spec (produced_by=${spec.produced_by})`);
      writeHuman(`  forbidden_dependencies: ${spec.forbidden_dependencies.length}`);
      for (const f of spec.forbidden_dependencies) writeHuman(`    - ${f.from} → ${f.to}: ${f.reason}`);
    }
  },
});

/**
 * `ditto acg conformance` — the pure conformance fold. Given a FitnessFunction
 * and an AnalysisResult the caller SUPPLIES (both inline JSON), it computes the
 * governance verdict + delta. It does NOT run any analyzer (that live-scan path
 * is host-blocked). The honest-unverified rule is total: a `degraded` supplied
 * result yields verdict=unverified — never a pass. Exits non-zero unless the
 * verdict is a clean pass, so unverified never silently clears the gate.
 */
const acgConformance = defineCommand({
  meta: {
    name: 'conformance',
    description:
      'Fold a supplied AnalysisResult into a conformance verdict for one fitness function (does not run an analyzer). Exits non-zero unless verdict=pass.',
  },
  args: {
    'function-json': {
      type: 'string',
      description: 'FitnessFunction as inline JSON (see FitnessFunction schema)',
      required: true,
    },
    'analysis-json': {
      type: 'string',
      description: 'AnalysisResult as inline JSON (a supplied analyzer result — this verb does not scan)',
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

    let rawFn: unknown;
    try {
      rawFn = JSON.parse(args['function-json']);
    } catch (err) {
      writeError(`--function-json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(USAGE_ERROR_EXIT);
    }
    const fnParsed = fitnessFunction.safeParse(rawFn);
    if (!fnParsed.success) {
      writeError('--function-json failed FitnessFunction validation:');
      for (const issue of fnParsed.error.issues) writeError(`  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
      process.exit(USAGE_ERROR_EXIT);
    }

    let rawResult: unknown;
    try {
      rawResult = JSON.parse(args['analysis-json']);
    } catch (err) {
      writeError(`--analysis-json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(USAGE_ERROR_EXIT);
    }
    const resultParsed = analysisResult.safeParse(rawResult);
    if (!resultParsed.success) {
      writeError('--analysis-json failed AnalysisResult validation:');
      for (const issue of resultParsed.error.issues) writeError(`  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
      process.exit(USAGE_ERROR_EXIT);
    }
    const result: AnalysisResult = resultParsed.data;

    const conformance = evaluateConformance(fnParsed.data, result);
    if (format === 'json') {
      writeJson(conformance);
    } else {
      writeHuman(`acg conformance ${fnParsed.data.id}: ${conformance.verdict.toUpperCase()}`);
      writeHuman(`  grounds: ${conformance.grounds}`);
      if (conformance.new_violation_ids.length > 0) {
        writeHuman(`  new violations: ${conformance.new_violation_ids.join(', ')}`);
      }
    }
    if (conformance.verdict !== 'pass') process.exit(RUNTIME_ERROR_EXIT);
  },
});

export const acgCommand = defineCommand({
  meta: {
    name: 'acg',
    description:
      'Rebuilt ACG governance — candidate spec (propose), ratify to authoritative (ratify), conformance fold over a supplied AnalysisResult (conformance)',
  },
  subCommands: {
    propose: acgPropose,
    ratify: acgRatify,
    conformance: acgConformance,
  },
});
