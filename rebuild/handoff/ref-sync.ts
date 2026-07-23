import { execFileSync } from 'node:child_process';

import { HANDOFFS_REF } from './ref-store';

/**
 * Remote side of the handoff contract: the ONLY refspec this module will ever
 * push is `refs/ditto/*` → `refs/ditto/*`, asserted before every push. No
 * force prefix — ordinary writes and consumes are fast-forward commits, so a
 * non-FF rejection is a real conflict to surface, never something to force
 * through here.
 */

export class NonDittoRefspecError extends Error {
  constructor(refspec: string) {
    super(
      `refusing to push ${JSON.stringify(refspec)} — handoff sync is confined to refs/ditto/* on both sides, no force prefix`,
    );
    this.name = 'NonDittoRefspecError';
  }
}

/** Both sides must live under refs/ditto/, with a non-empty leaf and no +force. */
export function assertDittoPushRefspec(refspec: string): void {
  const [src, dst, ...rest] = refspec.split(':');
  const inDittoNamespace = (ref: string | undefined): boolean =>
    ref !== undefined && /^refs\/ditto\/.+$/.test(ref);
  if (rest.length > 0 || !inDittoNamespace(src) || !inDittoNamespace(dst)) {
    throw new NonDittoRefspecError(refspec);
  }
}

/**
 * Push the hidden handoffs ref to `remote`. An unborn local ref is a no-op —
 * there is nothing to publish, and "publish nothing" must never fail.
 */
export async function pushHandoffs(
  repoRoot: string,
  remote: string,
): Promise<void> {
  const refspec = `${HANDOFFS_REF}:${HANDOFFS_REF}`;
  assertDittoPushRefspec(refspec);

  const unborn = (() => {
    try {
      execFileSync(
        'git',
        ['rev-parse', '--verify', '--quiet', HANDOFFS_REF],
        { cwd: repoRoot, encoding: 'utf8' },
      );
      return false;
    } catch {
      return true;
    }
  })();
  if (unborn) return;

  execFileSync('git', ['push', '--quiet', remote, refspec], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}
