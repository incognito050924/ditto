import { stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { relativePath } from '~/schemas/common';
import type { RunManifest } from '~/schemas/run-manifest';
import { ensureDir } from './fs';
import { captureGitDiff, captureGitState, listChangedFiles } from './git';
import type { HostAdapter, HostRunCompletion } from './hosts';
import { getHostAdapter } from './hosts';
import { RunStore } from './run-store';
import { WorkItemStore } from './work-item-store';

type ProviderName = RunManifest['provider'];
type RunnableProvider = Extract<ProviderName, 'codex' | 'claude-code'>;
const NETWORK_ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY'];

export interface RunWithInput {
  work_item_id: string;
  provider: ProviderName;
  profile: RunManifest['profile'];
  args: string[];
  prompt_path?: string;
  cwd?: string;
  env?: {
    set?: Record<string, string>;
    unset?: string[];
  };
}

export interface RunWithResult {
  run_id: string;
  work_item_id: string;
  manifest_path: string;
  provider: RunnableProvider;
  profile: RunManifest['profile'];
  exit_code: number | null;
}

export class RunWithUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunWithUsageError';
  }
}

export class RunWithRuntimeError extends Error {
  constructor(
    message: string,
    public readonly result?: RunWithResult,
  ) {
    super(message);
    this.name = 'RunWithRuntimeError';
  }
}

function repoRelative(repoRoot: string, path: string): string {
  return relative(repoRoot, path).split(sep).join('/');
}

function resolveRepoCwd(repoRoot: string, cwd: string): string {
  const parsed = relativePath.safeParse(cwd);
  if (!parsed.success) {
    throw new RunWithUsageError(`invalid cwd: ${parsed.error.issues[0]?.message}`);
  }
  const resolvedRoot = resolve(repoRoot);
  const resolvedCwd = resolve(join(repoRoot, cwd));
  if (resolvedCwd !== resolvedRoot && !resolvedCwd.startsWith(`${resolvedRoot}${sep}`)) {
    throw new RunWithUsageError(`cwd escapes repo root: ${cwd}`);
  }
  return parsed.data;
}

function policyEnv(input: RunWithInput): { set: Record<string, string>; unset: string[] } {
  const unset = new Set(input.env?.unset ?? []);
  if (input.profile !== 'networked') {
    for (const key of NETWORK_ENV_KEYS) unset.add(key);
  }
  return {
    set: input.env?.set ?? {},
    unset: [...unset],
  };
}

function profileUnverified(profile: RunManifest['profile'], changedFiles: string[]): string[] {
  const unverified: string[] = [];
  const outside = changedFiles.filter((path) => !relativePath.safeParse(path).success);
  if (outside.length > 0) {
    unverified.push(`profile violated: changed files outside repo: ${outside.join(', ')}`);
  }
  if ((profile === 'read-only' || profile === 'reviewer') && changedFiles.length > 0) {
    unverified.push('profile violated: writes detected');
  }
  return unverified;
}

async function assertExistingPrompt(repoRoot: string, promptPath: string): Promise<void> {
  const parsed = relativePath.safeParse(promptPath);
  if (!parsed.success) {
    throw new RunWithUsageError(`invalid --prompt path: ${parsed.error.issues[0]?.message}`);
  }
  try {
    await stat(`${repoRoot}/${promptPath}`);
  } catch {
    throw new RunWithUsageError(`--prompt path does not exist: ${promptPath}`);
  }
}

function parseRunnableProvider(provider: ProviderName): RunnableProvider {
  if (provider === 'codex' || provider === 'claude-code') return provider;
  throw new RunWithUsageError(`provider ${provider} is schema-valid but not runnable in v0.3`);
}

async function streamToFile(stream: ReadableStream<Uint8Array>, path: string): Promise<void> {
  await ensureDir(dirname(path));
  const bytes = await new Response(stream).arrayBuffer();
  await writeFile(path, new Uint8Array(bytes));
}

