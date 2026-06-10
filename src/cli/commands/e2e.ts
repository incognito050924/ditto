import { mkdir, readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { defineCommand } from 'citty';
import { z } from 'zod';
import { localDir } from '~/core/ditto-paths';
import { defaultApplicabilityDeps, evaluateAxis3FromRepo } from '~/core/e2e/applicability';
import { runJourney } from '~/core/e2e/browser';
import { checkStepConformance } from '~/core/e2e/conformance';
import { buildFailureReport, renderFailureLines } from '~/core/e2e/failure-report';
import { appendFailureVerdict, appendFlakyHistory } from '~/core/e2e/failure-verdict';
import { verifyGenerated } from '~/core/e2e/generated-verify';
import { detectStale } from '~/core/e2e/journey-digest';
import { parseJourneyDoc } from '~/core/e2e/journey-dsl';
import { runLifecycleAction } from '~/core/e2e/lifecycle';
import { runRegressionGate } from '~/core/e2e/regression-gate';
import { atomicWriteText, resolveRepoRootForCreate } from '~/core/fs';
import { e2eFailureClassification } from '~/schemas/e2e-failure-verdict';
import { e2eStep } from '~/schemas/e2e-journey';
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
      // used block ↔ its support helper when one exists.
      const stale: string[] = [];
      const journeyVerdict = await detectStale(journeyAbs, generatedAbs);
      if (journeyVerdict.stale) stale.push(`${args.generated}: ${journeyVerdict.reason}`);
      const parsedJourney = parseJourneyDoc(journeyText);
      if (parsedJourney.ok) {
        for (const blockId of parsedJourney.frontMatter.uses_blocks) {
          if (blockTexts[blockId] === undefined) continue; // already a conformance error
          const helperAbs = join(supportDir, `${blockId}.block.ts`);
          const verdict = await detectStale(join(blocksDir, `${blockId}.block.md`), helperAbs);
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
    description: 'Record the user verdict (기능|스크립트|환경|flaky) for an e2e failure',
  },
  args: {
    'work-item': { type: 'string', description: 'Work item id', required: true },
    journey: { type: 'string', description: 'Journey id (jrn-…)', required: true },
    case: { type: 'string', description: 'Case name from the test title', required: true },
    classification: {
      type: 'string',
      description: '기능|스크립트|환경|flaky',
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
    description: 'Update or delete a DSL-derived e2e test after user confirmation',
  },
  args: {
    action: { type: 'string', description: 'update|delete', required: true },
    'journey-file': { type: 'string', description: 'Path to <slug>.journey.md', required: true },
    'confirmed-by-user': {
      type: 'boolean',
      description: 'The user explicitly confirmed this action (required)',
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

export const e2eCommand = defineCommand({
  meta: {
    name: 'e2e',
    description: 'Run a real-browser user journey and capture its evidence artifact',
  },
  subCommands: {
    run: e2eRun,
    applicable: e2eApplicable,
    conformance: e2eConformance,
    'verify-generated': e2eVerifyGenerated,
    'failure-report': e2eFailureReport,
    'failure-verdict': e2eFailureVerdictCmd,
    regression: e2eRegression,
    lifecycle: e2eLifecycle,
  },
});
