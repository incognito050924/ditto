# run — provider(코딩 에이전트) 실행을 감사 가능한 run manifest로 기록·포착하는 커맨드

> 문서 성격: 코드 설명(재설계용). 코드 변경에 자동 동기화되지 않으므로 시간이 지나면 실제 코드와 어긋날 수 있다(권위는 코드에 있다). 기준 커밋: `c2d2e16`, 작성일: 2026-07-19.

## 1. 이 기능이 실현하려는 설계 의도 (개념)

`ditto run`은 provider(외부 코딩 에이전트 — codex, claude-code 등) 한 번의 호출을 **하나의 감사 가능한 레코드(run manifest)로 남기는** 커맨드다. DITTO의 오케스트레이션 모델에서 실제 코드 변경은 provider가 수행하는데, 그 실행이 무엇을 입력받아 무엇을 바꿨는지 증거 없이 흘러가면 완료를 증거로 말할 수 없다(charter §4-5). run은 그 실행 하나하나를 work item에 붙는 불변 산출물로 포착해, 나중에 누가·어떤 provider·어떤 profile로·git 상태가 어떻게 바뀌었고·exit code가 무엇이었는지를 재구성할 수 있게 한다.

두 개의 서브커맨드가 서로 다른 신뢰 수준을 담당한다:
- `run record` — 이미 (밖에서) 일어난 provider 실행을 **사후에 손으로 기록**한다. DITTO는 실행하지 않고 사용자가 준 메타데이터만 받아 적는다.
- `run with` — provider를 **DITTO가 직접 spawn**하고 stdout/stderr/diff/exit_code/git 전후 상태를 **자동 포착**한다. 증거의 자동성이 record보다 높다.

DITTO 4축 중 **오케스트레이션 축**의 실행-포착 지점에 속한다(의도→계획 이후 실제 변경을 만들어내는 provider 호출을 감사 레코드로 붙잡는 계층). 산출물 저장 정책 측면에서는 배포/거버넌스가 아니라 런타임 트레일(ADR-0005·ADR-20260706의 Run tier)에 해당한다.

## 2. 코드 위치와 진입점

| 경로 | 역할 |
|---|---|
| `src/cli/commands/run.ts` | CLI 진입점. `record`·`with` 서브커맨드 정의, 인자 파싱, 출력 포맷 |
| `src/core/run-with.ts` | `run with`의 실행 엔진. provider spawn → 아티팩트 포착 → manifest 갱신 → work item 링크 |
| `src/core/run-store.ts` | run manifest per-entity 파일 Store (create/get/update, 경로 계산) |
| `src/schemas/run-manifest.ts` | run manifest zod 스키마(SoT, ADR-0002). `gitState`·`verification`·`runManifest` |
| `src/core/hosts/types.ts` | `HostAdapter.spawnRun` 계약, `HostRunProcess`/`HostRunCompletion` |
| `src/core/hosts/claude-code.ts`, `.../codex.ts`, `.../spawn.ts` | 각 provider의 spawnRun 구현 |
| `src/core/git.ts` | `captureGitState`·`captureGitDiff`·`listChangedFiles` (git 전후 상태·diff·변경 파일) |
| `src/core/worktree.ts` | `createWorktreeForRun` (profile=isolated일 때 per-run worktree) |
| `src/core/ditto-paths.ts` | `localDir` → run 산출물이 사는 `.ditto/local/runs/<id>/` 경로 |

### 서브커맨드·CLI 인자

`run record` (`src/cli/commands/run.ts:18-126`):

| 인자 | 필수 | 기본값 | 설명 |
|---|---|---|---|
| `workId` (positional) | ✅ | — | 이 run을 붙일 work item id |
| `--provider` | ✅ | — | `codex\|claude-code\|opencode\|openagent\|other` |
| `--profile` | | `workspace-write` | 실행 profile |
| `--entrypoint` | | `${provider}` | provider가 어떻게 호출됐는지 |
| `--model` | | `null` | provider가 보고한 모델(`""`/생략 → null) |
| `--prompt` | | — | prompt/context packet 파일 경로 |
| `--output` | | `human` | `human\|json` |

`run with` (`src/cli/commands/run.ts:128-233`):

| 인자 | 필수 | 기본값 | 설명 |
|---|---|---|---|
| `--provider` | ✅ | — | 실행 가능한 provider: `codex\|claude-code` |
| `--work-item` | ✅ | — | 붙일 work item id |
| `--profile` | | `workspace-write` | 실행 profile |
| `--prompt` | | — | repo-상대 prompt 경로(존재 검증됨) |
| `--verify` | | — | provider 종료 후 실행할 명령(공백 분할, no shell). `verifications`에 기록 |
| `--output` | | `human` | `human\|json` |
| `-- <args...>` | ✅ | — | `--` 뒤 실제 provider argv. 없으면 usage 에러(`run.ts:176-182`) |

