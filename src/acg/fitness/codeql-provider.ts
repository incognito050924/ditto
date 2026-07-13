/**
 * CodeQL → FitnessFunction deterministic provider (단계8, 남은 일 #3).
 *
 * Bridges the existing CodeQL SARIF parser to the fitness runner's violation
 * model: each finding becomes a STABLE violation identity so delta_only can tell
 * a newly-introduced violation from legacy debt.
 *
 *   SARIF text → parseSarif → CodeqlFinding[] → normalizeViolationIdentity → ids
 *
 * IDENTITY (OBJ-11): the key is `rule@path#site` with the raw LINE deliberately
 * excluded (a line move must not read as a new violation). A parsed CodeqlFinding
 * carries no enclosing symbol, so `site` falls back to `<top>`; the consequence
 * is that several findings of the same rule in the same file collapse to one
 * identity. That is the CONSERVATIVE direction — it under-counts new violations
 * rather than flagging line noise — and is acceptable for the v0 binding. A
 * future binding can enrich the finding with an enclosing symbol to split them.
 */
import { type CodeqlFinding, parseSarif } from '~/core/codeql/sarif';
import { type RawViolation, normalizeViolationIdentity } from './fitness-runner';

/** A CodeQL finding as the fitness runner's RawViolation (rule + path; no line). */
export function codeqlFindingToViolation(f: CodeqlFinding): RawViolation {
  return { rule: f.ruleId, ...(f.file != null ? { path: f.file } : {}) };
}

/** CodeqlFinding[] → the deduplicated normalized violation-identity set. */
export function sarifFindingsToViolationIds(findings: CodeqlFinding[]): string[] {
  return [...new Set(findings.map((f) => normalizeViolationIdentity(codeqlFindingToViolation(f))))];
}

/** Parse a SARIF document and project it to the fitness violation-identity set. */
export function sarifToViolationIds(sarifText: string): string[] {
  return sarifFindingsToViolationIds(parseSarif(sarifText));
}
