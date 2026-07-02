import type { JourneyFrontMatter } from '~/schemas/journey-dsl';
import { type RedactionRecord, assertNoPlaintextSecret, redactForPlan } from './secret-redaction';

/**
 * Deterministic DSL v2 → Playwright plan.md adapter (wi_2607026qs, Contract 2).
 *
 * `projectJourneyToPlan` RE-SERIALIZES a human-authored journey (front-matter +
 * structural body) into the official Playwright test-plan markdown that the
 * generator agent consumes. It never resolves selectors or synthesizes
 * assertions (ADR-0014 boundary) — it only projects the DSL and injects a
 * traceability sidecar (`PlanStepMap`) that joins each numbered plan Step to its
 * DSL step id (sN / inlined block bN). Secrets are kept out of the git-tracked
 * plan: `secret_vars` column values / auth credentials / secret seed data are
 * routed through `redactForPlan` (→ `<env:VAR>`), and `assertNoPlaintextSecret`
 * is the fail-closed guard run on the final text before it is returned.
 */

/** planStepN → DSL step id ("s1" | inlined block "b1"), per scenario per case. */
export type PlanStepMap = {
  [scenarioNo: number]: { [caseName: string]: { [planStepN: number]: string } };
};

/**
 * Ordered `확인:` (assertion) DSL step ids per scenario per case. Assertions are
 * projected to Expected Results (not the numbered Steps map), so they get their
 * own channel: the post-pass reads it to mark each `expect(...)` line the
 * generator emits, keeping ALL step ids — action AND assertion — traceable.
 */
export type PlanAssertionMap = {
  [scenarioNo: number]: { [caseName: string]: string[] };
};

export interface ProjectJourneyInput {
  journey: JourneyFrontMatter;
  body: string;
  /** blockId → block body (for `블록:` inlining). */
  blocks?: Record<string, { body: string }>;
  sourcePath: string;
  digest: string;
  /** Runtime resolver for `{var}` placeholders / secret values (best-effort). */
  resolveVar?: (varName: string) => string | undefined;
}

export interface ProjectJourneyResult {
  plan: string;
  map: PlanStepMap;
  /** Parallel channel of ordered `확인:` step ids per scenario/case (Expected Results). */
  assertions: PlanAssertionMap;
  redactions: RedactionRecord[];
}

interface ParsedStep {
  id: string;
  condition?: string | undefined;
  verb: string;
  object: string;
}

interface CaseTable {
  names: string[];
  rows: Record<string, Record<string, string>>;
}

const stepLine = /^\s*\d+\.\s+\[([sb]\d+)\]\s*(?:\(([^)]*)\)\s*)?(.*\S)?\s*$/;
const CRED_REF = /^(env|secret):(.+)$/;

/** Parse a DSL body into ordered steps: `N. [sN] (조건)? <동사>: <목적어>`. */
function parseSteps(body: string): ParsedStep[] {
  const steps: ParsedStep[] = [];
  for (const line of body.split('\n')) {
    const m = stepLine.exec(line);
    if (!m?.[1]) continue;
    const rest = (m[3] ?? '').trim();
    const colon = rest.indexOf(':');
    const verb = colon >= 0 ? rest.slice(0, colon).trim() : '';
    const object = colon >= 0 ? rest.slice(colon + 1).trim() : rest;
    steps.push({ id: m[1], condition: m[2]?.trim() || undefined, verb, object });
  }
  return steps;
}

