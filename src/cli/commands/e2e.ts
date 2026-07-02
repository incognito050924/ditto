import { mkdir, readFile, readdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { defineCommand } from 'citty';
import { z } from 'zod';
import { localDir } from '~/core/ditto-paths';
import { defaultApplicabilityDeps, evaluateAxis3FromRepo } from '~/core/e2e/applicability';
import {
  assertionMapGate,
  buildAssertionMap,
  renderAssertionMapDoc,
} from '~/core/e2e/assertion-mapping';
import { runJourney } from '~/core/e2e/browser';
import { checkStepConformance } from '~/core/e2e/conformance';
import { buildFailureReport, renderFailureLines } from '~/core/e2e/failure-report';
import {
  appendFailureVerdict,
  appendFlakyHistory,
  featureFixAllowed,
} from '~/core/e2e/failure-verdict';
import { verifyGenerated } from '~/core/e2e/generated-verify';
import { type RunGeneratorInput, runGenerator } from '~/core/e2e/generator';
import {
  type E2eHost,
  type E2eLoop,
  PLAYWRIGHT_CONFIG_STUB,
  SEED_SPEC_STUB,
  buildE2eAgentsRecord,
  gatePlaywrightVersion,
  resolveLoop,
  scaffoldIfAbsent,
  writeE2eAgentsRecord,
  writeMergedMcpJson,
} from '~/core/e2e/init-agents';
import { computeSourceDigest, detectStale } from '~/core/e2e/journey-digest';
import { parseJourneyDoc, splitFrontMatter } from '~/core/e2e/journey-dsl';
import { runLifecycleAction } from '~/core/e2e/lifecycle';
import { type ProjectJourneyResult, projectJourneyToPlan } from '~/core/e2e/plan-adapter';
import { runRegressionGate } from '~/core/e2e/regression-gate';
import { type RedactionRule, assertNoPlaintextSecret } from '~/core/e2e/secret-redaction';
import { atomicWriteText, ensureDir, resolveRepoRootForCreate } from '~/core/fs';
import { e2eFailureClassification } from '~/schemas/e2e-failure-verdict';
import { e2eStep } from '~/schemas/e2e-journey';
import type { JourneyFrontMatter } from '~/schemas/journey-dsl';
import {
  RUNTIME_ERROR_EXIT,
  USAGE_ERROR_EXIT,
  parseOutputFormat,
  writeError,
  writeHuman,
  writeJson,
} from '../util';

/**
 * `ditto e2e run` — surface the M5 browser runtime (`runJourney`) as a thin CLI so
 * the `playwright-e2e` agent (Bash-only; cannot call a TS function) can drive ONE
 * direct-URL journey and persist the `e2eJourney` artifact. No browser present →
 * a schema-legal `result='blocked'` journey (never a download, never a hard fail).
 */
const e2eRunSpec = z.object({
  journey: z.string().min(1),
  url: z.string().min(1),
  steps: z.array(e2eStep).default([]),
  assertions: z.array(z.object({ description: z.string().min(1) })).default([]),
});

const e2eRun = defineCommand({
  meta: {
    name: 'run',
    description: 'Run one browser user journey and write its e2eJourney artifact',
  },
  args: {
    runId: { type: 'string', description: 'Run id → .ditto/local/runs/<runId>/', required: true },
    json: {
      type: 'string',
      description: 'JSON spec: {journey,url,steps,assertions}',
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
    const parsed = e2eRunSpec.safeParse(raw);
    if (!parsed.success) {
      writeError('--json failed schema validation:');
      for (const issue of parsed.error.issues) {
        writeError(`  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
      }
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    try {
      const repoRoot = await resolveRepoRootForCreate();
      const result = await runJourney(repoRoot, args.runId, parsed.data);
      const runDir = localDir(repoRoot, 'runs', args.runId);
      await mkdir(runDir, { recursive: true });
      await atomicWriteText(
        join(runDir, 'journey.json'),
        `${JSON.stringify(result.journey, null, 2)}\n`,
      );
      if (format === 'json') {
        writeJson(result);
      } else {
        writeHuman(`e2e run ${result.run_id}: ${result.journey.result}`);
        writeHuman(`  artifact: .ditto/local/runs/${result.run_id}/journey.json`);
        if (!result.probe.available) writeHuman(`  (blocked: ${result.probe.reason})`);
      }
    } catch (err) {
      writeError(`e2e run failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

const e2eApplicable = defineCommand({
  meta: {
    name: 'applicable',
    description:
      'Decide whether axis-3 (browser E2E) applies to this target, or is N/A (no web UI)',
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
    try {
      const repoRoot = await resolveRepoRootForCreate();
      const result = evaluateAxis3FromRepo(defaultApplicabilityDeps(repoRoot));
      if (format === 'json') {
        writeJson(result);
      } else {
        writeHuman(`axis-3 e2e: ${result.applicable ? 'APPLICABLE' : 'N/A'} — ${result.reason}`);
        if (!result.applicable) {
          writeHuman(`  covered by: ${result.covered_by.join('; ')}`);
        }
      }
    } catch (err) {
      writeError(`e2e applicable failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

/**
 * `ditto e2e conformance` — the ac-3 traceability gate for the authoring
 * pipeline (wi_260610p9h). Every DSL step (journey + uses_blocks blocks) must
 * have a `// @step <owner>/<id>` marker in the generated spec or its support
 * helpers, and the generated artifacts must be FRESH w.r.t. their DSL sources
 * (`detectStale`). Missing markers or staleness → non-zero exit. Thin wrapper:
 * the logic is `checkStepConformance` (src/core/e2e/conformance.ts).
 */
const e2eConformance = defineCommand({
  meta: {
    name: 'conformance',
    description: 'Check DSL step ↔ generated @step marker traceability + digest freshness',
  },
  args: {
    journey: { type: 'string', description: 'Path to <slug>.journey.md', required: true },
    'blocks-dir': {
      type: 'string',
      description: 'Dir with <block-id>.block.md files (default: <journey dir>/blocks)',
    },
    generated: { type: 'string', description: 'Path to generated <slug>.spec.ts', required: true },
    'support-dir': {
      type: 'string',
      description: 'Dir with generated support helpers (default: <generated dir>/support)',
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
    try {
      const journeyAbs = resolve(args.journey);
      const generatedAbs = resolve(args.generated);
      const blocksDir = resolve(args['blocks-dir'] ?? join(dirname(journeyAbs), 'blocks'));
      const supportDir = resolve(args['support-dir'] ?? join(dirname(generatedAbs), 'support'));

      const journeyText = await readFile(journeyAbs, 'utf8');
      const generatedText = await readFile(generatedAbs, 'utf8');
      const blockTexts: Record<string, string> = {};
      try {
        for (const name of await readdir(blocksDir)) {
          if (!name.endsWith('.block.md')) continue;
          blockTexts[name.slice(0, -'.block.md'.length)] = await readFile(
            join(blocksDir, name),
            'utf8',
          );
        }
      } catch {
        // No blocks dir: journeys without blocks are fine; declared-but-missing
        // blocks surface as conformance errors below.
      }
      const supportTexts: string[] = [];
      try {
        for (const name of await readdir(supportDir)) {
          if (!name.endsWith('.ts')) continue;
          supportTexts.push(await readFile(join(supportDir, name), 'utf8'));
        }
      } catch {
        // No support dir: block markers would simply be missing.
      }

      const report = checkStepConformance({ journeyText, blockTexts, generatedText, supportTexts });

      // Freshness (ac-4 mechanics applied at the gate): journey ↔ spec, and each
      // used block ↔ its support helper when one exists. The expected-source
      // argument (O-15) also pins the header `@ditto-source` to THIS DSL file —
      // a digest borrowed from another source cannot prove freshness.
      const repoRoot = await resolveRepoRootForCreate();
      const repoRel = (abs: string): string => relative(repoRoot, abs).split(sep).join('/');
      const stale: string[] = [];
      const journeyVerdict = await detectStale(journeyAbs, generatedAbs, repoRel(journeyAbs));
      if (journeyVerdict.stale) stale.push(`${args.generated}: ${journeyVerdict.reason}`);
      const parsedJourney = parseJourneyDoc(journeyText);
      if (parsedJourney.ok) {
        for (const blockId of parsedJourney.frontMatter.uses_blocks) {
          if (blockTexts[blockId] === undefined) continue; // already a conformance error
          const helperAbs = join(supportDir, `${blockId}.block.ts`);
          const blockMdAbs = join(blocksDir, `${blockId}.block.md`);
          const verdict = await detectStale(blockMdAbs, helperAbs, repoRel(blockMdAbs));
          if (verdict.stale) stale.push(`support/${blockId}.block.ts: ${verdict.reason}`);
        }
      }

      const ok = report.ok && stale.length === 0;
      if (format === 'json') {
        writeJson({ ...report, ok, stale });
      } else {
        writeHuman(`e2e conformance: ${ok ? 'OK' : 'FAIL'}`);
        writeHuman(`  required: ${report.required.length}, found: ${report.found.length}`);
        for (const ref of report.missing) writeHuman(`  missing marker: ${ref}`);
        for (const err of report.errors) writeHuman(`  error: ${err}`);
        for (const s of stale) writeHuman(`  stale: ${s}`);
      }
      if (!ok) process.exit(RUNTIME_ERROR_EXIT);
    } catch (err) {
      writeError(`e2e conformance failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

/**
 * `ditto e2e verify-generated` — the ac-2 pre-commit run gate. Executes the
 * generated specs once through the target repo's standard Playwright runner
 * and records pass/fail under `.ditto/local/runs/<runId>/generated-verify.json`.
 * No browser → blocked record + non-zero exit, never an install attempt (ac-9).
 */
const e2eVerifyGenerated = defineCommand({
  meta: {
    name: 'verify-generated',
    description: 'Run generated spec files once (npx playwright test) and record pass/fail',
  },
  args: {
    runId: { type: 'string', description: 'Run id → .ditto/local/runs/<runId>/', required: true },
    files: {
      type: 'string',
      description: 'Comma-separated generated spec paths (repo-relative)',
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
    const files = (args.files ?? '')
      .split(',')
      .map((f) => f.trim())
      .filter((f) => f !== '');
    if (files.length === 0) {
      writeError('--files requires at least one generated spec path (comma-separated)');
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    try {
      const repoRoot = await resolveRepoRootForCreate();
      const record = await verifyGenerated(repoRoot, args.runId, files);
      if (format === 'json') {
        writeJson(record);
      } else {
        writeHuman(`e2e verify-generated ${record.run_id}: ${record.result} — ${record.reason}`);
        writeHuman(`  record: .ditto/local/runs/${record.run_id}/generated-verify.json`);
      }
      if (record.result !== 'pass') process.exit(RUNTIME_ERROR_EXIT);
    } catch (err) {
      writeError(
        `e2e verify-generated failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

/** id → name map from `e2e/journeys/*.journey.md` (best-effort, for rendering). */
async function loadJourneyNames(repoRoot: string): Promise<Record<string, string>> {
  const names: Record<string, string> = {};
  const journeysDir = join(repoRoot, 'e2e', 'journeys');
  try {
    for (const name of await readdir(journeysDir)) {
      if (!name.endsWith('.journey.md')) continue;
      const parsed = parseJourneyDoc(await readFile(join(journeysDir, name), 'utf8'));
      if (parsed.ok) names[parsed.frontMatter.id] = parsed.frontMatter.name;
    }
  } catch {
    // No journeys dir: fall back to journey ids in the report.
  }
  return names;
}

/**
 * `ditto e2e failure-report` — ac-11 (spec §8 흐름 3). Reads the JSON-reporter
 * output preserved by `verify-generated` and reports each failure in DSL step
 * vocabulary (어느 여정의 어느 단계에서 무엇을 기대했는데 무엇이 나왔다) plus
 * the replay means: headed re-run command + trace viewer. Reporting only — the
 * verdict belongs to the user (`failure-verdict`).
 */
const e2eFailureReport = defineCommand({
  meta: {
    name: 'failure-report',
    description: 'Report e2e failures in DSL step vocabulary with replay commands',
  },
  args: {
    runId: { type: 'string', description: 'Run id → .ditto/local/runs/<runId>/', required: true },
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
    try {
      const repoRoot = await resolveRepoRootForCreate();
      const reportPath = join(localDir(repoRoot, 'runs', args.runId), 'playwright-report.json');
      const reportFile = Bun.file(reportPath);
      if (!(await reportFile.exists())) {
        writeError(
          `no playwright-report.json for run ${args.runId} — run \`ditto e2e verify-generated --runId ${args.runId} --files <specs>\` first`,
        );
        process.exit(RUNTIME_ERROR_EXIT);
        return;
      }
      const reporter: unknown = JSON.parse(await reportFile.text());
      const failures = await buildFailureReport(reporter, {
        repoRoot,
        readSpec: async (specFile) => {
          try {
            return await readFile(resolve(repoRoot, specFile), 'utf8');
          } catch {
            return null;
          }
        },
      });
      if (format === 'json') {
        writeJson({ run_id: args.runId, failures });
        return;
      }
      writeHuman(`e2e failure-report ${args.runId}: 실패 ${failures.length}건`);
      if (failures.length === 0) return;
      const names = await loadJourneyNames(repoRoot);
      for (const failure of failures) {
        writeHuman('');
        for (const line of renderFailureLines(failure, names[failure.journey_id])) {
          writeHuman(line);
        }
      }
      writeHuman('');
      writeHuman(
        '판정(사용자): ditto e2e failure-verdict --work-item <wi> --journey <id> --case <name> --classification <기능|스크립트|환경|flaky> --basis <근거>',
      );
    } catch (err) {
      writeError(`e2e failure-report failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

const CLASSIFICATION_FOLLOW_UP: Record<string, string> = {
  기능: '기능 결함 — 이 journey·case에 한해 기능 코드 수정(implement 회귀)이 허용된다',
  스크립트: '스크립트 결함 — scripter 재생성 후 conformance·verify-generated 게이트 재통과 필요',
  환경: '환경·데이터 — blocked로 두고 해당 AC는 미검증 유지',
  flaky: 'flaky — 이번만 예외, journey front-matter flaky_history에 기록됨',
};

/**
 * `ditto e2e failure-verdict` — ac-12 (spec §8 흐름 2~4). Records the USER's
 * failure classification in the append-only ledger
 * `.ditto/local/work-items/<wi>/e2e-verdicts.jsonl`. Running this command IS
 * the user confirmation (agents must not invoke it on their own judgment —
 * they only propose a classification with its basis). A feature-code fix stays
 * locked (`featureFixAllowed`) until a '기능' verdict lands here.
 */
const e2eFailureVerdictCmd = defineCommand({
  meta: {
    name: 'failure-verdict',
    description:
      'Record the user verdict (기능|스크립트|환경|flaky) for an e2e failure. ⚠ USER-ONLY DECISION: ' +
      'an agent must NEVER run this on its own judgment — running it IS recording a user decision, ' +
      'so invoke it only after the user explicitly stated this exact classification. ' +
      'Fabricating it violates ac-12 and is auditable in the append-only ledger.',
  },
  args: {
    'work-item': { type: 'string', description: 'Work item id', required: true },
    journey: { type: 'string', description: 'Journey id (jrn-…)', required: true },
    case: { type: 'string', description: 'Case name from the test title', required: true },
    classification: {
      type: 'string',
      description:
        "기능|스크립트|환경|flaky — must be the classification the USER chose, verbatim; an agent's own proposal is not a verdict",
      required: true,
    },
    basis: { type: 'string', description: 'Why this classification', required: true },
    'journey-file': {
      type: 'string',
      description: 'Journey .journey.md path (required when classification=flaky)',
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
    const classification = e2eFailureClassification.safeParse(args.classification);
    if (!classification.success) {
      writeError(
        `--classification must be one of 기능|스크립트|환경|flaky (got: ${args.classification})`,
      );
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const journeyFile = args['journey-file'];
    if (classification.data === 'flaky' && journeyFile === undefined) {
      writeError('classification=flaky requires --journey-file to record flaky_history');
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    try {
      const repoRoot = await resolveRepoRootForCreate();
      if (journeyFile !== undefined) {
        // O-19: flaky history rewrites the journey file — refuse a path that
        // resolves outside the repo (this command manages repo assets only).
        const rel = relative(repoRoot, resolve(repoRoot, journeyFile));
        if (rel.startsWith('..') || isAbsolute(rel)) {
          writeError(`--journey-file이 저장소 밖을 가리킨다: ${journeyFile} — 거부한다`);
          process.exit(USAGE_ERROR_EXIT);
          return;
        }
      }
      const decided_at = new Date().toISOString();
      const verdict = await appendFailureVerdict(repoRoot, args['work-item'], {
        journey_id: args.journey,
        case_name: args.case,
        classification: classification.data,
        confirmed_by_user: true,
        basis: args.basis,
        decided_at,
      });
      if (classification.data === 'flaky' && journeyFile !== undefined) {
        await appendFlakyHistory(resolve(repoRoot, journeyFile), {
          date: decided_at.slice(0, 10),
          case: args.case,
          note: args.basis,
        });
      }
      if (format === 'json') {
        writeJson(verdict);
      } else {
        writeHuman(
          `e2e failure-verdict 기록: ${verdict.journey_id} · ${verdict.case_name} → ${verdict.classification}`,
        );
        writeHuman(`  원장: .ditto/local/work-items/${args['work-item']}/e2e-verdicts.jsonl`);
        writeHuman(`  처리: ${CLASSIFICATION_FOLLOW_UP[verdict.classification]}`);
      }
    } catch (err) {
      writeError(`e2e failure-verdict failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

/**
 * `ditto e2e fix-allowed` — the ac-12 lock QUERY (dialectic-1 O-1). Surfaces
 * `featureFixAllowed` as an executable gate: before any feature-code fix
 * motivated by an e2e failure, the agent runs this; a non-zero exit means the
 * latest user verdict for the journey·case is not '기능' (or none exists) and
 * feature-code edits stay forbidden. The exit code is the evidence.
 */
const e2eFixAllowed = defineCommand({
  meta: {
    name: 'fix-allowed',
    description: 'Query the ac-12 lock: may feature code be fixed for this journey·case failure?',
  },
  args: {
    'work-item': { type: 'string', description: 'Work item id', required: true },
    journey: { type: 'string', description: 'Journey id (jrn-…)', required: true },
    case: { type: 'string', description: 'Case name from the test title', required: true },
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
    try {
      const repoRoot = await resolveRepoRootForCreate();
      const gate = await featureFixAllowed(repoRoot, args['work-item'], args.journey, args.case);
      if (format === 'json') {
        writeJson(gate);
      } else {
        writeHuman(`e2e fix-allowed: ${gate.allowed ? 'ALLOWED' : 'LOCKED'} — ${gate.reason}`);
      }
      if (!gate.allowed) process.exit(RUNTIME_ERROR_EXIT);
    } catch (err) {
      writeError(`e2e fix-allowed failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

/**
 * `ditto e2e digest` — canonical source digest for generated headers (O-2).
 * The digest excludes the operational `flaky_history` front-matter field, so a
 * flaky verdict never flips conformance to stale. The scripter embeds THIS
 * value as `@ditto-digest sha256:<hex>` (not a raw `shasum` of the file).
 */
const e2eDigest = defineCommand({
  meta: {
    name: 'digest',
    description: 'Print the canonical digest of a journey/block DSL file (flaky_history excluded)',
  },
  args: {
    journey: {
      type: 'string',
      description: 'Path to the .journey.md/.block.md file',
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
    try {
      const text = await readFile(resolve(args.journey), 'utf8');
      const digest = computeSourceDigest(text);
      if (format === 'json') {
        writeJson({ file: args.journey, digest });
      } else {
        writeHuman(`sha256:${digest}`);
      }
    } catch (err) {
      writeError(`e2e digest failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

const csv = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v !== '');

/**
 * `ditto e2e regression` — ac-7 회귀 게이트. Crosses the change diff with each
 * journey's `component:` surfaces, runs ONLY the impacted subset (never the
 * whole suite) through verifyGenerated, and records the no-escape result at
 * `.ditto/local/work-items/<wi>/regression-gate.json`. The selection is shown
 * by name·description (user adjusts via `--journeys`); fail/blocked → non-zero.
 */
const e2eRegression = defineCommand({
  meta: {
    name: 'regression',
    description: 'Select diff-impacted journeys and run them as the regression gate',
  },
  args: {
    'work-item': { type: 'string', description: 'Work item id', required: true },
    'changed-files': {
      type: 'string',
      description: 'Comma-separated changed paths (the diff)',
      required: true,
    },
    journeys: {
      type: 'string',
      description: 'User-adjusted journey id csv — replaces the auto selection',
    },
    runId: { type: 'string', description: 'Run id (default: regression-<timestamp>)' },
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
    const changedPaths = csv(args['changed-files']);
    if (changedPaths.length === 0) {
      writeError('--changed-files requires at least one changed path (comma-separated)');
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const journeyIds = args.journeys !== undefined ? csv(args.journeys) : undefined;
    if (journeyIds !== undefined && journeyIds.length === 0) {
      // An empty adjustment would silently replace the auto selection with []
      // and let the gate pass on nothing — refuse it as a usage error.
      writeError(
        '--journeys requires at least one journey id (omit the flag to use the auto selection)',
      );
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const runId = args.runId ?? `regression-${Date.now().toString(36)}`;
    try {
      const repoRoot = await resolveRepoRootForCreate();
      const { record, selection } = await runRegressionGate(repoRoot, {
        workItemId: args['work-item'],
        runId,
        changedPaths,
        ...(journeyIds !== undefined ? { journeyIds } : {}),
      });
      if (format === 'json') {
        writeJson({
          ...record,
          unmatched_changed_paths: selection.unmatched_changed_paths,
          invalid_journeys: selection.invalid_journeys,
        });
      } else {
        writeHuman(`e2e regression ${args['work-item']}: ${record.result} — ${record.reason}`);
        for (const j of record.selected) {
          // 합의 설계: 추림 목록은 id가 아니라 name·description으로 제시한다.
          writeHuman(
            `  - ${j.name} — ${j.description}${j.missing_generated ? ' [generated spec 없음]' : ''}`,
          );
        }
        for (const f of record.failures) {
          writeHuman(`  실패: ${f.journey_id} · ${f.case}`);
        }
        for (const inv of selection.invalid_journeys) {
          writeHuman(`  경고: ${inv.file} 파싱 불가 — ${inv.error}`);
        }
        writeHuman(
          `  기록: .ditto/local/work-items/${args['work-item']}/regression-gate.json (run ${record.run_id})`,
        );
      }
      if (record.result !== 'pass') process.exit(RUNTIME_ERROR_EXIT);
    } catch (err) {
      writeError(`e2e regression failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

/**
 * `ditto e2e lifecycle` — ac-8 집행 절반. Update/delete of a DSL-derived test,
 * gated on explicit user confirmation (`--confirmed-by-user` IS the
 * confirmation — agents must not pass it on their own judgment) and on the
 * derived-artifact guard (manual files are refused). The decision lands in an
 * append-only ledger (work-item-scoped via `--work-item`, else repo-global).
 */
const e2eLifecycle = defineCommand({
  meta: {
    name: 'lifecycle',
    description:
      'Update or delete a DSL-derived e2e test after user confirmation. ⚠ USER-ONLY DECISION: ' +
      'an agent must NEVER pass --confirmed-by-user on its own judgment — propose the action with ' +
      'its basis, wait for the user to explicitly approve, and only then re-run with the flag. ' +
      'Passing it unapproved is fabricating a user decision (ac-8) and is auditable in the ledger.',
  },
  args: {
    action: { type: 'string', description: 'update|delete', required: true },
    'journey-file': { type: 'string', description: 'Path to <slug>.journey.md', required: true },
    'confirmed-by-user': {
      type: 'boolean',
      description:
        '⚠ The USER explicitly approved this exact action in this conversation (required). ' +
        'This flag IS the recorded user decision — an agent must never set it autonomously, ' +
        'however obvious the action seems; no user approval = do not run this command',
      default: false,
    },
    reason: { type: 'string', description: 'Why the test is updated/deleted' },
    'work-item': { type: 'string', description: 'Record the decision under this work item' },
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
    if (args.action !== 'update' && args.action !== 'delete') {
      writeError(`--action must be update|delete (got: ${args.action})`);
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    if (!args['confirmed-by-user']) {
      writeError(
        '갱신·삭제는 사용자 확인이 필요하다 — 사용자의 명시 확인을 받은 뒤 --confirmed-by-user를 붙여 다시 실행하라',
      );
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    try {
      const repoRoot = await resolveRepoRootForCreate();
      const result = await runLifecycleAction(repoRoot, {
        action: args.action,
        journeyFile: args['journey-file'],
        confirmedByUser: true,
        ...(args.reason !== undefined ? { reason: args.reason } : {}),
        ...(args['work-item'] !== undefined ? { workItemId: args['work-item'] } : {}),
      });
      if (!result.ok) {
        writeError(`e2e lifecycle 거부: ${result.refusal}`);
        process.exit(RUNTIME_ERROR_EXIT);
        return;
      }
      if (format === 'json') {
        writeJson(result);
      } else {
        writeHuman(`e2e lifecycle ${result.action}: ${result.journey_id}`);
        for (const f of result.deleted_files) writeHuman(`  삭제: ${f}`);
        for (const h of result.preserved_helpers) writeHuman(`  보존(공유 helper): ${h}`);
        if (result.action === 'update' && result.stale) {
          writeHuman(`  갱신 필요(stale=${result.stale.stale}): ${result.stale.reason}`);
          writeHuman('  실제 재생성은 e2e-scripter 파이프라인(skills/e2e-author) 몫이다');
        }
        writeHuman(`  결정 기록: ${result.ledger_path}`);
      }
    } catch (err) {
      writeError(`e2e lifecycle failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

// ── pipeline helpers (wi_2607026qs) ─────────────────────────────────────────

/** Repo-relative POSIX path of an absolute path (headers/artifacts want this). */
function repoRel(repoRoot: string, abs: string): string {
  return relative(repoRoot, abs).split(sep).join('/');
}

/** `<slug>` from an `e2e/journeys/<slug>.journey.md` path (drives sibling paths). */
function slugFromJourney(journeyPath: string): string {
  const base = basename(journeyPath);
  return base.endsWith('.journey.md')
    ? base.slice(0, -'.journey.md'.length)
    : base.replace(/\.[^.]+$/, '');
}

/**
 * Best-effort load of the `uses_blocks` block bodies from
 * `<journey dir>/blocks/<id>.block.md` for INLINE projection (v2 inlines blocks).
 * A missing block is skipped — the adapter emits an empty inline for it, and the
 * conformance gate surfaces a declared-but-missing block downstream.
 */
async function loadBlockBodies(
  journeyAbs: string,
  useBlocks: string[],
): Promise<Record<string, { body: string }>> {
  const out: Record<string, { body: string }> = {};
  const blocksDir = join(dirname(journeyAbs), 'blocks');
  for (const id of useBlocks) {
    try {
      const text = await readFile(join(blocksDir, `${id}.block.md`), 'utf8');
      out[id] = { body: splitFrontMatter(text)?.body ?? text };
    } catch {
      // Declared-but-missing block: skipped here; a downstream gate reports it.
    }
  }
  return out;
}

/**
 * Build the redaction rule for a journey: mask secret_vars columns +
 * auth.credentials / secret seed refs, resolving their VALUES from process.env
 * (credentials are never literal in the DSL — they live in env at run time).
 */
function buildRedactionRule(fm: JourneyFrontMatter): RedactionRule {
  const secretVars = fm.secret_vars;
  const credentialRefs = [...Object.values(fm.auth?.credentials ?? {})];
  const seedData = fm.seed?.data_ref;
  if (seedData && /^(env|secret):/.test(seedData)) credentialRefs.push(seedData);
  const envValues: Record<string, string> = {};
  for (const v of secretVars) {
    const val = process.env[v];
    if (val) envValues[v] = val;
  }
  for (const ref of credentialRefs) {
    const m = /^(?:env|secret):(.+)$/.exec(ref);
    const name = m?.[1];
    if (!name) continue;
    const val = process.env[name];
    if (val) envValues[name] = val;
  }
  return { secretVars, credentialRefs, envValues };
}

/** Parse + validate a v2 journey file, returning its front-matter, body, digest. */
async function readJourney(
  journeyAbs: string,
): Promise<
  | { ok: true; frontMatter: JourneyFrontMatter; body: string; text: string }
  | { ok: false; error: string }
> {
  const text = await readFile(journeyAbs, 'utf8');
  const parsed = parseJourneyDoc(text);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return {
    ok: true,
    frontMatter: parsed.frontMatter,
    body: splitFrontMatter(text)?.body ?? '',
    text,
  };
}

/**
 * Assemble the `RunGeneratorInput` for `ditto e2e generate` from a journey's
 * projection. Threading the projected plan, its sidecar map AND the parallel
 * `확인:` assertion channel is what keeps assertion steps traceable on the primary
 * path — dropping `planAssertions` here leaves every `확인:` step in `unmatched`
 * and fails the command loud (wi_2607026qs regression). Extracted so the CLI
 * wiring is unit-testable with a usable-probe seam (no browser needed).
 */
export function buildGenerateInput(params: {
  repoRoot: string;
  host: E2eHost;
  journey: JourneyFrontMatter;
  journeyText: string;
  journeyAbs: string;
  slug: string;
  digest: string;
  projection: ProjectJourneyResult;
}): RunGeneratorInput {
  const { repoRoot, host, journey, journeyText, journeyAbs, slug, digest, projection } = params;
  return {
    repoRoot,
    host,
    journeyId: journey.id,
    plan: projection.plan,
    planMap: projection.map,
    planAssertions: projection.assertions,
    dslOriginal: journeyText,
    header: {
      sourcePath: repoRel(repoRoot, journeyAbs),
      digest,
      kind: 'journey',
      id: journey.id,
    },
    specPath: `e2e/generated/${slug}.spec.ts`,
    planPath: `specs/${slug}.plan.md`,
  };
}

/**
 * `ditto e2e plan` — deterministic DSL v2 → official Playwright plan.md (ac-2,
 * Contract 2). Re-serialises the human journey (never resolving selectors /
 * assertions — ADR-0014 boundary), writing `specs/<slug>.plan.md` plus a
 * `specs/<slug>.plan.map.json` sidecar carrying the authoritative plan-step→DSL-
 * step join AND the parallel `확인:` assertion channel. Secrets are kept out of
 * the git-tracked plan by the adapter's redactor + fail-closed guard.
 */
const e2ePlan = defineCommand({
  meta: {
    name: 'plan',
    description: 'Project a v2 journey DSL into the official Playwright plan.md + sidecar map',
  },
  args: {
    journey: { type: 'string', description: 'Path to <slug>.journey.md', required: true },
    out: { type: 'string', description: 'Output plan path (default: specs/<slug>.plan.md)' },
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
    try {
      const repoRoot = await resolveRepoRootForCreate();
      const journeyAbs = resolve(args.journey);
      const journey = await readJourney(journeyAbs);
      if (!journey.ok) {
        writeError(`journey parse failed (DSL v2 required): ${journey.error}`);
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
      const digest = computeSourceDigest(journey.text);
      const blocks = await loadBlockBodies(journeyAbs, journey.frontMatter.uses_blocks);
      // assertNoPlaintextSecret runs inside projectJourneyToPlan (fail-closed).
      const result = projectJourneyToPlan({
        journey: journey.frontMatter,
        body: journey.body,
        blocks,
        sourcePath: repoRel(repoRoot, journeyAbs),
        digest,
        resolveVar: (v) => process.env[v],
      });
      const slug = slugFromJourney(journeyAbs);
      const outAbs = resolve(repoRoot, args.out ?? `specs/${slug}.plan.md`);
      const sidecarAbs = outAbs.replace(/\.md$/, '.map.json');
      await atomicWriteText(outAbs, result.plan);
      await atomicWriteText(
        sidecarAbs,
        `${JSON.stringify({ map: result.map, assertions: result.assertions }, null, 2)}\n`,
      );
      if (format === 'json') {
        writeJson({
          plan: repoRel(repoRoot, outAbs),
          sidecar: repoRel(repoRoot, sidecarAbs),
          redactions: result.redactions.length,
        });
      } else {
        writeHuman(`e2e plan ${slug}: ${repoRel(repoRoot, outAbs)}`);
        writeHuman(`  sidecar: ${repoRel(repoRoot, sidecarAbs)}`);
        writeHuman(`  redactions: ${result.redactions.length}`);
      }
    } catch (err) {
      writeError(`e2e plan failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

/**
 * `ditto e2e generate` — probe the official Playwright generator and route (ac-3,
 * Contract 9 / ADR-0018). USABLE → drive the live generator (a runtime seam the
 * e2e-author skill supplies via `--from-raw`) then post-pass into a traceable
 * @ditto-generated spec; UNUSABLE → degrade to the fallback @ditto-unverified
 * scaffold over the SAME plan (no crash / auto-install / fabricated pass). The
 * spec is written, then `buildAssertionMap` writes the review doc. The in-process
 * LLM/browser drive is NOT performed here — it is the unground runtime seam that
 * N-demonstrate exercises for real.
 */
const e2eGenerate = defineCommand({
  meta: {
    name: 'generate',
    description:
      'Route a v2 journey to the official Playwright generator (or degrade), post-pass + map',
  },
  args: {
    journey: { type: 'string', description: 'Path to <slug>.journey.md', required: true },
    host: { type: 'string', description: 'claude|codex', default: 'claude' },
    'from-raw': {
      type: 'string',
      description:
        'Raw generator spec from the e2e-author skill live drive (post-passed on the usable path)',
    },
    'work-item': { type: 'string', description: 'Also write the machine assertion map here' },
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
    if (args.host !== 'claude' && args.host !== 'codex') {
      writeError(`--host must be claude|codex (got: ${args.host})`);
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const host: E2eHost = args.host;
    try {
      const repoRoot = await resolveRepoRootForCreate();
      const journeyAbs = resolve(args.journey);
      const journey = await readJourney(journeyAbs);
      if (!journey.ok) {
        writeError(`journey parse failed (DSL v2 required): ${journey.error}`);
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
      const digest = computeSourceDigest(journey.text);
      const blocks = await loadBlockBodies(journeyAbs, journey.frontMatter.uses_blocks);
      const projection = projectJourneyToPlan({
        journey: journey.frontMatter,
        body: journey.body,
        blocks,
        sourcePath: repoRel(repoRoot, journeyAbs),
        digest,
        resolveVar: (v) => process.env[v],
      });
      const slug = slugFromJourney(journeyAbs);
      const rawSpec =
        args['from-raw'] !== undefined
          ? await readFile(resolve(repoRoot, args['from-raw']), 'utf8')
          : undefined;

      const result = await runGenerator(
        buildGenerateInput({
          repoRoot,
          host,
          journey: journey.frontMatter,
          journeyText: journey.text,
          journeyAbs,
          slug,
          digest,
          projection,
        }),
        {
          // The live browser drive is not available in this process — the skill
          // supplies the raw spec via --from-raw; without it, the usable path
          // cannot be completed here (probe→degrade is the CLI-testable route).
          driveOfficialGenerator: async () => {
            if (rawSpec !== undefined) return rawSpec;
            throw new Error(
              'official generator is usable but the live browser drive is not available in-process — run the e2e-author skill and pass its raw spec via --from-raw',
            );
          },
        },
      );

      // Primary path: refuse to write a non-conformant spec (fail loud, Contract 3).
      if (!result.used_fallback && result.unmatched && result.unmatched.length > 0) {
        writeError(
          `post-pass left ${result.unmatched.length} journey step(s) without a marker; not writing: ${result.unmatched.join(', ')}`,
        );
        process.exit(RUNTIME_ERROR_EXIT);
        return;
      }

      const rule = buildRedactionRule(journey.frontMatter);
      assertNoPlaintextSecret(result.spec, rule); // Contract 6(b) fail-closed guard
      const specAbs = resolve(repoRoot, result.specPath);
      await atomicWriteText(specAbs, result.spec.endsWith('\n') ? result.spec : `${result.spec}\n`);

      const wi = args['work-item'] ?? 'ad-hoc';
      const amap = buildAssertionMap({
        journeyId: journey.frontMatter.id,
        journeyBody: journey.body,
        generatedSpec: result.spec,
        workItemId: wi,
        generatedSpecPath: result.specPath,
        rule,
      });
      const mapDocRel = `specs/${slug}.assertion-map.md`;
      await atomicWriteText(resolve(repoRoot, mapDocRel), renderAssertionMapDoc(amap));
      if (args['work-item'] !== undefined) {
        await atomicWriteText(
          join(localDir(repoRoot, 'work-items', wi), 'e2e-assertion-map.json'),
          `${JSON.stringify(amap, null, 2)}\n`,
        );
      }
      const gate = assertionMapGate(amap);

      if (format === 'json') {
        writeJson({
          route: result.used_fallback ? 'fallback' : 'primary',
          spec: result.specPath,
          used_fallback: result.used_fallback,
          reason: result.reason,
          unverified_acs: result.unverified_acs,
          injected: result.injected,
          unmatched: result.unmatched,
          assertion_map: {
            doc: mapDocRel,
            weakened: amap.weakened_count,
            unmapped: amap.unmapped_count,
            gate: gate.reason,
          },
        });
      } else {
        writeHuman(
          `e2e generate ${slug}: ${result.used_fallback ? 'DEGRADED (fallback)' : 'generated'} → ${result.specPath}`,
        );
        writeHuman(`  ${result.reason}`);
        if (result.injected !== undefined) writeHuman(`  markers injected: ${result.injected}`);
        writeHuman(
          `  assertion-map: weakened ${amap.weakened_count}, unmapped ${amap.unmapped_count} — ${gate.reason}`,
        );
        writeHuman(`  map doc: ${mapDocRel}`);
        if (result.used_fallback) {
          writeHuman(`  UNVERIFIED ACs: ${result.unverified_acs.join(', ')}`);
        }
      }

      if (result.used_fallback) {
        if (result.warn) writeError(result.warn);
        process.exit(RUNTIME_ERROR_EXIT);
        return;
      }
      if (gate.hardFail) process.exit(RUNTIME_ERROR_EXIT);
    } catch (err) {
      writeError(`e2e generate failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

/**
 * `ditto e2e mapping` — build the assertion map for a generated spec (ac-6,
 * Contract 4). Deterministically classifies how faithfully each emitted matcher
 * reproduces its DSL `확인:` form, writing the git-tracked review doc
 * `specs/<slug>.assertion-map.md` (redacted) and, with `--work-item`, the machine
 * JSON. `unmapped_count > 0` (a dropped assertion) is a HARD FAIL → non-zero exit.
 */
const e2eMapping = defineCommand({
  meta: {
    name: 'mapping',
    description: 'Map DSL 확인 assertions to emitted matchers; hard-fail on any dropped assertion',
  },
  args: {
    journey: { type: 'string', description: 'Path to <slug>.journey.md', required: true },
    generated: {
      type: 'string',
      description: 'Path to the generated <slug>.spec.ts',
      required: true,
    },
    'work-item': { type: 'string', description: 'Also write the machine assertion map here' },
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
    try {
      const repoRoot = await resolveRepoRootForCreate();
      const journeyAbs = resolve(args.journey);
      const generatedAbs = resolve(args.generated);
      const journey = await readJourney(journeyAbs);
      if (!journey.ok) {
        writeError(`journey parse failed (DSL v2 required): ${journey.error}`);
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
      const generatedSpec = await readFile(generatedAbs, 'utf8');
      const rule = buildRedactionRule(journey.frontMatter);
      const wi = args['work-item'] ?? 'ad-hoc';
      const amap = buildAssertionMap({
        journeyId: journey.frontMatter.id,
        journeyBody: journey.body,
        generatedSpec,
        workItemId: wi,
        generatedSpecPath: repoRel(repoRoot, generatedAbs),
        rule,
      });
      const slug = slugFromJourney(journeyAbs);
      const docRel = `specs/${slug}.assertion-map.md`;
      await atomicWriteText(resolve(repoRoot, docRel), renderAssertionMapDoc(amap));
      if (args['work-item'] !== undefined) {
        await atomicWriteText(
          join(localDir(repoRoot, 'work-items', wi), 'e2e-assertion-map.json'),
          `${JSON.stringify(amap, null, 2)}\n`,
        );
      }
      const gate = assertionMapGate(amap);
      if (format === 'json') {
        writeJson({ ...amap, doc: docRel, gate: gate.reason });
      } else {
        writeHuman(`e2e mapping ${slug}: ${gate.hardFail ? 'HARD FAIL' : 'OK'} — ${gate.reason}`);
        writeHuman(
          `  entries: ${amap.entries.length}, weakened: ${amap.weakened_count}, unmapped: ${amap.unmapped_count}`,
        );
        writeHuman(`  doc: ${docRel}`);
      }
      if (gate.hardFail) process.exit(RUNTIME_ERROR_EXIT);
    } catch (err) {
      writeError(`e2e mapping failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

/** Detect the target repo's Playwright version; null when absent (→ degrade). */
function detectPlaywrightVersion(repoRoot: string): string | null {
  try {
    const proc = Bun.spawnSync(['bunx', '--no-install', 'playwright', '--version'], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (proc.exitCode !== 0) return null;
    const out = proc.stdout?.toString().trim();
    return out && out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * `ditto e2e init-agents` — install the deterministic, ditto-owned pieces of the
 * dual-host Playwright test-agent setup (ac-9, Contract 8), version-gated and
 * non-destructive: host↔loop pairing guard, Playwright version gate (codex
 * REQUIRES ≥1.61 → refuse below; claude warns; absent → degrade, ADR-0018 no
 * auto-install), create-if-absent scaffold, `.mcp.json` backup+merge (claude),
 * and the `.ditto/local/e2e-agents.json` version-skew record. Generating the
 * OFFICIAL planner/generator agent files + overwriting the healer with the
 * constrained def is the live external step (`npx playwright init-agents
 * --loop=<loop>`) delegated to the skill/user — reported here as a next step.
 */
const e2eInitAgents = defineCommand({
  meta: {
    name: 'init-agents',
    description:
      'Install the deterministic ditto pieces of the dual-host Playwright test-agents (version-gated, non-destructive)',
  },
  args: {
    host: { type: 'string', description: 'claude|codex', required: true },
    loop: { type: 'string', description: 'Generator loop (must match --host)' },
    'playwright-version': {
      type: 'string',
      description: 'Override detected Playwright version (skips detection; for CI/testing)',
    },
    'dry-run': {
      type: 'boolean',
      description: 'Report the planned actions without writing',
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
    if (args.host !== 'claude' && args.host !== 'codex') {
      writeError(`--host must be claude|codex (got: ${args.host})`);
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const host: E2eHost = args.host;
    let loop: E2eLoop;
    try {
      loop = resolveLoop(host, args.loop as E2eLoop | undefined);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    try {
      const repoRoot = await resolveRepoRootForCreate();
      const versionOutput = args['playwright-version'] ?? detectPlaywrightVersion(repoRoot);
      const gate = gatePlaywrightVersion(host, versionOutput);

      if (gate.decision === 'refuse') {
        writeError(`e2e init-agents refused: ${gate.message}`);
        process.exit(RUNTIME_ERROR_EXIT);
        return;
      }
      if (gate.decision === 'degrade') {
        if (format === 'json') {
          writeJson({ host, loop, decision: 'degrade', message: gate.message });
        } else {
          writeHuman(`e2e init-agents: DEGRADE — ${gate.message}`);
        }
        return; // ADR-0018: never auto-install; nothing written.
      }

      // decision === 'install'
      const playwrightVersion = gate.version?.raw ?? String(versionOutput);
      const nextStep = `run \`npx playwright init-agents --loop=${loop}\`, then ditto overwrites the healer with the constrained def (resources/playwright-agents/healer.constrained.*)`;
      if (args['dry-run']) {
        const planned = [
          'scaffold (if absent): playwright.config.ts, e2e/seed.spec.ts, specs/',
          ...(loop === 'claude' ? ['backup + merge .mcp.json (playwright-test server)'] : []),
          `write .ditto/local/e2e-agents.json (loop=${loop}, plan_format=v1, healer=constrained)`,
          `(delegated live step) ${nextStep}`,
        ];
        if (format === 'json') {
          writeJson({ host, loop, decision: 'install', dry_run: true, playwrightVersion, planned });
        } else {
          writeHuman(
            `e2e init-agents (dry-run) host=${host} loop=${loop} playwright=${playwrightVersion}`,
          );
          for (const p of planned) writeHuman(`  - ${p}`);
        }
        return;
      }

      const configResult = await scaffoldIfAbsent(
        resolve(repoRoot, 'playwright.config.ts'),
        PLAYWRIGHT_CONFIG_STUB,
      );
      const seedResult = await scaffoldIfAbsent(
        resolve(repoRoot, 'e2e', 'seed.spec.ts'),
        SEED_SPEC_STUB,
      );
      await ensureDir(resolve(repoRoot, 'specs'));
      let mcpServers: string[] | undefined;
      if (loop === 'claude') {
        const merged = await writeMergedMcpJson(resolve(repoRoot, '.mcp.json'));
        mcpServers = merged.servers;
      }
      const record = buildE2eAgentsRecord({ playwrightVersion, loop });
      await writeE2eAgentsRecord(join(localDir(repoRoot), 'e2e-agents.json'), record);
      if (gate.warn) writeError(gate.warn);

      if (format === 'json') {
        writeJson({
          host,
          loop,
          decision: 'install',
          playwrightVersion,
          scaffold: { config: configResult, seed: seedResult },
          ...(mcpServers ? { mcpServers } : {}),
          record: '.ditto/local/e2e-agents.json',
          next_step: nextStep,
        });
      } else {
        writeHuman(
          `e2e init-agents installed: host=${host} loop=${loop} playwright=${playwrightVersion}`,
        );
        writeHuman(`  playwright.config.ts: ${configResult}`);
        writeHuman(`  e2e/seed.spec.ts: ${seedResult}`);
        if (mcpServers) writeHuman(`  .mcp.json servers: ${mcpServers.join(', ')}`);
        writeHuman('  record: .ditto/local/e2e-agents.json');
        writeHuman(`  next: ${nextStep}`);
      }
    } catch (err) {
      writeError(`e2e init-agents failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

export const e2eCommand = defineCommand({
  meta: {
    name: 'e2e',
    description: 'Run a real-browser user journey and capture its evidence artifact',
  },
  subCommands: {
    run: e2eRun,
    applicable: e2eApplicable,
    plan: e2ePlan,
    generate: e2eGenerate,
    mapping: e2eMapping,
    'init-agents': e2eInitAgents,
    conformance: e2eConformance,
    'verify-generated': e2eVerifyGenerated,
    'failure-report': e2eFailureReport,
    'failure-verdict': e2eFailureVerdictCmd,
    'fix-allowed': e2eFixAllowed,
    digest: e2eDigest,
    regression: e2eRegression,
    lifecycle: e2eLifecycle,
  },
});
