import { basename, join } from 'node:path';
import { glossary } from '~/schemas/glossary';
import { atomicWriteText, ensureDir, writeJson } from './fs';
import { fileExists } from './hosts/shared';

/**
 * Result of scaffolding a `.ditto/` workspace. Paths are repo-relative so the
 * output is stable across machines; `alreadyInitialized` is true when the
 * canonical marker (`knowledge/glossary.json`) was present before this run.
 */
export interface InitScaffoldResult {
  repoRoot: string;
  createdDirs: string[];
  createdFiles: string[];
  skippedFiles: string[];
  alreadyInitialized: boolean;
}

/**
 * Runtime/knowledge subdirectories created up front so the `.ditto/` layout is
 * self-documenting and `findRepoRoot` resolves deterministically. Stores still
 * lazily `ensureDir` their own paths, so this list only needs to cover the
 * skeleton — not every leaf a store might create.
 */
const SCAFFOLD_DIRS = [
  'work-items',
  'runs',
  'handoff',
  'sessions',
  'logs',
  'cache',
  'agents',
  'knowledge',
  join('knowledge', 'adr'),
] as const;

/**
 * Seeded into `.ditto/.gitignore` so volatile runtime state stays out of the
 * target's version control while durable artifacts (work-item metadata,
 * knowledge, handoff) remain committable. Mirrors the ditto repo's own
 * `.gitignore` `.ditto/*` rules, scoped to `.ditto/` so init never touches the
 * target's root `.gitignore`.
 */
const DITTO_GITIGNORE = `# DITTO runtime state — volatile, not for version control.
# Managed by \`ditto init\`; safe to edit.
runs/
cache/
sessions/
logs/
worktrees/
work-items/*/evidence/
`;

function emptyContext(projectName: string): string {
  return `# ${projectName} — DITTO Knowledge Context

Durable project knowledge lives under \`.ditto/knowledge/\`. This file is seeded
empty by \`ditto init\`; DITTO's knowledge-update flow appends durable decisions,
agreed terms, and learnings over time.

- glossary: \`glossary.json\`
- decisions: \`adr/\`
`;
}

async function ensureDirTracked(
  absPath: string,
  relPath: string,
  created: string[],
): Promise<void> {
  const existed = await fileExists(absPath);
  await ensureDir(absPath);
  if (!existed) created.push(relPath);
}

async function seedFileIfAbsent(
  absPath: string,
  relPath: string,
  write: () => Promise<void>,
  created: string[],
  skipped: string[],
): Promise<boolean> {
  if (await fileExists(absPath)) {
    skipped.push(relPath);
    return false;
  }
  await write();
  created.push(relPath);
  return true;
}

/**
 * Scaffold a `.ditto/` workspace under `repoRoot`, idempotently. Creates the
 * runtime skeleton and seeds an empty knowledge base (glossary, context) plus a
 * `.gitignore` for volatile state. Existing files are never clobbered. Does NOT
 * seed `surfaces.json`: that catalog describes the installed DITTO plugin's
 * own surfaces and only makes sense self-host, where repoRoot == the plugin.
 */
export async function initScaffold(repoRoot: string, now: Date): Promise<InitScaffoldResult> {
  const dittoDir = join(repoRoot, '.ditto');
  const createdDirs: string[] = [];
  const createdFiles: string[] = [];
  const skippedFiles: string[] = [];

  const glossaryAbs = join(dittoDir, 'knowledge', 'glossary.json');
  const alreadyInitialized = await fileExists(glossaryAbs);

  await ensureDirTracked(dittoDir, '.ditto', createdDirs);
  for (const sub of SCAFFOLD_DIRS) {
    await ensureDirTracked(join(dittoDir, sub), join('.ditto', sub), createdDirs);
  }

  const projectName = basename(repoRoot) || 'project';

  await seedFileIfAbsent(
    glossaryAbs,
    join('.ditto', 'knowledge', 'glossary.json'),
    () =>
      writeJson(glossaryAbs, glossary, {
        schema_version: '0.1.0',
        project_name: projectName,
        updated_at: now.toISOString(),
        entries: [],
      }).then(() => undefined),
    createdFiles,
    skippedFiles,
  );

  const contextAbs = join(dittoDir, 'knowledge', 'CONTEXT.md');
  await seedFileIfAbsent(
    contextAbs,
    join('.ditto', 'knowledge', 'CONTEXT.md'),
    () => atomicWriteText(contextAbs, emptyContext(projectName)),
    createdFiles,
    skippedFiles,
  );

  const gitignoreAbs = join(dittoDir, '.gitignore');
  await seedFileIfAbsent(
    gitignoreAbs,
    join('.ditto', '.gitignore'),
    () => atomicWriteText(gitignoreAbs, DITTO_GITIGNORE),
    createdFiles,
    skippedFiles,
  );

  return { repoRoot, createdDirs, createdFiles, skippedFiles, alreadyInitialized };
}
