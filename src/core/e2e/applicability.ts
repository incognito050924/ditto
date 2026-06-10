import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Axis-3 applicability (재평가 §1 축3 경계(a) + gap①, 4a).
 *
 * Axis-3 is real-browser E2E only. A library / CLI / domain-model target has no
 * web UI, so axis-3 is N/A — and the verification responsibility falls to axis-2
 * (code-level reviewer) and axis-1 (intent alignment). This module makes that an
 * AUTOMATIC branch read from a web-UI signal instead of a manual per-run judgment:
 * the e2e skill checks applicability first and, when N/A, records the skip + which
 * axes cover it rather than fabricating or `blocked`-ing a browser run.
 */

// Browser/DOM frameworks whose presence in package.json means the target renders
// a web UI. Build tooling that is stack-agnostic (e.g. a bundler that also builds
// libraries) is deliberately excluded — it is not a UI signal on its own.
const WEB_FRAMEWORKS = [
  'react',
  'react-dom',
  'vue',
  'svelte',
  '@sveltejs/kit',
  '@angular/core',
  'preact',
  'solid-js',
  'next',
  'nuxt',
  'remix',
  '@remix-run/react',
  'astro',
  'gatsby',
];

export interface WebUiSignals {
  /** The first browser/UI framework dependency found in package.json, or null. */
  web_framework: string | null;
  /** Count of UI/markup source files (.tsx/.jsx/.vue/.svelte/.html under src). */
  ui_file_count: number;
}

export interface Axis3Applicability {
  applicable: boolean;
  reason: string;
  /** When N/A, the axes that carry the verification responsibility instead. */
  covered_by: string[];
  signals: WebUiSignals;
}

/**
 * Pure decision from the web-UI signals. Either a framework dependency OR any
 * UI/markup file makes axis-3 applicable; absence of both makes it N/A with the
 * covering axes named (so a skip is recorded, never silent).
 */
export function evaluateAxis3Applicability(signals: WebUiSignals): Axis3Applicability {
  const hasWeb = signals.web_framework !== null || signals.ui_file_count > 0;
  if (hasWeb) {
    const parts: string[] = [];
    if (signals.web_framework) parts.push(`framework: ${signals.web_framework}`);
    if (signals.ui_file_count > 0) parts.push(`${signals.ui_file_count} UI/markup file(s)`);
    return {
      applicable: true,
      reason: `web UI present (${parts.join(', ')})`,
      covered_by: [],
      signals,
    };
  }
  return {
    applicable: false,
    reason: 'no web UI detected (no browser-framework dependency, no UI/markup files)',
    covered_by: ['axis-2 (reviewer / code-level verification)', 'axis-1 (intent alignment)'],
    signals,
  };
}

export interface ApplicabilityDeps {
  repoRoot: string;
  /** Parsed package.json (deps + devDeps), or null if absent/unreadable. */
  readPackageJson: () => Record<string, unknown> | null;
  /** Count UI/markup source files under the target (default scans `src`). */
  countUiFiles: () => number;
}

function dependencyNames(pkg: Record<string, unknown> | null): Set<string> {
  if (!pkg) return new Set();
  const names = new Set<string>();
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const section = pkg[key];
    if (section && typeof section === 'object') {
      for (const name of Object.keys(section as Record<string, unknown>)) names.add(name);
    }
  }
  return names;
}

// Exported so the diff-based web-surface detector (web-surface.ts) reuses the
// same UI-file vocabulary instead of keeping a second, drift-prone list.
export const UI_EXTENSIONS = ['.tsx', '.jsx', '.vue', '.svelte', '.html'];

function defaultReadPackageJson(repoRoot: string): () => Record<string, unknown> | null {
  return () => {
    const path = join(repoRoot, 'package.json');
    if (!existsSync(path)) return null;
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
}

function defaultCountUiFiles(repoRoot: string): () => number {
  return () => {
    // Scope the scan to `src` so node_modules is never walked; a UI app whose
    // components live elsewhere (app/, pages/) is still caught by the framework
    // dependency signal. Bun.Glob is lazy; we only need presence, so cap the count.
    const srcDir = join(repoRoot, 'src');
    if (!existsSync(srcDir)) return 0;
    const glob = new Bun.Glob(`**/*{${UI_EXTENSIONS.join(',')}}`);
    let count = 0;
    for (const _ of glob.scanSync({ cwd: srcDir, onlyFiles: true })) {
      count++;
      if (count >= 50) break;
    }
    return count;
  };
}

export function defaultApplicabilityDeps(repoRoot: string): ApplicabilityDeps {
  return {
    repoRoot,
    readPackageJson: defaultReadPackageJson(repoRoot),
    countUiFiles: defaultCountUiFiles(repoRoot),
  };
}

export function detectWebUiSignals(deps: ApplicabilityDeps): WebUiSignals {
  const names = dependencyNames(deps.readPackageJson());
  const web_framework = WEB_FRAMEWORKS.find((f) => names.has(f)) ?? null;
  return { web_framework, ui_file_count: deps.countUiFiles() };
}

export function evaluateAxis3FromRepo(deps: ApplicabilityDeps): Axis3Applicability {
  return evaluateAxis3Applicability(detectWebUiSignals(deps));
}
