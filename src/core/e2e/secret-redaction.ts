/**
 * Secret/PII redaction for the E2E DSL→plan→spec pipeline (wi_2607026qs, Contract 6).
 *
 * Indirection invariant: credentials only ever enter the pipeline as env:VAR /
 * secret:VAR references; the literal value lives in process.env and is read at
 * runtime. These pure functions keep git-tracked artifacts (specs/*.plan.md,
 * e2e/generated/*.spec.ts) secret-free:
 *  - redactForPlan replaces any known secret VALUE that leaked into text with
 *    its reference placeholder (`<env:VAR>` / `<secret:VAR>`), recording each hit.
 *  - assertNoPlaintextSecret is the fail-closed guard run before writing those
 *    artifacts: it throws if any known secret value still appears literally.
 */

export interface RedactionRule {
  /** DSL secret_vars columns (VAR names) whose bound value must be masked. */
  secretVars: string[];
  /** auth.credentials refs, always env:VAR or secret:VAR. */
  credentialRefs: string[];
  /** Known secret values keyed by VAR name (e.g. a snapshot of process.env). */
  envValues: Record<string, string>;
}

export interface RedactionRecord {
  /** VAR name whose value was masked. */
  field: string;
  /** Placeholder written in place of the value. */
  ref: string;
  /** Index in the emitted text where the (first) replacement occurred. */
  location: number;
}

export interface RedactForPlanResult {
  text: string;
  redactions: RedactionRecord[];
}

const CRED_REF = /^(env|secret):(.+)$/;

/** Ordered (varName, placeholder) targets from secretVars + credentialRefs. */
function collectTargets(rule: RedactionRule): Map<string, string> {
  const targets = new Map<string, string>();
  for (const varName of rule.secretVars) {
    targets.set(varName, `<env:${varName}>`);
  }
  for (const ref of rule.credentialRefs) {
    const match = CRED_REF.exec(ref);
    if (!match) continue;
    const [, scheme = '', varName = ''] = match;
    targets.set(varName, `<${scheme}:${varName}>`);
  }
  return targets;
}

/**
 * Replace any known secret value that leaked into `text` with its reference
 * placeholder. Non-secret text passes through unchanged (empty redactions).
 */
export function redactForPlan(text: string, rule: RedactionRule): RedactForPlanResult {
  const redactions: RedactionRecord[] = [];
  let out = text;

  for (const [varName, placeholder] of collectTargets(rule)) {
    const value = rule.envValues[varName];
    if (!value) continue;
    const location = out.indexOf(value);
    if (location === -1) continue;
    out = out.split(value).join(placeholder);
    redactions.push({ field: varName, ref: placeholder, location });
  }

  return { text: out, redactions };
}

/**
 * Fail-closed guard: throw if any known secret value (rule.envValues) appears
 * literally in `text`. The thrown message names the leaking field but never
 * echoes the secret value itself.
 */
export function assertNoPlaintextSecret(text: string, rule: RedactionRule): void {
  for (const [varName, value] of Object.entries(rule.envValues)) {
    if (!value) continue;
    if (text.includes(value)) {
      throw new Error(
        `Plaintext secret detected: the value bound to ${varName} appears literally in the output (fail-closed; redact via redactForPlan before writing git-tracked artifacts).`,
      );
    }
  }
}
