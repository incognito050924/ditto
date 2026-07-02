import {
  type AssertionDslForm,
  type AssertionMap,
  type AssertionMapEntry,
  type AssertionStrength,
  assertionMap,
} from '~/schemas/e2e-assertion-map';
import { type RedactionRule, redactForPlan } from './secret-redaction';

/**
 * Assertion mapping (wi_2607026qs, Contract 4 / ac-6).
 *
 * buildAssertionMap classifies, DETERMINISTICALLY, how faithfully the
 * generator's emitted Playwright matcher reproduces each DSL `확인:` (confirm)
 * assertion. It is a pure post-pass over the DSL body + the generated spec's
 * `// @step <journey-id>/sN` marker regions (the sidecar N→sN join is already
 * baked into the markers by the post-pass, Contract 3). No selectors or
 * semantics are synthesised — only observed matchers are compared to declared
 * forms, so ADR-0014 D1 is untouched.
 *
 * Both the DSL text and the emitted assertion are redacted (Contract 6) before
 * they enter the map, because the JSON and the derived human doc are read and
 * git-committed.
 */

export interface BuildAssertionMapInput {
  /** Journey id (jrn-…) whose confirm steps are being mapped. */
  journeyId: string;
  /** The DSL body (structural markdown) — source of the 확인 steps. */
  journeyBody: string;
  /** The generated Playwright spec text with `// @step` markers. */
  generatedSpec: string;
  /** Work item the map is built for. */
  workItemId: string;
  /** Repo-relative path of the generated spec (recorded as generated_spec). */
  generatedSpecPath: string;
  /** Redaction rule; when absent, an empty (no-secret) rule is used. */
  rule?: RedactionRule;
}

const EMPTY_RULE: RedactionRule = { secretVars: [], credentialRefs: [], envValues: {} };

/** A `확인:` step line: `N. [sN] (조건)? 확인: <target>`. */
const confirmLine = /^\s*\d+\.\s+\[([sb]\d+)\]\s*(?:\([^)]*\)\s*)?확인:\s*(.+?)\s*$/;

/** Generated-spec marker (mirrors journey-dsl.ts): `// @step <owner>/<step-id>`. */
const markerLine = /^\s*\/\/\s*@step\s+(\S+\/[sb]\d+)\b/;

interface ConfirmStep {
  stepId: string;
  /** null when no form keyword is present (unclassifiable → forced unmapped). */
  form: AssertionDslForm | null;
  target: string;
}

/**
 * Placeholder dsl_form for an UNCLASSIFIABLE 확인 step. The schema requires one
 * of the five enum values, but such a step is forced to strength `unmapped` with
 * an explaining note, so this value is only a schema placeholder — it never
 * claims the author meant `present`.
 */
const UNCLASSIFIED_FORM: AssertionDslForm = 'present';

/**
 * Classify a 확인 target into one of the five DSL forms by locating its form
 * KEYWORD as a whole word — in EITHER order: keyword-first (`contains X`,
 * `visible ...`) or target-first (`"대시보드" visible`, `"총 결제금액" contains
 * 9,000원`). `url contains` is checked before `contains` because its keyword is a
 * superset. Returns null when no form keyword is present (free sentence).
 */
function detectForm(target: string): AssertionDslForm | null {
  const t = target.trim();
  if (/\burl[\s-]+contains\b/.test(t)) return 'url-contains';
  if (/\bcontains\b/.test(t)) return 'contains';
  if (/\bvisible\b/.test(t)) return 'visible';
  if (/\bhidden\b/.test(t)) return 'hidden';
  if (/\bpresent\b/.test(t)) return 'present';
  return null;
}

/**
 * Extract the ordered 확인 steps from a DSL body. Every 확인 step is kept —
 * including ones whose form cannot be classified (form=null) — so no assertion
 * is ever silently dropped; buildAssertionMap records the unclassifiable ones as
 * `unmapped` (a visible hard fail, not a vacuous pass).
 */
function extractConfirmSteps(body: string): ConfirmStep[] {
  const steps: ConfirmStep[] = [];
  for (const line of body.split('\n')) {
    const m = confirmLine.exec(line);
    if (!m) continue;
    const [, stepId = '', target = ''] = m;
    steps.push({ stepId, form: detectForm(target), target: target.trim() });
  }
  return steps;
}

