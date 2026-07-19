# push-gate — recipe가 선언한 브랜치로 push하기 전에 test_command 통과를 강제하는 git pre-push 게이트

> 문서 성격: 코드 설명(재설계용). 코드 변경에 자동 동기화되지 않으므로 시간이 지나면 실제 코드와 어긋날 수 있다(권위는 코드에 있다). 기준 커밋: `c2d2e16` (2026-07-19).

## 1. 이 기능이 실현하려는 설계 의도 (개념)

push는 **비가역**이다. 원격 공유 브랜치에 올라간 커밋은 되돌리기 어렵고 다른 사람에게 곧바로 샌다. Charter §4-8은 이 비대칭을 명시한다: commit은 가역적이라 agent가 소유하지만, push는 비가역이라 user-gated다. push-gate는 이 원칙을 **자동화된 게이트**로 코드화한 것이다 — "보호된 브랜치로 push할 때는 recipe가 선언한 전체 테스트 스위트가 통과해야 한다"를 git pre-push 훅에서 강제한다.

핵심 설계 결정은 **fail-closed**다. 게이트를 *평가할 수 없을 때*(recipe가 깨졌거나, 테스트 러너가 안 뜨거나, 테스트가 hang) push-gate는 조용히 통과시키지 않고 **막는다**. push는 비가역이므로, 검증하지 못한 push를 허용하는 것(거짓 확신)보다 막는 것이 낫다는 판단이다 (src/cli/commands/push-gate.ts:31-35, 79-93).

DITTO 4축 분류상 이것은 **거버넌스·배포**에 속한다. 의도·오케스트레이션·E2E·지식 4축이 아니라, 코드가 원격으로 나가는 배포 경계(deployment seam)를 지키는 게이트다. ADR-20260708이 명시하듯 push-gate는 통합/E2E/전체 스위트를 다루는 세 배포 표면(push-gate·CI·`ditto e2e`) 중 하나이며, autopilot 완료 barrier(유닛 tier)와 **의도적으로 tier가 다르다** (.ditto/knowledge/adr/ADR-20260708-autopilot-test-tier-boundary.md:14, 32).

## 2. 코드 위치와 진입점

| 경로 | 역할 |
|------|------|
| `src/cli/commands/push-gate.ts` | CLI 진입점. stdin 읽기, recipe 해석, 트리 상태·캐시 계산, `execPushGate` 호출, exit code 채택. |
| `src/core/push-gate.ts` | PURE 결정 로직. pre-push stdin 파싱(`parsePushedBranches`), 게이트 발화 여부 결정(`pushGateDecision`), per-repo 게이트 해석(`resolvePushGate`), 루트-only 신뢰 판정(`isRepoDeclared`). I/O 없음. |
| `src/core/push-gate-cache.ts` | green-tree 캐시. 클린 트리의 exact 해시가 이미 통과했으면 재실행 skip. clean 판정·record 조건·FIFO 상한. |
| `src/core/test-runner.ts` | 공유 test 러너 + 4-terminal 분류(`passed/failed/unrunnable/timeout`). push-gate와 barrier가 exit code를 한 소스에서 판별. |
| `src/schemas/recipe.ts` | `recipePushGate` 스키마 (SoT, ADR-0002). `protected_branches` + `test_command`. |
| `resources/hooks/pre-push` | 설치되는 git 훅 템플릿. stdin을 `ditto push-gate`로 파이프하고 exit code를 채택. |

CLI 인자:

| 인자 | 타입 | 역할 |
|------|------|------|
| `--workspace-root <abs>` | string(optional) | 이 push를 지배하는 **신뢰된 workspace 루트**의 절대 경로. 설치된 sub-repo pre-push 훅이 전달(setup/workspace sync가 배선). 클론된 sub-repo가 자기 recipe를 해석하지 못하게 하는 ROOT-ONLY 신뢰. 일반 단일 repo push에서는 생략. (src/cli/commands/push-gate.ts:333-338) |

서브커맨드는 없다. 게이트는 stdin(git pre-push 라인)을 받아 exit code 0(allow)/non-zero(block)만 낸다.

## 3. 데이터 흐름 (입력 → 변환 → 저장/출력)

입력은 **git pre-push stdin**이다. git이 push할 각 ref마다 `<localref> <localsha> <remoteref> <remotesha>` 한 줄씩 훅의 stdin으로 먹인다. 훅이 이걸 `ditto push-gate`로 그대로 파이프한다 (resources/hooks/pre-push의 `exec "$@"`, src/cli/commands/push-gate.ts:317-324).