/** Parse the `## 케이스` table into ordered case names + per-case column values. */
function parseCaseTable(body: string): CaseTable {
  const lines = body.split('\n');
  const start = lines.findIndex((l) => /^##\s*케이스\s*$/.test(l.trim()));
  if (start < 0) return { names: [], rows: {} };
  const names: string[] = [];
  const rows: Record<string, Record<string, string>> = {};
  let columns: string[] = [];
  let sawHeader = false;
  for (let i = start + 1; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim();
    if (line.startsWith('#')) break;
    if (!line.startsWith('|')) {
      if (names.length > 0 || sawHeader) break;
      if (line === '') continue;
      break;
    }
    if (/^\|[\s\-:|]+\|?$/.test(line)) continue; // separator row
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    if (!sawHeader) {
      sawHeader = true;
      columns = cells;
      continue;
    }
    const caseName = cells[0];
    if (!caseName) continue;
    names.push(caseName);
    const row: Record<string, string> = {};
    columns.forEach((col, idx) => {
      row[col] = cells[idx] ?? '';
    });
    rows[caseName] = row;
  }
  return { names, rows };
}

/** Apply v1 condition semantics: 없음 condition → always active. */
function stepActiveInCase(
  condition: string | undefined,
  caseName: string,
  caseRow: Record<string, string>,
): boolean {
  if (!condition) return true;
  const caseMatch = /^케이스\s*:\s*(.+)$/.exec(condition);
  if (caseMatch) return caseMatch[1]?.trim() === caseName;
  const presence = /^(.+?)\s*(있음|없음)$/.exec(condition);
  if (presence) {
    const val = caseRow[presence[1]?.trim() ?? ''];
    const present = val !== undefined && val.trim() !== '';
    return presence[2] === '있음' ? present : !present;
  }
  return true; // unknown parenthetical is a note, not a filter
}

/** Substitute `{var}` with its literal case value (redaction happens later). */
function substituteVars(
  text: string,
  caseRow: Record<string, string>,
  secretVars: string[],
  resolveVar?: (v: string) => string | undefined,
): string {
  return text.replace(/\{([^}]+)\}/g, (_m, raw) => {
    const key = String(raw).trim();
    let value: string | undefined = caseRow[key];
    if (value === undefined || value === '') value = resolveVar?.(key);
    if (value === undefined || value === '') {
      // Unresolvable: never risk a literal for a declared secret.
      return secretVars.includes(key) ? `<env:${key}>` : `{${key}}`;
    }
    return value;
  });
}

/** Distinct non-empty literal values a secret column takes across all cases. */
function distinctColumnValues(
  col: string,
  table: CaseTable,
  resolveVar?: (v: string) => string | undefined,
): string[] {
  const set = new Set<string>();
  for (const name of table.names) {
    const v = table.rows[name]?.[col];
    if (v && v.trim() !== '') set.add(v);
  }
  const rv = resolveVar?.(col);
  if (rv) set.add(rv);
  return [...set];
}

/**
 * Project a DSL v2 journey into the official Playwright plan markdown, a
 * plan-step→DSL-step sidecar map, and the redaction record.
 */
