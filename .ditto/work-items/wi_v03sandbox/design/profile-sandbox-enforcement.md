# Profile Sandbox Enforcement Design

## Decision Summary

wi_v03sandbox는 wi_260524qi9가 도입한 wrapper-level profile policy(pre-spawn cwd 검증 + proxy env scrub + post-run unverified surface) 위에 세 가지 enforcement layer를 얹는다.

- Provider-native sandbox flag matrix를 adapter `spawnRun`에 명시적으로 매핑한다.
- `isolated` profile은 spawn 직전 git worktree를 생성하고 그 path를 cwd로 사용한다.
- 비-networked profile은 codex의 sandbox 모드 부산물로 network가 차단되며, claude-code는 v0.3 시점에 unverified로 surface한다.

이 design note 한 건이 wi_v03sandbox의 AC-2/3/4/5 모두 cover한다.

## Current Reuse Boundary

손대지 않는 것:
- `runWithProvider` orchestration(`src/core/run-with.ts`) — RunStore.create → spawn → pipe → git_after/diff → manifest update → work item linkage 순서.
- `HostAdapter.spawnRun` 계약(`src/core/hosts/types.ts`) — input shape와 process handle은 그대로 사용.
- `policyEnv`와 `profileUnverified`(wrapper-level policy) — 그대로 두고 adapter-level enforcement만 추가.
- `captureGitState`/`listChangedFiles`/`captureGitDiff`(`src/core/git.ts`).
- `spawnProviderProcess`(`src/core/hosts/spawn.ts`) — Bun.spawn 래퍼 그대로 사용.

확장하는 것 한 가지:
- `runManifest` schema에 optional `worktree_path: relativePath` 한 필드 추가. wi_260524qi9 context-packet은 "schema 그대로"라고 했지만 그건 wi_260524qi9 한정 스코프였고, worktree는 wi_v03sandbox가 새로 도입하는 first-class concept이므로 schema에 명시한다. 기존 manifest는 optional이라 backward-compatible.

## 1. Profile → Provider Flag Matrix

[DECIDED] v0.3 매핑:

| profile | codex args prepend | claude-code args prepend | unverified entry |
|---|---|---|---|
| read-only | `--sandbox read-only` | `--permission-mode plan` | claude-code 매핑은 v0.3 stability 검증 부족 surface |
| workspace-write | `--sandbox workspace-write` | `--permission-mode default` | claude-code 매핑은 v0.3 stability 검증 부족 surface |
| reviewer | `--sandbox read-only` (reviewer ≈ read-only 성격) | `--permission-mode plan` | claude-code 매핑은 v0.3 stability 검증 부족 surface |
| networked | `--sandbox workspace-write` (codex는 network-on 별도 flag 없음, default 통과) | `--permission-mode default` | "codex/claude-code network 강제 허용 flag는 v0.3 범위 밖" surface |
| isolated | `--sandbox workspace-write`(worktree 내부) | `--permission-mode default`(worktree 내부) | "claude-code isolated mapping은 v0.3 stability 검증 부족" surface |

매핑은 adapter 내부 상수(예: codex.ts의 `PROFILE_SANDBOX_FLAGS`)에 묶어 한 곳에서 수정 가능하게 한다. 미지원 profile/flag 조합은 매핑이 비어 있는 게 아니라 명시적으로 unverified entry를 동반한다.

## 2. Worktree Lifecycle (isolated Profile)

[DECIDED] 정책:

- **위치**: `.ditto/worktrees/<run_id>/` — predictable, per-run. 같은 run id 안에서 충돌 없음.
- **생성 시점**: `runWithProvider`가 `RunStore.create` 직후, `adapter.spawnRun` 호출 전.
- **cwd substitution**: isolated profile일 때 wrapper가 `input.cwd`(spawnRun에 전달)를 worktree path로 교체한다. 이 substitution은 wrapper layer에서 일어나고 adapter는 자기 input.cwd만 본다.
- **base ref**: 현재 `HEAD`를 기준으로 worktree 생성 (`git worktree add <path> HEAD`).
- **정리 시점**: v0.3에서는 **자동 정리하지 않음**. worktree는 evidence로 보존한다. 명시적 cleanup 명령(`ditto worktree prune` 등)은 후속 work item.
- **실패 처리**: worktree 생성 실패는 `RunWithRuntimeError`로 fail-fast. manifest는 생성 안 됨(RunStore.create 전 단계로 끌어올림 또는 RunStore.create 직후 즉시 실패 처리).
  - [DECIDED] worktree 생성을 `RunStore.create` **이후**에 두고, 실패 시 best-effort로 manifest를 `exit_code: null` + `unverified: ["worktree creation failed: ..."]`로 업데이트한 뒤 throw. 이렇게 하면 wi_260524qi9 failure taxonomy의 "best-effort manifest" 원칙과 일치.
