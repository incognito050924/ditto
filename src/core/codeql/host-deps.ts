/**
 * CodeQL relations 실행용 실제(Bun-backed) deps factory — ADR-0006.
 *
 * impact/boundary CLI와 e2e가 공유한다(인라인 중복 제거). spawn·stream·env 구성은
 * 기존 codeql.ts 패턴과 동일하고, relations.ts가 추가로 요구하는 파일 IO(writeText·
 * ensureDir·dirExists)를 더한다.
 */
import { existsSync } from 'node:fs';
import { localDir } from '~/core/ditto-paths';
import { ensureDir } from '~/core/fs';
import type { HostRunProcess } from '~/core/hosts/types';
import type { RelationDeps } from './relations';
import { type CodeqlLanguage, cacheKey } from './runner';

/** Drain a stream to the end so a piped child cannot block on a full pipe. */
async function drainStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

/** Build the process env: inherit, apply `set`, then remove `unset` keys. */
function composeEnv(base: NodeJS.ProcessEnv, set: Record<string, string>, unset: string[]) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v;
  for (const [k, v] of Object.entries(set)) env[k] = v;
  for (const k of unset) delete env[k];
  return env;
}

/** Real deps for CodeQL relation extraction (DB create → query run → bqrs decode). */
export function makeRelationDeps(): RelationDeps {
  return {
    spawn: ({ binary, args, repoRoot, cwd, env }): HostRunProcess => {
      const proc = Bun.spawn([binary, ...args], {
        cwd: cwd === '.' ? repoRoot : cwd,
        env: composeEnv(process.env, env.set, env.unset),
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'ignore',
      });
      return {
        entrypoint: binary,
        stdout: proc.stdout as ReadableStream<Uint8Array>,
        stderr: proc.stderr as ReadableStream<Uint8Array>,
        completion: proc.exited.then((code) => ({ exit_code: code, model_reported: null })),
      };
    },
    readText: (path) => Bun.file(path).text(),
    fileExists: (path) => Bun.file(path).exists(),
    drain: drainStream,
    writeText: async (path, content) => {
      await Bun.write(path, content);
    },
    ensureDir: (path) => ensureDir(path),
    dirExists: async (path) => existsSync(path),
  };
}

/**
 * 현재 커밋·언어로 키된 CodeQL 캐시 디렉터리(.ditto/local/cache/codeql/<sha>-<lang>).
 * DB·쿼리 작업물이 여기 산다. working tree가 커밋과 다르면 DB가 stale일 수 있다(알려진
 * 한계 — 같은 커밋 내 재실행 절감이 목적).
 */
export function codeqlCacheDir(repoRoot: string, language: CodeqlLanguage): string {
  const res = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: repoRoot });
  const sha = res.exitCode === 0 ? new TextDecoder().decode(res.stdout).trim() : 'working-tree';
  return localDir(repoRoot, 'cache', 'codeql', cacheKey(sha, language));
}
