import { isAbsolute, relative, resolve } from 'node:path';

/**
 * E2E 실패 보고 빌더 (wi_260610p9h ac-11, spec §8).
 *
 * Input: Playwright JSON-reporter output (persisted by `verify-generated` at
 * `.ditto/local/runs/<runId>/playwright-report.json`). Output: one entry per
 * failed test, expressed in DSL vocabulary — journey/case from the test title
 * convention `<journey-id> · <case>` (g4 scripter contract), step from the
 * nearest `// @step <owner>/<sN> <DSL 원문>` marker ABOVE the failing line in
 * the generated spec — plus replay means (headed re-run + trace viewer).
 */

export interface E2eReplay {
  headed_command: string;
  /** Present when the run captured a trace; otherwise the renderer advises `--trace on`. */
  trace_command?: string;
}

export interface E2eFailure {
  journey_id: string;
  case_name: string;
  step_id?: string;
  step_dsl_line?: string;
  expected?: string;
  actual?: string;
  message: string;
  /** Repo-relative generated spec path. */
  spec_file: string;
  replay: E2eReplay;
}

export interface BuildFailureReportOptions {
  /** Repo root — reporter spec paths are made repo-relative against it. */
  repoRoot: string;
  /** Read a repo-relative spec file (null → step mapping skipped). */
  readSpec: (specFile: string) => Promise<string | null>;
}

const FAILED_STATUSES = new Set(['failed', 'timedOut', 'interrupted']);
const STEP_MARKER = /^\s*\/\/\s*@step\s+(\S+)\/([sb]\d+)\s*(.*)$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI color codes from Playwright messages
const ANSI = /\u001b\[[0-9;]*m/g;

type Dict = Record<string, unknown>;

function asDict(v: unknown): Dict | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Dict) : null;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

interface RawFailure {
  title: string;
  specFile: string;
  message: string;
  stack: string;
  tracePath?: string;
}

/** Depth-first walk over reporter suites collecting last-result failures. */
function collectFailures(suite: Dict, rootDir: string | undefined, out: RawFailure[]): void {
  for (const child of asArray(suite.suites)) {
    const c = asDict(child);
    if (c) collectFailures(c, rootDir, out);
  }
  for (const specRaw of asArray(suite.specs)) {
    const spec = asDict(specRaw);
    if (!spec) continue;
    const title = asString(spec.title) ?? '';
    const file = asString(spec.file) ?? '';
    const specFile = rootDir !== undefined ? resolve(rootDir, file) : file;
    for (const testRaw of asArray(spec.tests)) {
      const t = asDict(testRaw);
      if (!t) continue;
      const results = asArray(t.results);
      const last = asDict(results[results.length - 1]);
      if (!last || !FAILED_STATUSES.has(asString(last.status) ?? '')) continue;
      const error = asDict(last.error) ?? asDict(asArray(last.errors)[0]) ?? {};
      const trace = asArray(last.attachments)
        .map(asDict)
        .find((a) => a !== null && asString(a.name) === 'trace' && asString(a.path) !== undefined);
      out.push({
        title,
        specFile,
        message: (asString(error.message) ?? 'unknown failure').replace(ANSI, ''),
        stack: (asString(error.stack) ?? '').replace(ANSI, ''),
        ...(trace ? { tracePath: asString(trace.path) as string } : {}),
      });
    }
  }
}

/** Find the failing line number in the given spec file from the error stack. */
function failingLine(stack: string, specFileAbsOrRel: string): number | undefined {
  const base = specFileAbsOrRel.split('/').pop() ?? specFileAbsOrRel;
  for (const line of stack.split('\n')) {
    const m = new RegExp(`${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+):\\d+`).exec(line);
    if (m?.[1]) return Number(m[1]);
  }
  return undefined;
}