/** Index of the `)` matching the `(` at openIdx (balanced); -1 if unbalanced. */
function matchBalanced(text: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

interface EmittedExpect {
  statement: string;
  matcher: string;
  matcherArg: string;
}

/**
 * Extract the first `expect(...).<matcher>(...)` assertion in a step region,
 * using balanced-paren scanning so a locator arg's own parens do not confuse the
 * matcher lookup. Returns null when the region contains no expect assertion.
 */
function extractExpect(region: string): EmittedExpect | null {
  const kw = /(?:await\s+)?expect\s*\(/.exec(region);
  if (!kw) return null;
  const expectIdx = region.indexOf('expect', kw.index);
  const argOpen = region.indexOf('(', expectIdx);
  const argClose = matchBalanced(region, argOpen);
  if (argClose < 0) return null;

  const rest = region.slice(argClose + 1);
  const chain = /^\s*(?:\.\s*not\s*)?\.\s*([A-Za-z][A-Za-z0-9]*)\s*\(/.exec(rest);
  if (!chain) return null;
  const matcher = chain[1] ?? '';
  const matcherOpen = chain[0].length - 1; // the trailing '(' of the match
  const matcherClose = matchBalanced(rest, matcherOpen);
  if (matcherClose < 0) return null;

  const matcherArg = rest.slice(matcherOpen + 1, matcherClose).trim();
  const statement = region.slice(expectIdx, argClose + 1 + matcherClose + 1).trim();
  return { statement, matcher, matcherArg };
}

/** Deterministic strength classification: declared form vs emitted matcher. */
function classify(
  form: AssertionDslForm,
  matcher: string,
  matcherArg: string,
): { strength: AssertionStrength; note?: string } {
  const isRegexArg = matcherArg.startsWith('/');
  switch (form) {
    case 'contains':
      if (matcher === 'toContainText') return { strength: 'exact' };
      if (matcher === 'toBeVisible')
        return {
          strength: 'weaker',
          note: 'DSL contains asserts text; emitted only checks visibility',
        };
      if (matcher === 'toHaveText')
        return {
          strength: 'stronger',
          note: 'DSL contains (substring); emitted asserts exact text equality',
        };
      return {
        strength: 'weaker',
        note: `emitted ${matcher} does not reproduce contains semantics`,
      };
    case 'visible':
      if (matcher === 'toBeVisible') return { strength: 'exact' };
      return { strength: 'weaker', note: `DSL visible; emitted ${matcher} is weaker` };
    case 'hidden':
      if (matcher === 'toBeHidden') return { strength: 'exact' };
      return { strength: 'weaker', note: `DSL hidden; emitted ${matcher} is weaker` };
    case 'present':
      if (matcher === 'toBeAttached' || matcher === 'toHaveCount') return { strength: 'exact' };
      return { strength: 'weaker', note: `DSL present; emitted ${matcher} is weaker` };
    case 'url-contains':
      if (matcher === 'toHaveURL') {
        if (isRegexArg) return { strength: 'exact' };
        return {
          strength: 'stronger',
          note: 'DSL url contains (substring); emitted asserts an exact URL',
        };
      }
      return { strength: 'weaker', note: `DSL url contains; emitted ${matcher} is weaker` };
  }
}

/** Build the region text for one `<journeyId>/<stepId>` marker, or null. */
function regionFor(
  markers: { idx: number; ref: string }[],
  lines: string[],
  ref: string,
): string | null {
  const mi = markers.findIndex((m) => m.ref === ref);
  const startMarker = mi < 0 ? undefined : markers[mi];
  if (!startMarker) return null;
  const startLine = startMarker.idx + 1;
  const nextMarker = markers[mi + 1];
  const endLine = nextMarker ? nextMarker.idx : lines.length;
  return lines.slice(startLine, endLine).join('\n');
}

/**
 * Build the assertion map for one journey against its generated spec. Pure and
 * deterministic. `unmapped_count > 0` is the caller's hard-fail signal (see
 * assertionMapGate); `weakened_count > 0` flags for surfacing.
 */
export function buildAssertionMap(input: BuildAssertionMapInput): AssertionMap {
  const rule = input.rule ?? EMPTY_RULE;
  const redact = (text: string): string => redactForPlan(text, rule).text;

  const lines = input.generatedSpec.split('\n');
  const markers: { idx: number; ref: string }[] = [];
  lines.forEach((l, i) => {
    const m = markerLine.exec(l);
    if (m) markers.push({ idx: i, ref: m[1] ?? '' });
  });

  const entries: AssertionMapEntry[] = [];
  for (const step of extractConfirmSteps(input.journeyBody)) {
    const region = regionFor(markers, lines, `${input.journeyId}/${step.stepId}`);
    const emitted = region == null ? null : extractExpect(region);

    let strength: AssertionStrength;
    let note: string | undefined;
    let emittedMatcher = '';
    let emittedAssertion = '';

    if (step.form == null) {
      // Unclassifiable confirm form (free sentence / keyword absent). Never
      // dropped: recorded as unmapped so unmapped_count > 0 hard-fails the gate.
      strength = 'unmapped';
      note = 'unrecognised 확인 form — no contains/visible/hidden/present/url-contains keyword';
    } else if (!emitted) {
      strength = 'unmapped';
      note =
        region == null
          ? 'no @step marker for this confirm step in the generated spec'
          : 'no expect(...) assertion found in the step region';
    } else {
      const c = classify(step.form, emitted.matcher, emitted.matcherArg);
      strength = c.strength;
      note = c.note;
      emittedMatcher = emitted.matcher;
      emittedAssertion = redact(emitted.statement);
    }

    entries.push({
      journey_id: input.journeyId,
      step_id: step.stepId,
      dsl_assertion: redact(step.target),
      dsl_form: step.form ?? UNCLASSIFIED_FORM,
      emitted_assertion: emittedAssertion,
      emitted_matcher: emittedMatcher,
      strength,
      flag: strength !== 'exact',
      ...(note ? { note } : {}),
    });
  }

  return assertionMap.parse({
    schema_version: '0.1.0',
    work_item_id: input.workItemId,
    journey_id: input.journeyId,
    generated_spec: input.generatedSpecPath,
    entries,
    weakened_count: entries.filter((e) => e.strength === 'weaker').length,
    unmapped_count: entries.filter((e) => e.strength === 'unmapped').length,
  });
}

/** Escape a value for a markdown table cell (no `|`, single line). */
function cell(text: string): string {
  const t = text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
  return t === '' ? '—' : t;
}

/**
 * Render the human review doc (git-tracked, redacted): a table of every confirm
 * step and a `## 검토 필요` list of the flagged rows. Reading it cannot be
 * forced — the residual is honest per Contract 4.
 */
export function renderAssertionMapDoc(map: AssertionMap): string {
  const strengthLabel: Record<AssertionStrength, string> = {
    exact: 'exact',
    weaker: 'weaker',
    stronger: 'stronger',
    unmapped: 'unmapped',
  };

  const out: string[] = [];
  out.push(`# Assertion map — ${map.journey_id}`);
  out.push('');
  out.push(`Generated spec: \`${map.generated_spec}\``);
  out.push(
    `Weakened: ${map.weakened_count} · Unmapped: ${map.unmapped_count} (unmapped > 0 → 게이트 하드 실패)`,
  );
  out.push('');
  out.push('| 여정·단계 | DSL확인 | 형 | 실제 assertion | matcher | 강도 | ⚠검토 |');
  out.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const e of map.entries) {
    out.push(
      `| ${cell(`${e.journey_id}/${e.step_id}`)} | ${cell(e.dsl_assertion)} | ${cell(e.dsl_form)} | ${cell(e.emitted_assertion)} | ${cell(e.emitted_matcher)} | ${cell(strengthLabel[e.strength])} | ${e.flag ? '⚠' : ''} |`,
    );
  }

  out.push('');
  out.push('## 검토 필요');
  const flagged = map.entries.filter((e) => e.flag);
  if (flagged.length === 0) {
    out.push('없음');
  } else {
    for (const e of flagged) {
      out.push(`- \`${e.journey_id}/${e.step_id}\` (${e.strength}) — ${e.note ?? e.dsl_assertion}`);
    }
  }
  out.push('');
  return out.join('\n');
}

export interface AssertionMapGateResult {
  /** True when any assertion was dropped (unmapped_count > 0) → non-zero exit. */
  hardFail: boolean;
  /** True when any entry is flagged (weakened / strengthened / unmapped). */
  flagged: boolean;
  /** Human-facing reason for the gate outcome. */
  reason: string;
}

/**
 * Gate helper: `unmapped_count > 0` is a hard-fail (caller exits non-zero); any
 * flagged entry is surfaced but does not by itself fail the gate.
 */
export function assertionMapGate(map: AssertionMap): AssertionMapGateResult {
  const hardFail = map.unmapped_count > 0;
  const flagged = map.entries.some((e) => e.flag);
  const reason = hardFail
    ? `${map.unmapped_count} DSL assertion(s) dropped (unmapped) — hard fail`
    : map.weakened_count > 0
      ? `${map.weakened_count} assertion(s) weakened — review required, gate passes`
      : flagged
        ? 'assertions strengthened — review required, gate passes'
        : 'all assertions map exactly';
  return { hardFail, flagged, reason };
}
