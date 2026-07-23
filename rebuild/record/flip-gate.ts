import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { dittoDir } from '../util/paths';

/**
 * The flip gate: ONE committed switch that decides which generation is the
 * real recorder. Until the project flips `.ditto/recorder.json` to
 * `{"recorder": "rebuild"}`, the old src remains the sole real recorder and
 * the rebuild layer is exercised through fixture contract tests only.
 *
 * Fail-closed to `legacy`: a missing, malformed, or unknown switch never
 * silently promotes the rebuild layer. No compatibility shim for old binaries
 * exists on purpose — flipping is a single, deliberate, committed change.
 */

export type RecorderGate = 'legacy' | 'rebuild';

export class LegacyRecorderActiveError extends Error {
  constructor() {
    super(
      'the rebuild layer is not the real recorder yet — the flip gate ' +
        '(.ditto/recorder.json {"recorder":"rebuild"}) is not set; the old ' +
        'src owns real records',
    );
    this.name = 'LegacyRecorderActiveError';
  }
}

export async function readRecorderGate(
  repoRoot: string,
): Promise<RecorderGate> {
  let text: string;
  try {
    text = await readFile(join(dittoDir(repoRoot), 'recorder.json'), 'utf8');
  } catch {
    return 'legacy';
  }
  try {
    const raw = JSON.parse(text) as { recorder?: unknown };
    return raw !== null && typeof raw === 'object' && raw.recorder === 'rebuild'
      ? 'rebuild'
      : 'legacy';
  } catch {
    return 'legacy';
  }
}

/** Entry-point guard for real (non-fixture) recording paths. */
export async function assertRebuildRecorderEnabled(
  repoRoot: string,
): Promise<void> {
  if ((await readRecorderGate(repoRoot)) !== 'rebuild') {
    throw new LegacyRecorderActiveError();
  }
}
