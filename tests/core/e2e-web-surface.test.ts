import { describe, expect, test } from 'bun:test';
import { detectWebSurfaceChange } from '~/core/e2e/web-surface';

/**
 * Diff-based web-surface detection (wi_260610p9h g5, ac-6). The heuristic is
 * conservative BY CHOICE (§7-②): it accepts misses (an unconventional API path
 * is not flagged) and avoids false alarms (docs/config under api/, api-like
 * substrings) — a false alarm costs a needless user interruption, a miss only
 * skips a proposal the user can still trigger manually.
 */
describe('detectWebSurfaceChange', () => {
  test('frontend: UI/markup extensions are frontend surfaces', () => {
    const res = detectWebSurfaceChange([
      'src/pages/Home.tsx',
      'src/widgets/button.vue',
      'public/index.html',
    ]);
    expect(res.web).toBe(true);
    expect(res.surfaces).toEqual([
      { kind: 'frontend', path: 'src/pages/Home.tsx' },
      { kind: 'frontend', path: 'src/widgets/button.vue' },
      { kind: 'frontend', path: 'public/index.html' },
    ]);
  });

  test('api: code under an api/routes/controllers/endpoints segment', () => {
    const res = detectWebSurfaceChange(['src/api/users.ts', 'app/routes/login.py']);
    expect(res.web).toBe(true);
    expect(res.surfaces.map((s) => s.kind)).toEqual(['api', 'api']);
  });

  test('api: server/handler basename naming on code files', () => {
    const res = detectWebSurfaceChange(['src/server.ts', 'lambda/users.handler.js']);
    expect(res.surfaces.map((s) => s.kind)).toEqual(['api', 'api']);
  });

  test('frontend wins over api for a UI file under an api-ish directory', () => {
    const res = detectWebSurfaceChange(['src/routes/Page.tsx']);
    expect(res.surfaces).toEqual([{ kind: 'frontend', path: 'src/routes/Page.tsx' }]);
  });

  test('non-web changes yield web=false (library/CLI/internal logic)', () => {
    const res = detectWebSurfaceChange(['src/core/graph.ts', 'README.md', 'scripts/build.sh']);
    expect(res.web).toBe(false);
    expect(res.surfaces).toEqual([]);
  });

  test('conservative misses accepted: docs/config under api/ and api-like substrings do NOT match', () => {
    const res = detectWebSurfaceChange([
      'docs/api/usage.md', // not a code file → no api match
      'api/openapi.yaml', // not a code file → no api match
      'src/api-client/fetch.ts', // `api-client` segment ≠ exact `api` segment
      'src/serverless-utils.ts', // basename does not END in server/handler
    ]);
    expect(res.web).toBe(false);
    expect(res.surfaces).toEqual([]);
  });

  test('empty input yields web=false', () => {
    expect(detectWebSurfaceChange([])).toEqual({ web: false, surfaces: [] });
  });
});
