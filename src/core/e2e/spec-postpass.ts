import { type GeneratedHeaderInput, renderGeneratedHeader } from './journey-digest';
import { extractStepMarkers, splitFrontMatter } from './journey-dsl';
import type { PlanAssertionMap, PlanStepMap } from './plan-adapter';

export type { PlanAssertionMap, PlanStepMap };

/**
 * Generated-spec post-pass (wi_2607026qs, Contract 3 / ac-4).
 *
 * The official playwright-test-generator emits a plain spec whose steps it
 * documents with `// N.` comments (per case, restarting at 1). This pass makes
 * that spec DITTO-traceable WITHOUT re-interpreting any semantics:
 *  1. prepend the provenance header (@ditto-generated + source + digest);
 *  2. above each `// N.` comment inject a `// @step <journeyId>/sN <DSL 원문>`
 *     marker — resolving N→sN through the plan SIDECAR map, never by matching
 *     the comment text (stability countermeasure: generator prose may drift, the
 *     sidecar join does not);
 *  3. self-verify by re-extracting the markers and reporting any journey step id
 *     that got no marker in `unmatched` so the caller exits non-zero (fail loud,
 *     never commit a non-conformant spec).
 *
 * DESIGN BOUNDARY: this pass re-serialises human DSL + injects traceability; it
 * resolves no selectors and synthesises no assertions (ADR-0014 D1/D2 spirit).
 */

export interface InjectDittoMarkersInput {
  /** Raw spec text from the generator (plain `// N.` comments, no header). */
  generated: string;
  /** Journey id — the owner prefix of every `// @step` marker. */
  journeyId: string;
  /** Provenance header input; header.digest = computeSourceDigest(dslOriginal). */
  header: GeneratedHeaderInput;
  /** Plan sidecar join: scenario → case → plan-step-N → DSL step id. */
  planMap: PlanStepMap;
  /**
   * Parallel assertion channel: scenario → case → ordered `확인:` step ids. Each
   * `expect(...)` line in a case is marked with the next id from this channel
   * (the generator emits Expected Results as bare expects, without a `// N.`
   * comment, so they cannot be resolved through planMap). Optional — a plan with
   * no `확인:` steps omits it and only numbered action steps get markers.
   */
  assertions?: PlanAssertionMap;
  /** The journey DSL text — source of the marker's DSL 원문 and the required set. */
  dslOriginal: string;
}

export interface InjectDittoMarkersResult {
  /** The post-passed spec: provenance header + injected @step markers. */
  spec: string;
  /** How many `// @step` markers were injected. */
  injected: number;
  /** Journey step refs (`<journeyId>/sN`) that got no marker — caller fails loud. */
  unmatched: string[];
}

/** One resolved plan cell: plan-step-N → DSL step id. */
type PlanCell = Record<string, string>;