```
git push
  └─> .git/hooks/pre-push (DITTO_SKIP_HOOKS 체크 → ditto 바이너리 해석 → stdin 파이프)
        └─> ditto push-gate [--workspace-root <abs>]
              1. readStdin()                        ← git ref 라인들
              2. resolvePushGateRoot(cwd, wsRoot)   ← 신뢰된 recipe 루트 + repoRelDir
              3. loadResolvedRecipe(recipeRoot)     ← recipe.yaml (malformed 플래그)
              4. resolvePushGate(recipe, repoRelDir)← 이 repo의 push_gate
              5. computeTreeState(cwd)              ← HEAD tree 해시 + clean 여부
              6. readGreenCache(recipeRoot)         ← .ditto/local/push-gate-green.json
              7. execPushGate({...})                ← 결정 + (필요시) test 실행
                    └─ pushGateDecision(parsePushedBranches(stdin), gate)
                    └─ shouldSkipGate?  → skip (캐시 히트)
                    └─ runTest(test_command, cwd) → 4-terminal 분류
                    └─ passed → recordGreen(tree) → exit 0
                    └─ 그 외 non-pass → exit 1 (block, fail-closed)
              8. process.exit(result.exitCode)      → git이 채택
```

읽고 쓰는 상태 파일:

- **recipe.yaml** (읽기): workspace 루트의 `.ditto/recipe.yaml`. `push_gate.protected_branches` + `push_gate.test_command`를 담는다 (스키마: src/schemas/recipe.ts:52-57).
- **`.ditto/local/push-gate-green.json`** (읽기·쓰기): green-tree 캐시. gitignored된 `.ditto/local/` 아래라 per-machine이고 커밋되지 않는다 (src/core/push-gate-cache.ts:108-110). 스키마는 `{ trees: GreenTree[] }`, `GreenTree = { tree, recorded_at, command }` (push-gate-cache.ts:23-32).

출력은 stderr에 쓰는 human guidance 메시지(막을 때만)와 exit code뿐이다 (src/cli/commands/push-gate.ts:367-368).

## 4. 핵심 개념과 채택 이유 (왜 이 개념인가)

### 4-1. fail-closed (비가역 push의 비대칭)

push-gate의 모든 non-pass terminal은 push를 **막는다**. malformed recipe, unrunnable 러너, timeout 모두 block이다 (src/cli/commands/push-gate.ts:96-146). 이유: push는 비가역이므로 게이트를 평가 못 하면 막는 게 안전하다. ADR-20260708 D4는 이것이 barrier의 정반대임을 명시한다 — 같은 `unrunnable` 신호를 놓고 **barrier는 degrade-PROCEED**(완료=가역, 도구 부재가 자율성을 인질로 잡지 않음), **push-gate는 fail-closed BLOCK**(push=비가역). 두 표면이 같은 판별 결과를 반대 방향으로 라우팅하는 건 버그가 아니라 tier별 위험 비대칭의 의도된 반영이다 (.ditto/knowledge/adr/ADR-20260708-autopilot-test-tier-boundary.md:38-42).

### 4-2. override-only (default-on 없음)

`push_gate`가 recipe에 없으면 게이트는 **비활성**이다. 기본으로 켜지지 않는다 (src/core/push-gate.ts:45, src/schemas/recipe.ts:47-50). recipe의 "명시 override만" 철학과 일치한다. 절반만 선언된 게이트(브랜치만 있고 명령 없음 등)는 조용히 무동작이 아니라 **validation 실패**로 드러난다 (`protected_branches.min(1)`, `test_command.min(1)`, recipe.ts:54-55).

### 4-3. ROOT-ONLY 신뢰 (클론 sub-repo RCE 방어)

`ditto workspace sync`는 선언된 sub-repo를 workspace로 클론한다. 클론된 sub-repo가 자기 `.ditto/recipe.yaml`에 악성 `push_gate.test_command`를 실을 수 있다. 순진한 walk-up(첫 `.ditto` 조상에서 멈춤)이면 클론 안에서 push할 때 **클론의 명령**을 실행 — push-time RCE다. `resolvePushGateRoot`은 신뢰된 workspace-루트 recipe에 앵커하고 클론의 recipe를 절대 참조하지 않는다 (src/cli/commands/push-gate.ts:176-221). 배경 결정: wi_2606299kn ac-3.

### 4-4. green-tree 캐시 (동시세션 flake 완화 + 재실행 비용)

push-gate는 전체 스위트를 돌린다(실측 ~200s, src/cli/commands/push-gate.ts:149-156). 같은 클린 트리를 다시 push할 때마다 전체 재실행은 비싸다. green-tree 캐시는 **exact git-tree 해시 + clean 트리**가 이미 통과했으면 재실행을 skip한다 (push-gate-cache.ts:3-14). 캐시는 tree 해시로 content-addressed라 worktree 간 공유가 안전하다(green 트리는 어느 브랜치가 만들었든 green). 이게 공유트리 동시세션에서 반복 push마다 전체 스위트를 다시 돌리는 flake·비용을 줄인다.