async function captureArtifacts(
  repoRoot: string,
  runStore: RunStore,
  runId: string,
  adapterProcess: Awaited<ReturnType<NonNullable<HostAdapter['spawnRun']>>>,
): Promise<{ completion: HostRunCompletion; unverified: string[] }> {
  const stdoutPath = runStore.pathFor(runId, 'stdout.log');
  const stderrPath = runStore.pathFor(runId, 'stderr.log');
  const diffPath = runStore.pathFor(runId, 'diff.patch');
  const unverified: string[] = [];
  let completion: HostRunCompletion = { exit_code: null, model_reported: null };

  try {
    await Promise.all([
      streamToFile(adapterProcess.stdout, stdoutPath),
      streamToFile(adapterProcess.stderr, stderrPath),
    ]);
  } catch (err) {
    unverified.push(`artifact capture failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    completion = await adapterProcess.completion;
  } catch (err) {
    completion = {
      exit_code: null,
      model_reported: null,
      error: `adapter completion rejected: ${err instanceof Error ? err.message : String(err)}`,
    };
    unverified.push('adapter completion promise rejected; this is a HostAdapter contract bug');
  }

  await writeFile(diffPath, captureGitDiff(repoRoot), 'utf8');
  return { completion, unverified };
}

export async function runWithProvider(
  repoRoot: string,
  input: RunWithInput,
): Promise<RunWithResult> {
  const provider = parseRunnableProvider(input.provider);
  const cwd = resolveRepoCwd(repoRoot, input.cwd ?? '.');
  if (input.prompt_path) {
    await assertExistingPrompt(repoRoot, input.prompt_path);
  }

  const adapter = getHostAdapter(provider);
  if (!adapter.spawnRun) {
    throw new RunWithUsageError(`provider ${provider} does not implement spawnRun`);
  }

  const workStore = new WorkItemStore(repoRoot);
  const runStore = new RunStore(repoRoot);
  const item = await workStore.get(input.work_item_id);
  const gitBefore = captureGitState(repoRoot);
  const created = await runStore.create({
    work_item_id: item.id,
    provider,
    entrypoint: provider,
    profile: input.profile,
    cwd,
    model_reported: null,
    git_before: gitBefore,
    ...(input.prompt_path ? { prompt_path: input.prompt_path } : {}),
  });
  const manifestPath = `.ditto/runs/${created.id}/manifest.json`;
  const resultBase: RunWithResult = {
    run_id: created.id,
    work_item_id: item.id,
    manifest_path: manifestPath,
    provider,
    profile: input.profile,
    exit_code: null,
  };

  let adapterProcess: Awaited<ReturnType<NonNullable<HostAdapter['spawnRun']>>>;
  try {
    adapterProcess = await adapter.spawnRun({
      repoRoot,
      cwd,
      profile: input.profile,
      args: input.args,
      env: policyEnv(input),
    });
  } catch (err) {
    const message = `adapter spawnRun threw: ${err instanceof Error ? err.message : String(err)}`;
    const endedAt = new Date().toISOString();
    await runStore.update(created.id, (cur) => ({
      ...cur,
      exit_code: null,
      ended_at: endedAt,
      git_after: captureGitState(repoRoot),
      unverified: [...cur.unverified, message],
      notes: message,
    }));
    throw new RunWithRuntimeError(message, resultBase);
  }

  await runStore.update(created.id, (cur) => ({
    ...cur,
    entrypoint: adapterProcess.entrypoint,
  }));

  const { completion, unverified } = await captureArtifacts(
    repoRoot,
    runStore,
    created.id,
    adapterProcess,
  );
  const endedAt = new Date().toISOString();
  const changedFiles = listChangedFiles(repoRoot, { excludeDittoRuns: true });
  const profileFindings = profileUnverified(input.profile, changedFiles);
  const updated = await runStore.update(created.id, (cur) => ({
    ...cur,
    model_reported: completion.model_reported,
    git_after: captureGitState(repoRoot),
    changed_files: changedFiles,
    stdout_path: repoRelative(repoRoot, runStore.pathFor(created.id, 'stdout.log')),
    stderr_path: repoRelative(repoRoot, runStore.pathFor(created.id, 'stderr.log')),
    diff_path: repoRelative(repoRoot, runStore.pathFor(created.id, 'diff.patch')),
    exit_code: completion.exit_code,
    ended_at: endedAt,
    unverified: [
      ...cur.unverified,
      ...unverified,
      ...(completion.unverified ?? []),
      ...profileFindings,
    ],
    ...(completion.error || completion.signal
      ? {
          notes: [completion.error, completion.signal ? `signal: ${completion.signal}` : null]
            .filter(Boolean)
            .join('\n'),
        }
      : {}),
  }));

  const result = { ...resultBase, exit_code: updated.exit_code };
  try {
    await workStore.update(item.id, (cur) => ({
      ...cur,
      runs: cur.runs.includes(created.id) ? cur.runs : [...cur.runs, created.id],
    }));
  } catch (err) {
    throw new RunWithRuntimeError(
      `failed to link run to work item: ${err instanceof Error ? err.message : String(err)}`,
      result,
    );
  }

  return result;
}