/** Generator step comment: `// N. <text>` (leading indentation captured). */
const genStepComment = /^(\s*)\/\/\s*(\d+)\.\s/;
/** Opener of a test block, carrying the scenario/case title. */
const testOpener = /\btest(?:\.describe)?\s*\(\s*(['"`])(.*?)\1/;
/** DSL step line: `N. [sN] <rest>` — rest is the DSL 원문 for the marker. */
const dslStepLine = /^\s*\d+\.\s+\[([sb]\d+)\]\s*(.*)$/;
/** An assertion line the generator emitted for an Expected Result (`expect(...)`). */
const assertionLine = /\bexpect\s*\(/;

/** Collapse newlines to spaces + trim so the DSL text is safe inside a `//` line. */
function collapseForComment(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').trim();
}

/** Map each journey step id (sN) to its DSL 원문 (the text after `[sN]`). */
function buildDslTextMap(dslOriginal: string): Map<string, string> {
  const body = splitFrontMatter(dslOriginal)?.body ?? dslOriginal;
  const map = new Map<string, string>();
  for (const line of body.split('\n')) {
    const m = dslStepLine.exec(line);
    if (m?.[1]) map.set(m[1], collapseForComment(m[2] ?? ''));
  }
  return map;
}

/** The plan cell whose case name appears in the test title, if any. */
function findCellByTitle(planMap: PlanStepMap, title: string): PlanCell | undefined {
  for (const scenario of Object.values(planMap)) {
    for (const [caseName, cell] of Object.entries(scenario)) {
      if (title.includes(caseName)) return cell;
    }
  }
  return undefined;
}

/** The only cell when the plan has exactly one scenario with one case. */
function soleCell(planMap: PlanStepMap): PlanCell | undefined {
  const scenarios = Object.values(planMap);
  if (scenarios.length !== 1) return undefined;
  const cases = Object.values(scenarios[0] ?? {});
  return cases.length === 1 ? cases[0] : undefined;
}

/** The ordered assertion ids whose case name appears in the test title, if any. */
function findAssertionsByTitle(assertions: PlanAssertionMap, title: string): string[] | undefined {
  for (const scenario of Object.values(assertions)) {
    for (const [caseName, ids] of Object.entries(scenario)) {
      if (title.includes(caseName)) return ids;
    }
  }
  return undefined;
}

/** The only assertion list when the plan has exactly one scenario with one case. */
function soleAssertions(assertions: PlanAssertionMap): string[] | undefined {
  const scenarios = Object.values(assertions);
  if (scenarios.length !== 1) return undefined;
  const cases = Object.values(scenarios[0] ?? {});
  return cases.length === 1 ? cases[0] : undefined;
}

export function injectDittoMarkers(input: InjectDittoMarkersInput): InjectDittoMarkersResult {
  const { generated, journeyId, header, planMap, assertions, dslOriginal } = input;
  const dslText = buildDslTextMap(dslOriginal);
  const fallback = soleCell(planMap);
  const assertFallback = assertions ? soleAssertions(assertions) : undefined;

  const marker = (indent: string, stepId: string): string => {
    const text = dslText.get(stepId) ?? '';
    return `${indent}// @step ${journeyId}/${stepId}${text ? ` ${text}` : ''}`;
  };

  // The plan cell the current `// N.` comments belong to. It advances whenever a
  // test-block title matches a case name; a single-cell plan uses the sole cell
  // throughout (the generator's title need not echo the case name).
  let cell = fallback;
  // Ordered `확인:` ids for the current case + a cursor consumed one-per-expect.
  let assertList = assertFallback ?? [];
  let assertIdx = 0;
  let injected = 0;
  const out: string[] = [];

  for (const line of generated.split('\n')) {
    const opener = testOpener.exec(line);
    if (opener) {
      const title = opener[2] ?? '';
      cell = findCellByTitle(planMap, title) ?? fallback ?? cell;
      if (assertions) assertList = findAssertionsByTitle(assertions, title) ?? assertFallback ?? [];
      assertIdx = 0;
    }

    const step = genStepComment.exec(line);
    if (step) {
      const stepId = cell?.[step[2] ?? ''];
      if (stepId) {
        out.push(marker(step[1] ?? '', stepId));
        injected++;
      }
      out.push(line);
      continue;
    }

    // Assertion channel: mark each generator `expect(...)` line with the next
    // pending `확인:` id (Expected Results carry no `// N.` comment to resolve).
    if (assertions && assertIdx < assertList.length && assertionLine.test(line)) {
      const indent = /^\s*/.exec(line)?.[0] ?? '';
      out.push(marker(indent, assertList[assertIdx++] ?? ''));
      injected++;
      out.push(line);
      continue;
    }

    out.push(line);
  }

  const spec = `${renderGeneratedHeader(header)}\n${out.join('\n')}`;

  // Self-verify: every journey step id declared in the DSL must now carry a
  // marker. Blocks are gated by checkStepConformance downstream (it holds the
  // block DSL this pass does not receive).
  const found = new Set(extractStepMarkers(spec));
  const unmatched = [...dslText.keys()]
    .map((id) => `${journeyId}/${id}`)
    .filter((ref) => !found.has(ref));

  return { spec, injected, unmatched };
}