## 3. 데이터 흐름 (입력 → 변환 → 저장/출력)

두 서브커맨드 모두 **최종 산출물은 하나의 run manifest 파일**이다:
`.ditto/local/runs/<run_id>/manifest.json` (`run-store.ts:22-28`, `run-with.ts:188`).

이 경로는 `.ditto/local/` 아래 = **gitignored Run tier**(개인·폐기가능; `.gitignore:473-477`, ADR-20260706). manifest 외에 `run with`는 같은 디렉터리에 `stdout.log`·`stderr.log`·`diff.patch`·(있으면)`verify.log`를 per-entity 파일로 남긴다(`run-store.ts:39-44`).

`run record` 흐름:
```
사용자 메타데이터(provider/profile/entrypoint/model/prompt)
  + captureGitState(repoRoot)                        [git.ts:4]
  → RunStore.create(...)                              [run-store.ts:46]
      → .ditto/local/runs/<id>/manifest.json 생성(zod 검증)
  → WorkItemStore.update: item.runs 에 run_id append  [run.ts:102-105]
  → human/json 출력(run_id·manifest_path)
```

`run with` 흐름:
```
provider argv(`--` tail) + work item
  → parseRunnableProvider (codex|claude-code만 통과)   [run-with.ts:112]
  → git_before = captureGitState(repoRoot)             [run-with.ts:177]
  → RunStore.create(exit_code:null, started_at)        [run-with.ts:178]
  → (profile=isolated) createWorktreeForRun → runRoot 교체  [run-with.ts:201-219]
  → adapter.spawnRun({repoRoot,cwd,profile,args,env})  [run-with.ts:223]
  → captureArtifacts: stdout/stderr→파일, completion 대기, diff.patch 기록  [run-with.ts:123]
  → listChangedFiles(runRoot, excludeDittoRuns)        [run-with.ts:257]
  → profileUnverified(profile, changedFiles)           [run-with.ts:258]
  → RunStore.update: git_after·changed_files·경로·exit_code·ended_at·unverified  [run-with.ts:259]
  → (--verify) runVerifyStep → verifications[] append  [run-with.ts:287]
  → WorkItemStore.update: item.runs 에 run_id append(중복 방지)  [run-with.ts:292]
  → human/json 출력, exit_code≠0/null 이면 그 코드로 프로세스 종료
```

읽고 쓰는 상태:
- **work item Record** (`WorkItemStore`): `item.runs` 배열에 run_id를 append(양쪽 서브커맨드). run과 work item의 링크가 여기 산다.
- **run manifest** (`RunStore`, 스키마 `run-manifest.ts:36`): 위 경로에 per-entity JSON.
- **context-packet 소비** (`context-packet.ts:47-83`): work item의 context packet을 만들 때 `item.runs`를 순회해 각 run manifest를 읽어 `- <run_id>: exit_code=<n>` 형태로 요약한다 — run manifest의 유일하게 확인된 하류 소비처.

## 4. 핵심 개념과 채택 이유 (왜 이 개념인가)

**per-entity 파일 저장 (공유 DB 아님) — ADR-0005 D1.** run manifest는 SQLite 같은 공유 가변 DB가 아니라 run 하나당 JSON 하나로 저장된다. 근거: git diff/audit 보존, 동시 작업 시 서로 다른 산출물이 설계상 머지 충돌이 없음, `cat`/`jq`로 즉시 읽는 디버그성(ADR-0005:22-27). run은 그 정책 아래 `runs/` = ephemeral/gitignored 계층으로 분류된다(ADR-0005:21, D2).

**Record/Run tier 분리 — ADR-20260706.** run manifest는 `.ditto/local/runs/`(개인·폐기가능 Run tier)에 산다. work item **Record**(status·AC verdict)는 커밋·공유되지만, 그 실행 트레일인 run은 로컬에만 남고 **삭제해도 Record는 살아남는다**(ADR-20260706:19). run을 개인 tier에 둔 것은 "무엇이 durable하고 무엇이 폐기가능한가"를 필드/자산 단위로 가르는 결정의 결과다.

**스키마가 SoT — ADR-0002.** manifest의 모양은 `run-manifest.ts`의 zod가 유일한 진실원이다. `RunStore.create`/`update`는 쓰기 시점에 항상 `runManifest`로 검증한다(`run-store.ts:67,80`) — 스키마에 맞지 않는 manifest는 디스크에 못 남는다.

**profile = 정책 선언 + 사후 검증(집행 아님).** profile은 네트워크 env 차단(`run-with.ts:74-83`: networked가 아니면 `HTTP(S)_PROXY` 등 unset)과 provider별 권한 모드 매핑(claude-code는 `--permission-mode`, `claude-code.ts:302-325`)에만 실제 영향을 준다. read-only/reviewer profile에서 쓰기가 감지되면 `profileUnverified`가 `unverified`에 기록만 할 뿐 롤백하지 않는다(`run-with.ts:85-98`). 즉 profile은 강제 샌드박스가 아니라 **선언된 의도 + 위반 시 증거 남김**이다.