/** Nearest `// @step` marker at or above `line` (1-based) in the spec text. */
function nearestStep(
  specText: string,
  line: number,
): { step_id: string; step_dsl_line?: string } | undefined {
  const lines = specText.split('\n');
  for (let i = Math.min(line, lines.length) - 1; i >= 0; i--) {
    const m = STEP_MARKER.exec(lines[i] ?? '');
    if (m?.[2]) {
      const dsl = (m[3] ?? '').trim();
      return { step_id: m[2], ...(dsl !== '' ? { step_dsl_line: dsl } : {}) };
    }
  }
  return undefined;
}

/** Best-effort `Expected:` / `Received:` extraction from a matcher message. */
function expectedActual(message: string): { expected?: string; actual?: string } {
  const expected = /^Expected[^:\n]*:\s*(.+)$/m.exec(message)?.[1]?.trim();
  const actual = /^Received[^:\n]*:\s*(.+)$/m.exec(message)?.[1]?.trim();
  return { ...(expected ? { expected } : {}), ...(actual ? { actual } : {}) };
}

export async function buildFailureReport(
  reporter: unknown,
  options: BuildFailureReportOptions,
): Promise<E2eFailure[]> {
  const root = asDict(reporter);
  if (!root) return [];
  const rootDir = asString(asDict(root.config)?.rootDir);
  const raw: RawFailure[] = [];
  collectFailures(root, rootDir, raw);

  const failures: E2eFailure[] = [];
  for (const f of raw) {
    const spec_file = isAbsolute(f.specFile) ? relative(options.repoRoot, f.specFile) : f.specFile;
    const sep = f.title.indexOf(' · ');
    const journey_id = sep >= 0 ? f.title.slice(0, sep) : '';
    const case_name = sep >= 0 ? f.title.slice(sep + ' · '.length) : f.title;

    let step: { step_id: string; step_dsl_line?: string } | undefined;
    const line = failingLine(f.stack, spec_file);
    if (line !== undefined) {
      const specText = await options.readSpec(spec_file);
      if (specText !== null) step = nearestStep(specText, line);
    }

    failures.push({
      journey_id,
      case_name,
      ...(step ?? {}),
      ...expectedActual(f.message),
      message: f.message,
      spec_file,
      replay: {
        // Playwright -g treats the pattern as a regex — escape metacharacters
        // so a case name like "가격 (1+1)" replays the exact failing test (O-9).
        headed_command: `npx playwright test ${spec_file} -g "${f.title
          .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          .replaceAll('"', '\\"')}" --headed`,
        ...(f.tracePath ? { trace_command: `npx playwright show-trace ${f.tracePath}` } : {}),
      },
    });
  }
  return failures;
}

/**
 * 사람용 렌더링 (ac-11): "어느 여정의 어느 단계에서 무엇을 기대했는데 무엇이
 * 나왔다" 한 문장 + 재생 수단(headed 재실행 명령, trace 뷰어).
 */
export function renderFailureLines(failure: E2eFailure, journeyName?: string): string[] {
  const subject = journeyName ?? failure.journey_id;
  const where =
    failure.step_id !== undefined
      ? `단계 [${failure.step_id}]${failure.step_dsl_line ? ` ${failure.step_dsl_line}` : ''}`
      : `케이스 ${failure.case_name}`;
  const what =
    failure.expected !== undefined && failure.actual !== undefined
      ? `${failure.expected}를 기대했지만 ${failure.actual}가 나왔다`
      : `실패 — ${failure.message.split('\n')[0]}`;
  const lines = [
    `여정 ${subject}의 ${where}에서 ${what}`,
    `  케이스: ${failure.case_name} (${failure.spec_file})`,
    `  재생(headed): ${failure.replay.headed_command}`,
  ];
  lines.push(
    failure.replay.trace_command !== undefined
      ? `  trace 뷰어: ${failure.replay.trace_command}`
      : '  trace 뷰어: 이번 실행에는 trace가 없다 — 재실행 명령에 --trace on을 붙이면 npx playwright show-trace <trace.zip>으로 장면을 볼 수 있다',
  );
  return lines;
}