## 5. 코드 분해 (무슨 코드가 무슨 효과를 내는가)

### `execPushGate` — 결정 우선순위 (src/cli/commands/push-gate.ts:94-147)

이 함수가 게이트의 심장이다. `runTest`를 주입받는 것 외에는 PURE다. 우선순위:

1. **`DITTO_SKIP_HOOKS` set → exit 0** (line 95). malformed·failing 테스트보다도 우선하는 sanctioned escape hatch.
2. **malformed recipe → block** (line 96-101). recipe 파일은 있는데 파싱 불가 → 어느 브랜치가 보호되는지 알 수 없으니 fail-closed.
3. **보호 브랜치 없음 → exit 0** (line 102-103). `pushGateDecision`이 `run:false`.
4. **보호 push → `runTest` 실행** (line 115-146). `passed`→allow(+record green), `failed`→block, `unrunnable`→block, `timeout`→block. 모든 non-pass가 fail-closed.

숨은 결정: `timeout`은 "hang(deadlock/stdin 대기)이 wall clock을 넘김"을 뜻하며, 전체 스위트가 느린 것과 구별하려고 push-gate 전용 10분 상한(`PUSH_GATE_TIMEOUT_MS`, line 156)을 쓴다. barrier의 짧은 기본값을 재사용하면 안 된다고 주석이 명시(line 149-155).

### `pushGateDecision` — 게이트 발화 여부 (src/core/push-gate.ts:41-56)

`config` 있음 AND push된 브랜치 중 최소 하나가 `protected_branches`에 있음 → 발화. 미묘한 결정 둘:

- **`"*"` sentinel** (line 51-53): `protected_branches`에 리터럴 `"*"`가 있으면 모든 push 브랜치가 보호 대상. 그 외에는 exact-match다. `"release/*"` 같은 부분 패턴은 **globbing 안 함** — `"*"`만 특별하다 (line 46-49). 재설계 시 주의점: glob을 기대하면 어긋난다.

### `parsePushedBranches` — stdin 파싱 (src/core/push-gate.ts:18-29)

- **삭제(local sha all-zero)는 skip** (line 24): push할 커밋이 없으니 테스트할 게 없다.
- `refs/heads/<branch>`만 브랜치로 인정. 태그/기타 ref는 무시 (line 25). 슬래시 브랜치명은 통째로 보존.

### green-tree 캐시 안전 불변식 (src/core/push-gate-cache.ts)

- **`shouldSkipGate`** (line 77-80): clean AND tree 해시가 기록됨일 때만 skip. dirty 트리나 미기록 해시는 항상 전체 실행.
- **`shouldRecordGreen`** (line 87-93): 실행 명령이 게이트 명령과 **byte-identical**이고 트리가 clean일 때만 기록. scoped subset 명령은 전체 게이트에 대해 아무것도 증명 못 하므로 skip을 seed하면 안 된다(poison barrier 방어).
- **`isTreeCleanIgnoringTrails`** (line 63-70): untracked 런타임 trail(`.ditto/work-items/`, `.ditto/memory/`)만 dirty에서 면제. 이들은 ditto가 단지 실행만으로 쓰는 부산물이고 HEAD tree 해시를 바꾸지 않는다. 트레일링 슬래시가 load-bearing — `.ditto/work-items-x/` 같은 형제는 매치 안 됨 (line 44-50). tracked/staged 변경은 trail prefix 아래라도 dirty로 간주 → 게이트 약화 없음.
- **`addGreenTree`** (line 96-105): dedupe(newest wins) + FIFO 상한 `MAX_GREEN_TREES=20`.

### 캐시 read/write의 fail-safe (src/cli/commands/push-gate.ts:262-287)

- `readGreenCache`: 없거나 corrupt하면 빈 캐시로 읽음 → **false skip 절대 없음** (line 262-273).
- `makeRecordGreen`: 캐시 쓰기 실패는 전부 swallow → **정당한 push를 절대 막지 않음** (line 275-287). 캐시는 최적화지 게이트가 아니라는 원칙.

### 크로스툴 producer — `maybeRecordGreenForGate` (src/cli/commands/push-gate.ts:289-315)

`ditto verify -- bun test` 같은 **다른 명령**이 push 게이트의 exact `test_command`를 클린 트리에서 통과시키면 green 캐시를 미리 채워, 뒤따르는 그 트리의 push가 재실행을 skip한다. exact-command 매치가 poison barrier — subset 명령은 기록 안 함 (line 310). best-effort라 어떤 에러도 caller 결과에 영향 없음. 유일 caller는 `src/cli/commands/verify.ts:116`.

### `computeTreeState` — 트리 정체성 (src/cli/commands/push-gate.ts:244-260)