export function projectJourneyToPlan(input: ProjectJourneyInput): ProjectJourneyResult {
  const { journey, body, sourcePath, digest, resolveVar } = input;
  const blocks = input.blocks ?? {};
  const secretVars = journey.secret_vars;
  const table = parseCaseTable(body);
  const steps = parseSteps(body);
  const seedRef = journey.seed?.spec_ref ?? 'e2e/seed.spec.ts';
  const map: PlanStepMap = {};
  const assertions: PlanAssertionMap = {};

  const out: string[] = [];
  out.push(`# ${journey.name} Test Plan`);
  out.push(`<!-- @ditto-plan v1 · source: ${sourcePath} · digest: ${digest} -->`);
  out.push('');
  out.push('## Application Overview');
  out.push('');
  out.push(journey.implementation_intent);

  const bullets: string[] = [...journey.constraints];
  if (journey.seed) bullets.push(`Precondition: run \`${seedRef}\``);
  if (journey.initial_state) {
    const s = journey.initial_state;
    bullets.push(`Precondition: ${s.description}${s.setup_ref ? ` (run \`${s.setup_ref}\`)` : ''}`);
  }
  if (journey.auth) {
    if (journey.auth.login_block) {
      bullets.push(`Precondition: run \`${journey.auth.login_block}\` (authentication)`);
    } else {
      const roles = Object.keys(journey.auth.credentials);
      if (roles.length) bullets.push(`Precondition: authenticate as ${roles.join(', ')}`);
    }
  }
  if (bullets.length) {
    out.push('');
    out.push('**Constraints:**');
    for (const b of bullets) out.push(`- ${b}`);
  }

  out.push('');
  out.push('## Test Scenarios');

  let scenarioNo = 0;

  // Scenario 1: the body journey, one #### per case.
  scenarioNo += 1;
  const scenarioMap: { [caseName: string]: { [planStepN: number]: string } } = {};
  const scenarioAssertions: { [caseName: string]: string[] } = {};
  map[scenarioNo] = scenarioMap;
  assertions[scenarioNo] = scenarioAssertions;
  out.push('');
  out.push(`### ${scenarioNo}. ${journey.name}`);
  out.push(`**Seed:** \`${seedRef}\``);
  const cases = table.names.length ? table.names : ['기본'];
  cases.forEach((caseName, ci) => {
    const caseRow = table.rows[caseName] ?? {};
    const caseMap: { [planStepN: number]: string } = {};
    const assertIds: string[] = [];
    scenarioMap[caseName] = caseMap;
    scenarioAssertions[caseName] = assertIds;
    const stepLines: string[] = [];
    const expected: string[] = [];
    let planStepN = 0;

    const emitAction = (id: string, verb: string, obj: string) => {
      planStepN += 1;
      stepLines.push(`${planStepN}. ${verb}: ${obj}`);
      caseMap[planStepN] = id;
    };
    const emitAssertion = (id: string, obj: string) => {
      expected.push(obj);
      assertIds.push(id);
    };

    for (const step of steps) {
      if (!stepActiveInCase(step.condition, caseName, caseRow)) continue;
      if (step.verb === '블록') {
        for (const bstep of parseSteps(blocks[step.object]?.body ?? '')) {
          const obj = substituteVars(bstep.object, caseRow, secretVars, resolveVar);
          if (bstep.verb === '확인') emitAssertion(bstep.id, obj);
          else emitAction(bstep.id, bstep.verb, obj);
        }
        continue;
      }
      const obj = substituteVars(step.object, caseRow, secretVars, resolveVar);
      if (step.verb === '확인') emitAssertion(step.id, obj);
      else emitAction(step.id, step.verb, obj);
    }

    out.push('');
    out.push(`#### ${scenarioNo}.${ci + 1} ${caseName}`);
    out.push('**Steps:**');
    for (const l of stepLines) out.push(l);
    out.push('');
    out.push('**Expected Results:**');
    for (const e of expected) out.push(`- ${e}`);
  });

  // One ### scenario per edge_case (Expected = handling). No DSL step ids here,
  // so the assertion channel stays empty — kept for structural parity with map.
  for (const edge of journey.edge_cases) {
    scenarioNo += 1;
    map[scenarioNo] = { 기본: {} };
    assertions[scenarioNo] = { 기본: [] };
    out.push('');
    out.push(`### ${scenarioNo}. ${edge.case}`);
    out.push(`**Seed:** \`${seedRef}\``);
    out.push('');
    out.push(`#### ${scenarioNo}.1 기본`);
    out.push('**Steps:**');
    out.push(`1. ${edge.case}`);
    out.push('');
    out.push('**Expected Results:**');
    out.push(`- ${edge.handling}`);
  }

  // One ### scenario per failure_state (Expected = expected error). No DSL step
  // ids here either — empty assertion channel, structural parity with map.
  for (const fs of journey.failure_states) {
    scenarioNo += 1;
    map[scenarioNo] = { 기본: {} };
    assertions[scenarioNo] = { 기본: [] };
    out.push('');
    out.push(`### ${scenarioNo}. ${fs.trigger}`);
    out.push(`**Seed:** \`${seedRef}\``);
    out.push('');
    out.push(`#### ${scenarioNo}.1 기본`);
    out.push('**Steps:**');
    out.push(`1. ${fs.trigger}`);
    out.push('');
    out.push('**Expected Results:**');
    out.push(`- ${fs.expected}`);
  }

  let plan = `${out.join('\n')}\n`;

  // Redaction: route every known secret literal through redactForPlan (→ <env:VAR>).
  const credRefs = Object.values(journey.auth?.credentials ?? {});
  const seedDataRef = journey.seed?.data_ref;
  const seedSecretRef = seedDataRef && CRED_REF.test(seedDataRef) ? seedDataRef : undefined;
  const envRefs = [...credRefs, ...(seedSecretRef ? [seedSecretRef] : [])];
  const redactions: RedactionRecord[] = [];

  for (const col of secretVars) {
    for (const value of distinctColumnValues(col, table, resolveVar)) {
      const r = redactForPlan(plan, {
        secretVars: [col],
        credentialRefs: [],
        envValues: { [col]: value },
      });
      plan = r.text;
      redactions.push(...r.redactions);
    }
  }
  for (const ref of envRefs) {
    const key = CRED_REF.exec(ref)?.[2];
    if (!key) continue;
    const value = resolveVar?.(key);
    if (!value) continue;
    const r = redactForPlan(plan, {
      secretVars: [],
      credentialRefs: [ref],
      envValues: { [key]: value },
    });
    plan = r.text;
    redactions.push(...r.redactions);
  }

  // Fail-closed guard on the final text: no known secret literal may remain.
  const guardEnv: Record<string, string> = {};
  let gi = 0;
  for (const col of secretVars) {
    for (const value of distinctColumnValues(col, table, resolveVar)) {
      guardEnv[`${col}#${gi++}`] = value;
    }
  }
  for (const ref of envRefs) {
    const key = CRED_REF.exec(ref)?.[2];
    if (!key) continue;
    const value = resolveVar?.(key);
    if (value) guardEnv[key] = value;
  }
  assertNoPlaintextSecret(plan, { secretVars, credentialRefs: envRefs, envValues: guardEnv });

  return { plan, map, assertions, redactions };
}