- **manifest 기록**: `runManifest.worktree_path`에 repo-relative path로 기록. isolated 아닌 profile에서는 absent.

## 3. Network-Off Layering

[DECIDED]:

- **codex**: `--sandbox read-only`와 `--sandbox workspace-write` 모드는 codex 본체가 network outbound를 차단한다. 별도 flag 없이 sandbox 매핑의 부산물로 network-off가 달성된다. `networked` profile만 codex `--sandbox workspace-write` + `manifest.unverified`에 "codex network 강제 허용 flag는 v0.3 범위 밖"을 surface한다 (사실상 network는 sandbox로 막혀 있지만, networked가 의도하는 "network 허용"은 보장 못 함).
- **claude-code**: v0.3 시점에 안정적인 network-off flag가 명확하지 않다. 모든 profile에서 `manifest.unverified`에 "claude-code network 강제 차단 flag는 v0.3 범위 밖"을 surface하고, wrapper-level proxy env scrub(기존 `policyEnv`)만 신뢰한다.
- **wrapper layer**: `policyEnv`의 `NETWORK_ENV_KEYS` 4종 scrub은 **그대로 유지**한다. provider-native flag가 있어도 proxy env scrub은 추가 안전 layer로 의미가 있다.

## 4. Schema Extension

[DECIDED] `runManifest`에 optional 한 필드 추가:

```ts
worktree_path: relativePath.optional()
  .describe('Repo-relative path to the per-run git worktree, set when profile=isolated'),
```

- `.json` schema export(예: `schemas/run-manifest.schema.json`)도 동시 갱신.
- 기존 manifest는 optional이라 자동으로 통과 — 회귀 없음.
- `RunStore`의 create input에는 추가하지 않는다. worktree는 `runWithProvider`가 RunStore.create 이후에 별도 update로 set한다.

## 5. Regression Fixture Layout

AC-5의 3-case는 다음으로 cover된다 (기존 fixture와 일부 중복):

| case | 검증 위치 | 검증 내용 |
|---|---|---|
| (a) workspace-write에서 cwd가 repo 밖 | `tests/core/run-with.test.ts`(이미 존재) | `resolveRepoCwd`가 USAGE error로 throw |
| (b) 정상 cwd 안에서 provider가 cwd 밖 write 시도 | `tests/core/run-with.test.ts` 신규 case | mock adapter가 `repoRoot/../escape.txt`에 write 시도하는 fixture. v0.3에서는 wrapper가 `profileUnverified`로 `changed files outside repo` surface(이미 구현). 실제 차단은 sandbox flag가 강제하는데, mock에서는 차단 시뮬레이션이 어렵다. 따라서 **post-run unverified surface로만 검증**한다. provider-native sandbox 실효성은 smoke test로 별도 검증. |
| (c) read-only/reviewer에서 writes detected | `tests/core/run-with.test.ts`(이미 존재) | `profileUnverified`가 'profile violated: writes detected' 기록 |

신규 fixture는 (b)와 isolated profile worktree 검증, profile별 flag 매핑 검증이다.

## 6. Test Surface

신규/추가:
- `tests/core/run-with.test.ts`:
  - isolated profile fixture: mock adapter가 input.cwd가 worktree path임을 확인하고, manifest.worktree_path가 기록됨을 검증.
  - workspace-write에서 mock provider가 cwd 밖 write 시도 → changed_files에 `..` path가 들어가고 unverified에 surface (case b).
- `tests/core/hosts/codex-spawn.smoke.test.ts`:
  - profile 5종에 대해 adapter spawnRun이 args에 매핑된 sandbox flag를 prepend함을 검증(mock binary 또는 args echo로).
- `tests/core/hosts/claude-code-spawn.smoke.test.ts`:
  - 동일하게 permission-mode flag 검증.
- 기존 round-trip schema 회귀(`tests/core/run-store.test.ts` + `tests/schemas/repo-self-validation.test.ts`)는 worktree_path가 optional이라 자동 통과.

## Out Of Scope (재확인)

- worktree 자동 cleanup 명령(`ditto worktree prune`).
- model_reported stdout parsing.
- claude-code permission-mode 매핑의 v0.4+ stability validation (v0.3에서는 best-effort + unverified surface).
- OpenCode/OpenAgent adapter.
- `ditto verify` ↔ `runManifest.verifications` 연결(wi_v03verify로 분리).
