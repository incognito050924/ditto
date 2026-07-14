import { describe, expect, test } from 'bun:test';
import { refreshCharterRegion } from '~/core/charter-region';
import { normalizedSha256 } from '~/core/instruction-bridge';

// Background: this suite pins the MARKER-LESS charter recognition/replace primitive
// that `ditto setup` uses to refresh the ditto-charter region of an on-disk AGENTS.md
// without ever writing a persistent marker (raw-AGENTS invariant). Recognition is
// NORMALIZED exact-match (CRLF/trailing-whitespace tolerant via normalizedSha256),
// NOT fuzzy (ac-3). The region is the LEADING bundled-charter span; any user rules
// follow it and MUST survive byte-identical (ac-2).

const PRIOR = '# Charter v1\n\n## rule A\nold text\n';
const CURRENT = '# Charter v2\n\n## rule A\nnew text\n## rule B\nmore\n';
const PRIOR_SHA = normalizedSha256(PRIOR);
const CURRENT_SHA = normalizedSha256(CURRENT);

describe('refreshCharterRegion', () => {
  // ac-5: region == current bundled charter → silent no-op (nothing to replace).
  test('whole file already equals the current bundled charter → up-to-date', () => {
    const r = refreshCharterRegion({
      current: CURRENT,
      bundledCharter: CURRENT,
      knownShas: [PRIOR_SHA, CURRENT_SHA],
    });
    expect(r.kind).toBe('up-to-date');
    expect(r.content).toBe(CURRENT);
  });

  // ac-1: N→N+1 whole-file upgrade — a prior charter recognized by manifest sha is
  // replaced with the current bundle.
  test('whole file equals a known prior charter → replaced with current bundle', () => {
    const r = refreshCharterRegion({
      current: PRIOR,
      bundledCharter: CURRENT,
      knownShas: [PRIOR_SHA, CURRENT_SHA],
    });
    expect(r.kind).toBe('replaced');
    expect(r.content).toBe(CURRENT);
  });

  // ac-1 + ac-2: prior charter followed by USER RULES — region swapped, the user's
  // appended rules stay byte-identical.
  test('prior charter + user rules → region replaced, suffix byte-identical', () => {
    const userRules = '\n# MY OWN RULES\n- always foo\n- never bar\n';
    const r = refreshCharterRegion({
      current: PRIOR + userRules,
      bundledCharter: CURRENT,
      knownShas: [PRIOR_SHA],
    });
    expect(r.kind).toBe('replaced');
    expect(r.content).toBe(CURRENT + userRules);
    expect(r.content.endsWith(userRules)).toBe(true);
  });

  // ac-3: the region was user-edited (no known sha matches any leading prefix) →
  // unrecognized, left untouched (exact-match only, NO approximate accept).
  test('user-edited region matches no known sha → unrecognized, content unchanged', () => {
    const edited = '# Charter v1\n\n## rule A\nUSER TWEAKED THIS\n';
    const r = refreshCharterRegion({
      current: edited,
      bundledCharter: CURRENT,
      knownShas: [PRIOR_SHA, CURRENT_SHA],
    });
    expect(r.kind).toBe('unrecognized');
    expect(r.content).toBe(edited);
  });

  // ac-3 (no false skip): a CRLF / trailing-whitespace variant of the CURRENT charter
  // still normalizes to the current sha → recognized as up-to-date, NOT skipped.
  test('CRLF variant of current charter → recognized as up-to-date', () => {
    const crlf = CURRENT.replace(/\n/g, '\r\n');
    const r = refreshCharterRegion({
      current: crlf,
      bundledCharter: CURRENT,
      knownShas: [CURRENT_SHA],
    });
    expect(r.kind).toBe('up-to-date');
    expect(r.content).toBe(crlf);
  });

  // ac-1 + ac-2: CRLF variant of a prior charter + user rules → replaced with LF
  // current bundle, user suffix preserved byte-identical.
  test('CRLF prior charter + user rules → replaced, suffix byte-identical', () => {
    const userRules = '\n# USER\nkeep me\n';
    const crlfPrior = PRIOR.replace(/\n/g, '\r\n');
    const r = refreshCharterRegion({
      current: crlfPrior + userRules,
      bundledCharter: CURRENT,
      knownShas: [PRIOR_SHA],
    });
    expect(r.kind).toBe('replaced');
    expect(r.content).toBe(CURRENT + userRules);
  });

  // ac-5: already-current charter WITH appended user rules → up-to-date (region is
  // current; nothing to replace, no notice).
  test('current charter + user rules → up-to-date (region already current)', () => {
    const withRules = `${CURRENT}\n# EXTRA\nx\n`;
    const r = refreshCharterRegion({
      current: withRules,
      bundledCharter: CURRENT,
      knownShas: [PRIOR_SHA, CURRENT_SHA],
    });
    expect(r.kind).toBe('up-to-date');
    expect(r.content).toBe(withRules);
  });

  // ac-5: idempotent — replacing then re-running yields up-to-date, stable content.
  test('idempotent: replaced output re-runs as up-to-date', () => {
    const userRules = '\n# U\ny\n';
    const first = refreshCharterRegion({
      current: PRIOR + userRules,
      bundledCharter: CURRENT,
      knownShas: [PRIOR_SHA, CURRENT_SHA],
    });
    expect(first.kind).toBe('replaced');
    const second = refreshCharterRegion({
      current: first.content,
      bundledCharter: CURRENT,
      knownShas: [PRIOR_SHA, CURRENT_SHA],
    });
    expect(second.kind).toBe('up-to-date');
    expect(second.content).toBe(first.content);
  });

  // No manifest priors: an unknown whole-file charter is unrecognized (fresh install
  // handles the create-if-missing case; this primitive never invents a match).
  test('empty knownShas + non-current content → unrecognized', () => {
    const r = refreshCharterRegion({
      current: PRIOR,
      bundledCharter: CURRENT,
      knownShas: [],
    });
    expect(r.kind).toBe('unrecognized');
    expect(r.content).toBe(PRIOR);
  });
});