**verify 명령은 shell 없이 공백 분할.** `--verify`는 `command.split(/\s+/)`로 토큰화해 `Bun.spawnSync`로 직접 실행한다(`run-with.ts:313-344`). 셸 해석을 거치지 않으므로 파이프·리다이렉트·글롭이 동작하지 않는다 — 주입 표면을 줄이려는 의도적 제약(스키마 설명도 "Whitespace-split, no shell", `run.ts:157`).

## 5. 코드 분해 (무슨 코드가 무슨 효과를 내는가)

**`runRecord.run` (`run.ts:60-125`).** provider/profile 문자열을 `as` 캐스트로 좁힌 뒤(런타임 검증 없음) `git = captureGitState` → `runStore.create`로 manifest를 만들고, work item의 `runs`에 append한다. exit_code·changed_files 등 실행 산출물은 채우지 않는다(사후 기록이라 DITTO가 실행을 보지 못했기 때문). 효과: "이런 실행이 있었다"는 최소 레코드만 남는다.

**`runWithProvider` (`run-with.ts:159-304`) — 실행 엔진.** 순서 의존이 핵심이다:
1. `parseRunnableProvider`(`:112-115`)가 codex/claude-code만 통과시킨다. 다른 schema-valid provider(opencode 등)는 여기서 `RunWithUsageError`로 막힌다 — "스키마엔 있으나 실행 불가".
2. `resolveRepoCwd`(`:61-72`)가 cwd가 repo root를 벗어나는지 검사(`cwd escapes repo root`). path traversal 방지.
3. spawn **전에** `runStore.create`로 manifest를 먼저 만든다(`:178`). 이후 모든 실패 경로가 이 manifest를 `update`로 갱신하므로, **provider가 죽어도 레코드는 남는다**(exit_code=null + unverified/notes).
4. `spawnRun`은 host adapter로 위임(`:223`). DITTO 코어는 provider를 직접 spawn하지 않고 adapter 계약(`HostAdapter.spawnRun`, `types.ts:137`)만 안다.
5. `captureArtifacts`(`:123-157`)가 stdout/stderr를 스트림→파일로 흘리고, `adapterProcess.completion`을 대기한다. completion promise가 reject되면 그것을 삼켜 `unverified`에 "HostAdapter contract bug"로 남기고 계속 진행한다(fail-closed가 아니라 fail-recorded).
6. `listChangedFiles(runRoot, {excludeDittoRuns:true})`(`:257`, `git.ts:64`)로 변경 파일을 수집하되 `.ditto/local/runs/` 경로는 제외한다 — run 자신의 산출물이 changed_files를 오염시키지 않도록.
7. `profileUnverified`(`:258`)가 profile 위반을 `unverified`에 누적.

**실패 경로별 처리.** worktree 생성 실패(`:207-218`), spawnRun throw(`:230-243`)는 각각 manifest를 exit_code=null + notes로 마감하고 `RunWithRuntimeError`를 던진다. CLI(`run.ts:217-231`)는 이 에러 종류로 종료 코드를 가른다(usage=2, runtime=별도). 효과: 어떤 실패든 manifest에 흔적이 남고, exit code로 호출자에게 전달된다.

**work item 링크가 마지막.** `item.runs` append(`:292-295`)는 실행·포착이 다 끝난 뒤 일어난다. 이미 포함돼 있으면 다시 넣지 않는다(멱등). 이 링크가 실패하면 manifest는 이미 존재하는 채로 `RunWithRuntimeError`가 난다 — 즉 고아 manifest가 생길 수 있다(§7 참조).

**`RunStore` (`run-store.ts`).** `create`는 `generateId('run', ...)`로 충돌 없는 id를 만들고 draft를 zod로 검증해 쓴다. `update`는 read→mutator→write이며 id가 바뀌면 throw(`:77-79`) — 실수로 다른 run을 덮어쓰는 것을 막는 가드. 파일 락은 없다(single-writer 가정, ADR-20260628 상속).

**`gitState`/`captureGitState` (`git.ts:4-31`).** head는 40자 sha, 실패 시 `0`*40으로 폴백(비-git 환경에서도 죽지 않음). dirty/untracked_count는 `git status --porcelain`에서 파생. `git_before`는 무조건, `git_after`는 실행 후에만 채워진다.

## 6. 설계 의도 ↔ 실제 동작 일치 여부

확인 범위: `run.ts`·`run-with.ts`·`run-store.ts`·`run-manifest.ts`·`git.ts`·`hosts/types.ts`·`claude-code.ts`(spawnRun 부분)·`context-packet.ts` 정적 읽기. 테스트 실행이나 런타임 재현은 하지 않음(읽기 전용 조사).

