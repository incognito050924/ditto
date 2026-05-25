import { join } from 'node:path';
import type { HostRunCompletion, HostRunEnv, HostRunProcess } from './types';

export function materializeEnv(env: HostRunEnv): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) next[key] = value;
  }
  for (const key of env.unset) {
    delete next[key];
  }
  for (const [key, value] of Object.entries(env.set)) {
    next[key] = value;
  }
  return next;
}

export function spawnProviderProcess(input: {
  binary: string;
  args: string[];
  repoRoot: string;
  cwd: string;
  env: HostRunEnv;
  unverified?: string[];
}): HostRunProcess {
  const proc = Bun.spawn([input.binary, ...input.args], {
    cwd: join(input.repoRoot, input.cwd),
    env: materializeEnv(input.env),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const completion = proc.exited
    .then(
      (exitCode): HostRunCompletion => ({
        exit_code: exitCode,
        model_reported: null,
        ...(input.unverified && input.unverified.length > 0
          ? { unverified: input.unverified }
          : {}),
      }),
    )
    .catch(
      (err): HostRunCompletion => ({
        exit_code: null,
        model_reported: null,
        error: err instanceof Error ? err.message : String(err),
        ...(input.unverified && input.unverified.length > 0
          ? { unverified: input.unverified }
          : {}),
      }),
    );
  return {
    entrypoint: input.binary,
    stdout: proc.stdout,
    stderr: proc.stderr,
    completion,
  };
}
