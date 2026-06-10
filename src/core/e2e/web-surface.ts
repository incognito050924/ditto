import { UI_EXTENSIONS } from './applicability';

/**
 * Diff-based web-surface detection (wi_260610p9h g5, ac-6). Given the changed
 * paths of a work item, decide whether the change touches a *web surface* — a
 * frontend page/component or a backend API — so the autopilot driver can
 * PROPOSE E2E authoring to the user (never auto-add an e2e node).
 *
 * This complements `applicability.ts` (repo-level "does this repo render a web
 * UI at all?"): here the question is per-diff ("did THIS change touch the web
 * surface?"), driven purely by the changed path list, no filesystem I/O.
 */

export interface WebSurface {
  kind: 'frontend' | 'api';
  path: string;
}

export interface WebSurfaceChange {
  web: boolean;
  surfaces: WebSurface[];
}

// Code extensions the API heuristic applies to. Restricting the API match to
// source code keeps docs/config under an `api/` directory (e.g. docs/api/x.md,
// api/openapi.yaml) from triggering a proposal.
const CODE_EXTENSIONS = [
  '.ts',
  '.js',
  '.mts',
  '.cts',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rb',
  '.java',
  '.kt',
  '.rs',
  '.php',
  '.cs',
];

// Path segments that conventionally hold HTTP endpoint code. Heuristic limits
// (§7-②, conservative by choice — we accept MISSES and avoid FALSE ALARMS,
// because a false alarm costs a needless user interruption while a miss only
// skips a *proposal* the user can still trigger manually):
//  - an API implemented outside these conventions (e.g. src/web.ts) is missed;
//  - matching is exact-segment, so `api-client/` or `myapi/` never match.
const API_SEGMENTS = new Set(['api', 'apis', 'routes', 'controllers', 'endpoints']);

// Basename naming that conventionally marks server/handler entry code, e.g.
// `server.ts`, `users.handler.ts`, `auth-handler.py`. Same conservative bias:
// the basename must END in the keyword — `serverless-utils.ts` does not match.
const API_BASENAME = /(^|[-._])(server|handler|controller)$/;

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

function isFrontendPath(path: string): boolean {
  return UI_EXTENSIONS.includes(extensionOf(path));
}

function isApiPath(path: string): boolean {
  if (!CODE_EXTENSIONS.includes(extensionOf(path))) return false;
  const segments = path.toLowerCase().split('/');
  const dirs = segments.slice(0, -1);
  if (dirs.some((s) => API_SEGMENTS.has(s))) return true;
  const base = segments.at(-1) ?? '';
  const stem = base.slice(0, base.indexOf('.') === -1 ? base.length : base.lastIndexOf('.'));
  return API_BASENAME.test(stem);
}

/**
 * Classify each changed path. A UI/markup file is a frontend surface (checked
 * first — a .tsx under routes/ is still frontend); a code file under an API
 * directory convention or with server/handler naming is an api surface;
 * everything else is not a web surface. `web` is true iff any surface matched.
 */
export function detectWebSurfaceChange(changedPaths: string[]): WebSurfaceChange {
  const surfaces: WebSurface[] = [];
  for (const path of changedPaths) {
    if (isFrontendPath(path)) {
      surfaces.push({ kind: 'frontend', path });
    } else if (isApiPath(path)) {
      surfaces.push({ kind: 'api', path });
    }
  }
  return { web: surfaces.length > 0, surfaces };
}