대체로 의도와 일치하나 다음 갭·불일치가 있다:

1. **`entrypoint` 스키마 설명 vs 실제값 불일치.** 스키마는 entrypoint를 `"codex exec" or "claude code"` 예시로 설명한다(`run-manifest.ts:42-45`). 그러나 `run with`의 실제 값은 spawn 후 `adapterProcess.entrypoint`로 갱신되는데(`run-with.ts:245-248`), claude-code adapter의 `spawnProviderProcess`는 `entrypoint: input.binary` = `"claude"`만 넣는다(`spawn.ts:54`). `run record`는 기본값이 `${provider}` = `"codex"`(`run.ts:90`). 즉 실제 저장값은 스키마 예시의 "exec"/서브커맨드 없는 바이너리 이름이다. 기능 결함은 아니고 설명 drift.

2. **`run record`의 provider/profile 미검증(친절도 갭).** `run record`는 `as` 캐스트만 하고(`run.ts:74-85`) 런타임 검증을 하지 않는다. 잘못된 값은 `runStore.create`의 zod 쓰기 검증에서야 실패한다 — `run with`가 `safeParse`로 선검증해 명확한 usage 에러를 주는 것(`run.ts:185-192`)과 대비된다. 동작상 안전하나(디스크엔 못 남음) 오류 메시지 품질이 낮다.

3. **`v0.3` 하드코딩 문구.** `parseRunnableProvider`의 에러("not runnable in v0.3", `run-with.ts:114`)와 claude-code adapter의 unverified 문구("best-effort in v0.3", `claude-code.ts:317`)가 특정 버전을 문자열로 박아뒀다. 현재 동작에는 영향 없으나 버전 drift 소지.

4. **model_reported는 사실상 항상 null(자동 경로).** `run with`에서 completion.model_reported는 `spawn.ts:37,46`이 항상 `null`을 넣는다 — provider 출력에서 모델명을 파싱하지 않는다. 스키마 필드는 있으나 자동 채움은 미구현이고, `run record --model`로 손으로 넣을 때만 값이 생긴다. 의도된 축소인지 미완인지는 코드만으로 미확인.

## 7. 잠재 위험·부작용·재설계 시 고려점

**동시성·정합성.**
- `RunStore`에 파일 락이 없다(single-writer 가정). run manifest는 run당 파일이라 서로 안 부딪히지만, **`WorkItemStore.update`의 `item.runs` append는 공유 work item Record를 건드린다**. 두 run이 동시에 같은 work item에 append하면 read-modify-write 경합이 가능하다. work-item-store가 per-event 로그로 이를 완화하는지는 이 조사 범위 밖(미확인).
- **고아 manifest.** manifest는 spawn 전에 만들어지고 work item 링크는 맨 끝이다. 링크 단계에서 예외가 나면(`run-with.ts:296-301`) manifest는 디스크에 남지만 `item.runs`엔 없어 `context-packet`이 영영 못 본다. run tier가 폐기가능(ADR-20260706)이라 데이터 손실은 아니나, "실행했는데 work item에서 안 보임"이 될 수 있다.

**보존해야 할 불변식(재설계 시).**
- **spawn 전 manifest 생성** — provider가 죽어도 감사 레코드가 남는 성질. 이 순서를 뒤집으면 크래시한 실행이 흔적 없이 사라진다.
- **changed_files의 `.ditto/local/runs/` 제외** — run 산출물이 자기 변경 목록을 오염시키지 않게 하는 가드(`run-with.ts:257`). MEMORY의 changed_files 오염 반복 사고 맥락과 직결.
- **verify no-shell** — `--verify`의 공백 분할·no shell(`run-with.ts:313`)은 주입 표면 축소. 편의를 위해 셸을 허용하면 이 불변식이 깨진다.
- **profile 네트워크 차단** — networked 아니면 프록시 env unset(`run-with.ts:74-83`). 유일하게 실제 집행되는 profile 효과.

**재고 가능한 결정.**
- profile이 "선언 + 사후 unverified"일 뿐 강제 샌드박스가 아니라는 점. read-only에서 실제로 파일이 써져도 되돌리지 않는다 — 격리가 필요하면 profile=isolated(worktree)로만 물리 격리된다. 강제 집행이 필요한 위협 모델이면 재설계 지점.
- `model_reported` 자동 미채움(§6-4). provider 출력 파싱을 추가하면 채울 수 있으나 provider별 포맷 의존이 생긴다.
- `entrypoint` 값 규약이 스키마 설명과 어긋남(§6-1). 재설계 시 "바이너리 이름 + 서브커맨드"로 규약을 확정하거나 스키마 설명을 실제에 맞춰야 drift가 준다.