`git rev-parse HEAD^{tree}`로 tree 해시, `git status --porcelain`(untrimmed)로 clean 여부. HEAD 없음(unborn)이나 git 불가 → undefined → caller가 skip 안 함(fail-safe: 전체 게이트 실행). git-status 실패(null)도 clean=false로 fail-safe. **untrimmed** 강조: 전역 trim이 첫 줄의 status-column 앞 공백을 벗겨 ` M path`(tracked-modified)와 `?? path`(untracked)를 혼동시킨다 (line 223-242, 252-253).

## 6. 설계 의도 ↔ 실제 동작 일치 여부

확인 범위(위 6개 파일 + 훅 템플릿 + 스키마 + ADR-20260708) 안에서 코드는 문서화된 의도와 일치한다. 근거:

- fail-closed 4-terminal이 모두 `exitCode:1`을 낸다 (push-gate.ts:128-145). block 방향이 의도(§4-1)와 일치.
- ROOT-ONLY 신뢰가 훅 템플릿의 `WS_ROOT` 배선(resources/hooks/pre-push)과 `resolvePushGateRoot`의 3-tier 우선순위(explicit → repos[] walk-up → 단일 repo, push-gate.ts:197-221)로 양쪽에서 닫힌다.
- green 캐시 안전 불변식(clean AND exact-hash AND exact-command)이 skip/record 양쪽에서 강제된다 (push-gate-cache.ts:77-93).

**미확인 지점 1개**: `--workspace-root`가 sub-repo 훅에 실제로 배선되는 경로(setup/workspace sync가 `WS_ROOT` 라인을 rewrite)를 이 조사에서 `src/core/setup.ts:625-628`의 substitutable 라인 검증까지는 확인했으나, 실제 sub-repo 클론에 대한 end-to-end 배선(clone.ts:204 "WS_ROOT pinned to root")의 정확한 치환 코드는 라인 단위로 추적하지 않았다 — **미검증**. `scripts/smoke-push-gate.ts`가 스모크로 존재하나 실행하지 않았다.

## 7. 잠재 위험·부작용·재설계 시 고려점

- **`"*"`만 glob, 부분 패턴 미지원**: `release/*` 같은 패턴을 protected_branches에 넣으면 exact-match 실패로 조용히 게이트가 안 걸린다 (src/core/push-gate.ts:46-53). 재설계 시 glob 도입은 자연스러운 확장이지만, 현재 계약을 아는 사용자가 `*`를 리터럴로 기대할 수 있으니 마이그레이션 주의.
- **green 캐시와 동시세션 공유트리**: 캐시는 tree 해시로 content-addressed라 worktree 공유가 원리상 안전하지만(cache 파일은 신뢰된 recipe 루트의 `.ditto/local/`에 저장, push-gate.ts:352-355), 여러 세션이 같은 캐시 파일을 read-modify-write하면 마지막 writer가 이김(`makeRecordGreen`은 락 없음, push-gate.ts:276-287). FIFO 20 상한이라 최악의 경우 일부 green 기록이 유실될 뿐 게이트 약화는 아니다(유실 = 다음 push가 전체 재실행 = fail-safe). 재설계 시 이 "유실은 안전한 방향" 불변식을 반드시 보존해야 한다.
- **캐시 poison 방어의 취약 지점**: skip 안전은 오로지 `shouldRecordGreen`의 exact-command + clean 두 가드에 걸려 있다 (push-gate-cache.ts:87-93). `maybeRecordGreenForGate`가 크로스툴로 캐시를 채우므로, 게이트 명령과 다른 어떤 명령도 절대 green을 기록하면 안 된다는 불변식이 재설계에서 깨지면 "통과하지 않은 트리를 skip"하는 침묵 결함이 된다. **재설계 시 필수 보존 불변식.**
- **fail-closed의 비대칭은 의도**: barrier와 push-gate가 같은 `unrunnable`/`timeout`을 반대로 처리하는 것(degrade vs block)은 tier 위험 비대칭의 반영이지 버그가 아니다(ADR-20260708 D4). 두 표면을 "일관성" 명목으로 합치려는 리팩터는 이 의도를 파괴한다 — 로직(러너)은 공유하되 처분(disposition)은 갈린 채 유지해야 한다 (ADR §62, §68).
- **런타임 trail 면제 목록의 drift**: `IGNORABLE_TRAIL_PREFIXES`(`.ditto/work-items/`, `.ditto/memory/`)가 land-commit의 `BYPRODUCT_PREFIXES`와 겹치지만 의도적으로 별도 상수다 (push-gate-cache.ts:44-50). ditto가 새 런타임 부산물 디렉터리를 추가하면 이 목록을 갱신하지 않는 한 그 트리는 dirty로 판정돼 캐시 히트를 놓친다(안전하지만 캐시 효율 저하).
