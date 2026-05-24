---
title: "DITTO Phase 3 구현 리뷰"
tier: 1
repo: ditto
last_updated: 2026-05-24
kind: review-report
scope: "reports/harnesses/ditto-application-plan.md Phase 3 및 v0.3 우선순위 묶음과 .ditto/work-items/wi_* 수행 결과 대조"
reviewed_work_items:
  - .ditto/work-items/wi_260524qi9
  - .ditto/work-items/wi_v03sandbox
  - .ditto/work-items/wi_v03verify
fresh_validation:
  - "bun test"
  - "bun run lint"
  - "bun run build"
  - "dist/ditto run with smoke in temporary repo"
---

# DITTO Phase 3 구현 리뷰

## 결론

Phase 3의 핵심 구현 표면은 대체로 들어가 있다.

- `ditto run with`가 provider를 spawn하고 `.ditto/runs/<id>/manifest.json`에 stdout/stderr/diff/exit code를 기록한다.
- Codex/Claude Code adapter가 `HostAdapter.spawnRun` 계약을 구현한다.
- profile별 policy가 wrapper layer와 provider-native flag layer로 나뉘어 테스트된다.
- isolated profile은 git worktree를 생성해 실행 cwd를 분리한다.
- `ditto context build`가 context packet markdown을 생성한다.
- `--verify`가 run manifest의 `verifications`에 결과를 append한다.

다만 "의도한 대로 완료"라고 보기에는 아래 두 가지 간극이 있다.

1. `ditto run with -- ...`의 provider arg forwarding이 CLI help flag에서 깨진다.
2. v0.3 자체 work item 마감 산출물에는 `.ditto/runs` 기반 실행 evidence가 없다.

## Findings

### P1. forwarded provider args에 `--help`가 포함되면 provider가 실행되지 않고 DITTO help가 출력된다

증거:

```text
dist/ditto run with --provider codex --profile workspace-write --workItem <wi> --output json -- --help
```

실제 결과:

- exit code: 0
- stdout: `Run a provider command and capture it as a recorded run (run with)` help text
- `.ditto/runs/<id>/manifest.json` 생성 안 됨

의도와 충돌하는 지점:

- application plan Phase 3는 `ditto run with --provider ... --profile ... -- <args...>`로 provider command를 spawn한다고 정의한다.
- `wi_260524qi9`의 AC-2도 provider command 성공/실패 모두 manifest로 capture되어야 한다고 정의한다.
- provider args after `--`는 provider에게 투명하게 전달되어야 한다. `--help`는 smoke와 진단에서 가장 흔한 provider arg라서 실제 사용에서 바로 밟힌다.

관련 위치:

- `src/cli/commands/run.ts`: `run with`가 citty command로 정의되고, provider tail은 `extractDashDashTail()`로 `process.argv`에서 직접 읽는다.
- `src/cli/util.ts`: `extractDashDashTail()` 자체는 `--` 뒤 args를 slice하지만, citty의 help 처리보다 앞서 실행되지 못한다.
- `tests/core/run-with.test.ts`: core `runWithProvider`는 검증하지만 CLI의 `-- <args>` 전달 회귀는 없다.

판정:

Phase 3의 핵심 사용자 표면 결함이다. core wrapper는 동작하지만 CLI contract가 완전히 충족되지 않는다.

권장 수정:

- CLI 레벨에서 `--` 이후 args를 citty help parser가 소비하지 않도록 별도 raw argv parsing을 둔다.
- 회귀 테스트를 추가한다:
  - `dist/ditto run with ... -- --help`가 provider mock 또는 harmless command로 전달되는지
  - provider exit code와 manifest 생성 여부
  - `--output json`과 provider args가 동시에 있을 때 stdout이 JSON result인지

### P2. v0.3 자체 work item은 done이지만 run-level evidence가 없다

증거:

```text
find .ditto/runs -maxdepth 2 -type f
# find: .ditto/runs: No such file or directory

jq '.id, .runs' .ditto/work-items/wi_260524qi9/work-item.json
jq '.id, .runs' .ditto/work-items/wi_v03sandbox/work-item.json
jq '.id, .runs' .ditto/work-items/wi_v03verify/work-item.json
# 세 work item 모두 runs=[]
```

의도와 충돌하는 지점:

- application plan 1.14는 DITTO 자체 work item이 DITTO의 work-item/run/verify/handoff 도구로 추적, 검증, 마감되어야 한다고 둔다.
- v0.3 우선순위 묶음은 stdout/stderr/diff/verification capture를 manifest에 연결하는 것을 포함한다.
- `wi_v03verify` handoff는 v0.3 work item들이 DITTO 도구로 검증, 마감되었다고 선언하지만, repo-local `.ditto/runs` manifest evidence는 없다.

판정:

구현 기능 자체의 결함은 아니지만, Phase 3의 "자기 적용" 기준에는 미달 또는 적어도 증거 부족이다. 현재 완료 주장은 completion/handoff 문서와 테스트 결과에 의존하고, run manifest 기반 재현 evidence로 닫히지 않았다.

권장 수정:

- v0.3 review/fix work item부터는 `ditto run with ... --verify "<command>"`를 사용해 적어도 하나의 run manifest를 남긴다.
- 기존 세 work item을 사후 보정할지 여부는 별도 결정이 필요하다. 사후 보정한다면 실제 구현 당시 run은 아니므로 `notes`에 retrospective evidence임을 명시해야 한다.

### P3. networked profile은 "network explicit"이라기보다 "network 미강제/미검증" 상태다

증거:

- `src/core/run-with.ts`는 `profile !== 'networked'`일 때 proxy env 4종을 unset한다. 즉 networked만 proxy env를 보존한다.
- `src/core/hosts/codex.ts`의 `networked`는 `--sandbox workspace-write`를 붙이고 `codex network is not forced open by v0.3; sandbox restricts outbound`를 `unverified`에 남긴다.
- `src/core/hosts/claude-code.ts`의 `networked`도 `--permission-mode default`와 `claude-code network is not forced open by v0.3`를 남긴다.

의도와 충돌할 수 있는 지점:

- Phase 3 profile 표는 `networked`를 "network explicit, artifact logging"으로 정의한다.
- 현재 구현은 "non-networked에서 proxy env scrub"은 하지만 "networked에서 네트워크가 명시적으로 열렸는지"는 보장하지 않는다.

판정:

현재 산출물은 이 한계를 risk/unverified로 표면화하므로 치명적 결함은 아니다. 다만 "profile별 권한 격리가 실제로 적용된다"를 엄격하게 읽으면 networked는 아직 best-effort다.

권장 수정:

- provider별 network-on/off 지원 여부 matrix를 명확히 둔다.
- 지원되는 provider에서는 networked가 실제 network-on flag/config를 적용하게 한다.
- 미지원 provider는 AC verdict를 pass로 두더라도 `completion.unverified` 또는 remaining risk에 "networked positive enablement 미검증"을 남긴다.

## 의도 대비 구현 상태

| Phase 3 요구 | 구현 상태 | 리뷰 판정 |
|---|---:|---|
| `ditto run with` provider spawn + manifest 자동 채움 | `runWithProvider` core 구현 및 테스트 통과 | 부분 통과. core는 통과, CLI forwarding bug 있음 |
| provider 실패/성공 모두 evidence로 보존 | success, non-zero, spawn throw, completion reject, signal, stream failure 테스트 있음 | 통과 |
| Codex/Claude Code adapter contract | `spawnRun` 구현, smoke test 통과 | 통과 |
| profile별 권한 격리 | provider flags, proxy env scrub, read-only/reviewer write detection, isolated worktree | 부분 통과. networked는 best-effort |
| isolated worktree | `.ditto/worktrees/<runId>` worktree 생성, manifest `worktree_path` 기록 | 통과 |
| context packet 생성 | work item goal, AC, git state, run exit 요약 생성 | 최소 범위 통과 |
| verification capture manifest 연결 | `--verify` 결과를 `runManifest.verifications`에 append | 통과 |
| v0.1 manual run record와 v0.3 automatic run with schema 호환 | `RunStore`/`runManifest` round-trip 테스트 있음 | 통과 |
| DITTO 자체 v0.3 work item을 도구로 검증, 마감 | work item/handoff/completion은 있음 | 증거 부족. `.ditto/runs` 없음 |

## Fresh Validation

리뷰 중 직접 실행한 검증:

```text
bun test
# 171 pass / 0 fail

bun run lint
# Checked 71 files. No fixes applied.

bun run build
# dist/ditto compiled
```

추가 CLI smoke:

```text
dist/ditto run with --provider codex --profile workspace-write --workItem <wi> --output json -- version
```

결과:

- run manifest 생성됨
- provider exit code가 result와 manifest에 기록됨
- stdout/stderr/diff path가 manifest에 기록됨

반례 smoke:

```text
dist/ditto run with --provider codex --profile workspace-write --workItem <wi> --output json -- --help
```

결과:

- provider run이 아니라 DITTO help가 출력됨
- run manifest가 생성되지 않음

## 남은 위험

- provider CLI flag drift: Codex `--sandbox`, Claude Code `--permission-mode`의 버전별 의미가 바뀌면 profile 보장이 약해진다.
- `--verify`는 timeout이 없어 verify command hang 시 wrapper도 hang한다.
- `--verify` command parsing은 whitespace split만 지원한다. quoted args, env expansion, shell pipeline은 스크립트로 우회해야 한다.
- isolated worktree는 보존 정책이 기본이라 장기적으로 `.ditto/worktrees` cleanup 명령이 필요하다.
- context packet은 Phase 5 수준의 evidence pointer, budget, glossary 반영까지는 아직 아니다.

## 최종 판정

Phase 3 구현은 architectural intent와 대부분 정합한다. 하지만 현재 상태를 "완료"로 닫으려면 최소한 P1은 수정해야 한다. P2는 프로세스 evidence gap이라 기능 출시를 막지는 않지만, DITTO의 자기 적용 원칙을 강화하려면 다음 work item부터 반드시 run manifest를 남기는 방식으로 닫아야 한다.
