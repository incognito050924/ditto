/**
 * E2E assertion grammar for the capture runner (재설계 #2, 축3 어설션 자동평가).
 *
 * A journey assertion is mechanically checkable ONLY when it matches a known
 * predicate form. Free-text natural-language prose ("페이지에 X 텍스트가 보인다",
 * "redirected to dashboard") is NOT a CSS selector — the old runner ran
 * `locator(NL).count()`, which throws on an invalid selector and fabricates a
 * `fail`. classifyAssertion separates checkable predicates from the unverifiable
 * so the runner marks the latter `unverified` (honest "could not evaluate") rather
 * than asserting a contradiction it never observed (claim ≠ proof).
 *
 * Plain ESM (no deps) so it loads both under `node` (the spawned runner) and under
 * `bun` (the unit tests). The runner imports it as a sibling `./assertion.mjs`.
 */

/**
 * @typedef {{kind:'contains',selector:string,text:string}
 *   | {kind:'visible',selector:string}
 *   | {kind:'hidden',selector:string}
 *   | {kind:'present',selector:string}
 *   | {kind:'unverifiable'}} AssertionPlan
 * @param {string} description
 * @returns {AssertionPlan}
 */
export function classifyAssertion(description) {
  const d = String(description ?? '').trim();
  const contains = d.match(/^(.+?)\s+contains\s+(.+)$/i);
  if (contains) return { kind: 'contains', selector: contains[1].trim(), text: contains[2].trim() };
  const visible = d.match(/^(.+?)\s+visible$/i);
  if (visible) return { kind: 'visible', selector: visible[1].trim() };
  const hidden = d.match(/^(.+?)\s+hidden$/i);
  if (hidden) return { kind: 'hidden', selector: hidden[1].trim() };
  if (looksLikeSelector(d)) return { kind: 'present', selector: d };
  return { kind: 'unverifiable' };
}

/**
 * A bare CSS selector is a single whitespace-free token of selector characters
 * that starts with `#`/`.`/`[` or a lowercase tag letter. NL prose has spaces (and
 * usually capitalized/non-ascii words), so it never passes — that is the whole
 * point: prose is reported `unverified`, not run as a selector.
 * @param {string} s
 */
function looksLikeSelector(s) {
  if (!s || /\s/.test(s)) return false;
  if (!/^[#.[a-z]/.test(s)) return false; // id/class/attr, or a lowercase tag
  return /^[#.[\]A-Za-z0-9_\-="':.>~+*()]+$/.test(s);
}

/**
 * Map per-assertion evaluations to a journey result. `checkable=false` means the
 * runner could not mechanically evaluate the predicate — that yields `unverified`,
 * NOT `fail`. A genuine contradiction (checkable predicate that did not hold)
 * always outranks unverifiable ones.
 *   any checkable did not hold   → 'fail'
 *   else any unverifiable        → 'unverified'
 *   else (all checkable & held)  → 'pass'
 * @param {Array<{satisfied:boolean,checkable:boolean}>} evaluations
 * @returns {'pass'|'fail'|'unverified'}
 */
export function summarizeResult(evaluations) {
  if (evaluations.some((e) => e.checkable && !e.satisfied)) return 'fail';
  if (evaluations.some((e) => !e.checkable)) return 'unverified';
  return 'pass';
}
