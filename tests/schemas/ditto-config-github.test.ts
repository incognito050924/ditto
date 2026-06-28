import { describe, expect, test } from 'bun:test';
import { dittoConfigGithub } from '~/schemas/ditto-config';

// wi_2606287v9 (#5) ac-5/ac-9: the non-terminal board-status mapping (claim ->
// "In Progress", blocked -> "Blocked") lives in a SEPARATE optional field
// `claim_status_map` with OPEN string keys, NOT in the terminal `status_map`
// (keys done|abandoned). This keeps an old/stale-bundle reader degrading per-key
// instead of dropping the whole github config — see ditto-config-backcompat.test.ts
// for the old-schema direction.

const base = {
  project: { owner: 'o', number: 5 },
  status_map: { done: 'opt_done', abandoned: 'opt_dropped' },
  auto_reflect: false,
} as const;

describe('dittoConfigGithub claim_status_map (wi_2606287v9)', () => {
  test('the terminal status_map stays keyed to done|abandoned only (closed enum)', () => {
    const r = dittoConfigGithub.safeParse({
      ...base,
      status_map: { done: 'd', abandoned: 'a', in_progress: 'p' },
    });
    // a non-terminal key in the TERMINAL map is rejected — this is the failure mode a
    // separate claim_status_map field avoids.
    expect(r.success).toBe(false);
  });

  test('claim_status_map carries the non-terminal mapping (in_progress, blocked)', () => {
    const r = dittoConfigGithub.parse({
      ...base,
      claim_status_map: { in_progress: 'opt_wip', blocked: 'opt_blocked' },
    });
    expect(r.claim_status_map).toEqual({ in_progress: 'opt_wip', blocked: 'opt_blocked' });
  });

  test('claim_status_map is OPTIONAL — a terminal-only config parses unchanged', () => {
    const r = dittoConfigGithub.parse({ ...base });
    expect(r.claim_status_map).toBeUndefined();
    expect(r.status_map).toEqual({ done: 'opt_done', abandoned: 'opt_dropped' });
  });

  test('claim_status_map may be partial (only in_progress)', () => {
    const r = dittoConfigGithub.parse({ ...base, claim_status_map: { in_progress: 'opt_wip' } });
    expect(r.claim_status_map).toEqual({ in_progress: 'opt_wip' });
  });

  test('open keys: a future non-terminal key is carried, not rejected (forward-compat)', () => {
    const r = dittoConfigGithub.parse({
      ...base,
      claim_status_map: { in_progress: 'opt_wip', in_review: 'opt_review' },
    });
    expect(r.claim_status_map).toEqual({ in_progress: 'opt_wip', in_review: 'opt_review' });
  });
});
