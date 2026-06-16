/**
 * memory를 별도 git 저장소로 분리(제자리). 기본 동작은 프로젝트 git에 포함이므로 이 모듈은
 * 사용자가 분리를 택했을 때만 호출된다.
 *
 * 분리 대상은 SoT 절반(`.ditto/memory/` — sources/·events/)뿐이다. 파생 절반
 * (`.ditto/local/memory/`)은 이미 gitignore라 중복 관리 대상이 아니다.
 *
 * 두 방식(사용자 결정: gitignore-독립이 기본, submodule은 opt-in):
 *  - gitignore: `.ditto/memory/`에서 git init + 부모 .gitignore에 경로 추가 → 부모는 memory를
 *    완전히 모름(중복 관리 없음). 단순·완전 자동.
 *  - submodule: 부모가 commit 포인터만 추적(프로젝트↔memory 버전 연결, 팀 재현). 단 원격이
 *    선행돼야 하므로 자동화하지 않고 수동 절차를 안내한다.
 *
 * 경로는 `.ditto/memory/` 고정(memory-store.ts와 일치) — 트리 밖 재배치가 아니다.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';

export type MemorySeparateMode = 'gitignore' | 'submodule';

export interface MemorySeparateDeps {
  repoRoot: string;
  /** git 한 단계 실행(cwd 지정 가능). exit 0이면 성공. */
  run: (
    cmd: string,
    args: string[],
    cwd?: string,
  ) => Promise<{ exit_code: number | null; stderr: string }>;
  /** 경로 존재 여부. */
  pathExists: (p: string) => boolean;
  /** 부모 .gitignore 내용(없으면 ''). */
  readGitignore: () => string;
  writeGitignore: (content: string) => void;
}

export interface MemorySeparateResult {
  status: 'separated' | 'already' | 'failed' | 'manual';
  message: string;
  manual?: string[];
}

const GITIGNORE_ENTRY = '.ditto/memory/';

function join(...parts: string[]): string {
  return parts.join('/');
}

/** 부모 .gitignore에 `.ditto/memory/`가 없으면 추가한다(멱등). 추가했으면 true. */
function ensureGitignored(deps: MemorySeparateDeps): boolean {
  const current = deps.readGitignore();
  const lines = current.split('\n').map((l) => l.trim());
  if (lines.includes(GITIGNORE_ENTRY)) return false;
  const sep = current === '' || current.endsWith('\n') ? '' : '\n';
  deps.writeGitignore(
    `${current}${sep}\n# ditto memory: 별도 저장소로 분리됨(중복 관리 방지)\n${GITIGNORE_ENTRY}\n`,
  );
  return true;
}

const submoduleManual = (memoryDir: string): string[] => [
  '# submodule은 원격이 선행돼야 한다. memory를 원격에 올린 뒤:',
  `cd ${memoryDir} && git init && git add -A && git commit -m "memory" && git remote add origin <URL> && git push -u origin main`,
  '# 그다음 부모에서: git rm -r --cached .ditto/memory && git submodule add <URL> .ditto/memory',
];

/**
 * memory(`.ditto/memory/`)를 별도 저장소로 분리한다. gitignore 모드는 자동, submodule 모드는
 * 수동 절차 안내(원격 선행 필요). fail-soft.
 */
export async function separateMemoryRepo(
  deps: MemorySeparateDeps,
  mode: MemorySeparateMode = 'gitignore',
): Promise<MemorySeparateResult> {
  const memoryDir = join(deps.repoRoot, '.ditto', 'memory');
  if (!deps.pathExists(memoryDir)) {
    return {
      status: 'failed',
      message: `${memoryDir}이(가) 없다 — memory가 초기화되지 않았다(ditto init 먼저).`,
    };
  }

  if (mode === 'submodule') {
    return {
      status: 'manual',
      message: 'submodule 분리는 원격이 선행돼야 해 자동화하지 않는다 — 아래 절차를 따르라.',
      manual: submoduleManual(memoryDir),
    };
  }

  const alreadyRepo = deps.pathExists(join(memoryDir, '.git'));
  if (!alreadyRepo) {
    const r = await deps.run('git', ['init'], memoryDir);
    if (r.exit_code !== 0) {
      return {
        status: 'failed',
        message: `git init 실패 (exit=${r.exit_code ?? 'null'})${r.stderr ? `: ${r.stderr.trim()}` : ''}`,
        manual: [
          `cd ${memoryDir} && git init`,
          `echo '${GITIGNORE_ENTRY}' >> ${deps.repoRoot}/.gitignore`,
        ],
      };
    }
  }

  const added = ensureGitignored(deps);
  if (alreadyRepo && !added) {
    return { status: 'already', message: `${memoryDir}은(는) 이미 분리돼 있고 gitignore됨` };
  }
  return {
    status: 'separated',
    message: `memory를 별도 저장소로 분리: ${memoryDir} (git init) + 부모 .gitignore에 ${GITIGNORE_ENTRY} 추가`,
  };
}

/** 실제 git·fs를 쓰는 기본 deps. */
export function defaultMemorySeparateDeps(repoRoot: string): MemorySeparateDeps {
  const gitignorePath = pathJoin(repoRoot, '.gitignore');
  return {
    repoRoot,
    run: async (cmd, args, cwd) => {
      const proc = Bun.spawn([cmd, ...args], {
        cwd,
        stdout: 'ignore',
        stderr: 'pipe',
        stdin: 'ignore',
      });
      const [exit_code, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stderr).text().catch(() => ''),
      ]);
      return { exit_code, stderr };
    },
    pathExists: (p) => existsSync(p),
    readGitignore: () => (existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : ''),
    writeGitignore: (content) => writeFileSync(gitignorePath, content, 'utf8'),
  };
}
