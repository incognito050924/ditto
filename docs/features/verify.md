# verify — 실행한 명령의 결과를 work item 완료 조건의 증거로 기록하는 커맨드

> 문서 성격: 코드 설명(재설계용). 코드 변경에 자동 동기화되지 않으므로 시간이 지나면 실제 코드와 어긋날 수 있다(권위는 코드에 있다). 기준 커밋: `c2d2e16` (2026-07-19).

## 1. 이 기능이 실현하려는 설계 의도 (개념)

`ditto verify`는 헌장 §4-5("완료는 증거로만 말한다")를 CLI 표면에서 강제하는 진입점이다. 문제는 이것이다: work item이 "다 됐다"고 주장할 때, 그 주장을 **재실행 가능한 증거**에 묶어야 한다. `verify`는 `--` 뒤의 실제 명령(테스트·빌드·CLI)을 **지금 실행**하고, 그 exit code를 특정 acceptance criterion(완료 조건, 이하 AC)의 판정 근거로 남긴다.

핵심 개념은 두 가지다.

- **fresh evidence(갓 수집한 증거)**: 판정은 "통과할 것이다"가 아니라 방금 실행한 프로세스의 exit code에서 파생된다(verify.ts:112, 129).
- **criterion 단위 증거 귀속**: `--criterion ac-N`을 주면 그 AC 하나의 `verdict`와 `evidence`만 갱신한다. AC별로 증거를 따로 쌓아, 나중에 completion contract(완료 계약)가 AC 집합 전수를 대조할 수 있게 한다.

DITTO 4축 중 **지식/완료 게이트** 계열이 아니라 **오케스트레이션의 완료 판정** 축에 속한다. 정확히는, autopilot 파이프라인 **밖에서** 고친 work item을 완료 처리하는 "경량 경로(lightweight path)"의 증거 공급원이다(ADR-20260626-work-lifecycle-lightweight-path). autopilot 안에서는 `verifier` 서브에이전트가 같은 판정을 독립 컨텍스트에서 수행한다(§4).

주의할 개념 분리: 이름이 `verify`인 표면이 **셋** 있고 역할이 다르다.
- **CLI `ditto verify`** (이 문서) — AC별 증거를 **기록**하는 얇은 도구. 완료를 선언하지 않는다.
- **`/ditto:verify` 스킬**(skills/verify/SKILL.md) + **`verifier` 에이전트**(agents/verifier.md) — AC를 독립적으로 **판정**해 completion contract를 산출하는 판단 역할.
- 이 둘은 **completion contract + 게이트**에서 만난다(§3).

## 2. 코드 위치와 진입점

| 경로 | 역할 |
|---|---|
| `src/cli/commands/verify.ts` | CLI 진입점. `--` 뒤 명령 실행 + 증거 기록 + (선택)AC verdict 갱신 |
| `src/core/evidence-store.ts` | 증거 저장소. `commands.jsonl`(raw) / `evidence-index.json`(ledger) 쓰기 |
| `src/schemas/evidence-log.ts` | `commandLogEntry` 스키마 — 실행 로그 한 줄 |
| `src/schemas/evidence-record.ts` | `evidenceRecord`/`evidenceIndex` — 커밋 가능한 증거 ledger(freshness/portability) |
| `src/core/work-item-store.ts` | AC의 `verdict`/`evidence` 갱신 대상 |
| `src/core/completion-store.ts` | `assembleCompletionFromWorkItem` — verify가 남긴 AC를 completion으로 합성 |
| `src/schemas/completion-contract.ts` | `completionContract` — 완료 계약 스키마(final_verdict pass 규칙) |
| `src/core/gates.ts` | `completionGate`/`completionEvidenceGate`/`passCloseResidualBlockers` — pass-close 게이트 |
| `skills/verify/SKILL.md`, `agents/verifier.md` | 독립 판정(판단 역할) — CLI와 별개 |

**CLI 인자** (verify.ts:59–76):

| 인자 | 형태 | 의미 |
|---|---|---|
| `workId` | positional, 필수 | 검증 대상 work item id |
| `--criterion` | string, 선택 | AC id. 생략하면 증거만 기록하고 verdict는 바꾸지 않음 |
| `--output` | string, 기본 `human` | `human` 또는 `json` |
| `-- <명령...>` | 필수 | `--` 뒤의 실행 명령. 없으면 usage 에러 |

## 3. 데이터 흐름 (입력 → 변환 → 저장/출력)

```
ditto verify <wi> [--criterion ac-N] -- <cmd...>
   │
   ├─ extractDashDashTail()  → `--` 뒤 명령 tail (없으면 exit 2)
   ├─ isNoOpCommand(tail)?   → true/:/echo 이면 거부 (exit 2)
   ├─ workStore.get(wi)      → --criterion 이 AC 집합에 없으면 exit 2
   ├─ runChildCommand(tail)  → Bun.spawnSync 실제 실행 → {exit_code, duration_ms, ...}
   │
   ├─[기록1] evidenceStore.appendCommand(wi, commandLogEntry)
   │         → .ditto/local/work-items/<wi>/evidence/commands.jsonl  (append, gitignored raw)
   │
   ├─[기록2] --criterion 있으면 workStore.update():
   │         AC.verdict = exit==0 ? 'pass' : 'fail'
   │         AC.evidence += {kind:'command', command, summary:`exit N`}
   │         → .ditto/local/work-items/<wi>/work-item.json (또는 Run tier)
   │
   ├─ maybeRecordGreenForGate() → push-gate green 캐시 프라이밍 (best-effort)
   └─ 출력(human|json) + exit_code!=0 이면 exit 1
```

이후 별도 명령 `ditto work done`이 위에서 verify가 남긴 AC 상태를 소비한다(work.ts:2382).

```
ditto work done <wi>
   ├─ assembleCompletionFromWorkItem(item)   → 각 AC의 verdict/evidence를 completion.acceptance 로 복사
   ├─ completionGate(item, synth)            → AC 집합 대조(누락/초과/중복), pass면 전수 pass 검사
   ├─ completionEvidenceGate(synth)          → pass인데 실행 증거 0이면 차단(ack≠검증)
   ├─ passCloseResidualBlockers(...)         → 미해결 잔여(agent_resolvable 등) 차단
   └─ completion.json 기록 + status=done
```

**상태 파일과 스키마**:
- `evidence/commands.jsonl` — `commandLogEntry`(evidence-log.ts:4). raw, gitignore 대상.
- `evidence-index.json` — `evidenceIndex`(evidence-record.ts:79). 커밋 가능한 ledger. **verify는 이걸 쓰지 않는다**(§6 참조; 현재 `codeql` 경로만 `appendRecord` 호출).
- `work-item.json`의 `acceptance_criteria[].verdict`/`.evidence` — `acceptanceCriterion`(work-item.ts:94).
- `completion.json` — `completionContract`(completion-contract.ts:56).

## 4. 핵심 개념과 채택 이유 (왜 이 개념인가)

**(1) no-op 거부 — 가짜 통과 차단.** `true`/`:`/`echo`는 아무것도 검증하지 않고 exit 0을 내므로, 이걸로 AC를 pass 처리하면 가짜 검증이 된다. verify.ts:27의 `NOOP_COMMANDS` denylist가 basename 기준으로 이를 거부한다(`/bin/echo`도 잡힘). 주석(verify.ts:23–26)이 의도를 명시: "no-op must never grade a criterion as pass". allowlist가 아니라 **보수적 denylist**라 여기 없는 명령은 실명령으로 취급된다 — 과잉 차단보다 명백한 no-op만 막는 선택.

**(2) exit code = 유일한 판정 입력(gate ↔ score 일치).** verdict는 `exit_code === 0 ? 'pass' : 'fail'`로만 결정된다(verify.ts:129). 판정을 여는 조건(gate)과 산출(score)이 **같은 단일 입력**(프로세스 exit code)에서 나온다. 사람의 주관·"should pass" 노트가 개입할 자리가 없다.

**(3) criterion 단위 supersede(누적 아닌 갱신).** `--criterion ac-N`이면 그 AC 하나만 `verdict`를 덮어쓰고 `evidence`에는 append한다(verify.ts:132–147, `c.id === args.criterion` 분기). 같은 AC를 다시 verify하면 최신 실행이 verdict를 갱신하되 증거 이력은 쌓인다. `--criterion`이 없으면 evidence만 남기고 verdict 불변(verify.ts:128 분기) — "증거는 있으나 아직 판정 안 함" 상태를 표현.

**(4) completion contract의 pass 규칙(왜 AC 전수인가).** `final_verdict === 'pass'`는 스키마 superRefine에서 "모든 AC가 pass ∧ in-scope unverified 0"일 때만 허용된다(completion-contract.ts:198–216). verify가 AC별로 pass를 쌓아야 하는 이유가 여기 있다 — 하나라도 비어 있으면 `buildCompletion`이 그 AC를 `unverified`로 기본 채우고(completion-store.ts:54), `deriveFinalVerdict`가 pass를 못 낸다(completion-store.ts:42).

**(5) 독립 검증(fresh context) — verifier 에이전트.** autopilot 경로에서는 구현자의 자기평가를 믿지 않고 `verifier`가 별도 컨텍스트에서 증거를 직접 실행한다(agents/verifier.md:16–17, 51). 헌장 §4-9(위임으로 컨텍스트 보호)·§5-4(검증 agent)의 구현. CLI verify는 이 판정 역할이 아니라, 그 판정이 소비할 **증거를 기록**하는 손이다.

**관련 ADR**:
- ADR-20260626-work-lifecycle-lightweight-path — verify+`work done`이 곧 "경량 경로". autopilot 없이 고친 work item을 같은 completion 게이트로 닫는다.
- ADR-20260706-work-item-record-run-split — 증거를 Record(커밋·공유)와 Run(개인·폐기가능)으로 분리. `evidence/`(raw)는 gitignore, `evidence-index.json`(ledger)은 커밋 대상이라는 구분의 근거(evidence-record.ts:73–85, evidence-store.ts:24).
- ADR-0002 — 스키마가 SoT. verify가 쓰는 모든 레코드는 zod 스키마로 검증 후 저장(evidence-store.ts:39, 96).

## 5. 코드 분해 (무슨 코드가 무슨 효과를 내는가)

**`isNoOpCommand(tail)` (verify.ts:29–34)** — `tail[0]`의 basename을 denylist와 대조. 슬래시가 있으면 마지막 `/` 뒤만 취해 `/usr/bin/true`도 잡는다. 효과: 명백한 no-op으로 AC를 pass 처리하는 경로를 입력 단계에서 봉쇄(exit `USAGE_ERROR_EXIT`).

**`runChildCommand(tail)` (verify.ts:36–52)** — `Bun.spawnSync`로 stdin 무시·stdout/stderr 파이프 실행. `exit_code`는 `proc.exitCode ?? -1`. 효과: 실제 프로세스를 지금 돌려 fresh exit code를 얻는다. 실행 시간(`duration_ms`)도 함께 기록해 증거가 "언제 얼마나 걸렸는지"를 담는다.

**증거 기록 (verify.ts:117–126)** — `commandLogEntry` 객체를 만들어 `appendCommand`. `criterion_id`는 `--criterion`이 있을 때만 스프레드로 포함(verify.ts:124) — 없으면 아예 필드가 빠진다(optional). `EvidenceStore.appendCommand`(evidence-store.ts:38–48)는 기존 파일을 읽어 새 줄을 붙이고 **원자적 쓰기**(`atomicWriteText`). 주석(evidence-store.ts:35–37)이 한계를 명시: 동시 writer·성장 제한은 후속으로 미룸 — v0.1 단순 read+append+atomic write.

**AC verdict 갱신 (verify.ts:128–149)** — `--criterion`이 있을 때만 진입. `workStore.update`로 해당 AC만 매핑 변경: `verdict`를 덮어쓰고 `evidence`에 `{kind:'command', command, summary:'exit N'}`를 append. 미묘한 결정: 이 evidence의 `kind`가 `'command'`(≠`'note'`)라, 나중에 `completionEvidenceGate`의 "실행 증거 존재" 판정을 통과시킨다(gates.ts:750, `e.kind !== 'note'`). 즉 verify가 남긴 증거는 ack이 아니라 검증으로 인정된다.

**실패 시 종료 (verify.ts:167–169)** — `exit_code !== 0`이면 **기록을 다 마친 뒤** `RUNTIME_ERROR_EXIT`. 순서 의존성이 중요: fail verdict와 evidence가 디스크에 먼저 남고 나서 비영점 종료한다. 실패도 증거다.

**cross-tool green 캐시 (verify.ts:113–116)** — verify한 명령이 push-gate의 정확한 test_command이고 clean tree에서 통과했으면 push 캐시를 프라이밍. 주석(verify.ts:113–115)대로 best-effort, 절대 블로킹하지 않음. verify의 부수효과이지 본 책임은 아니다.

**`assembleCompletionFromWorkItem` (completion-store.ts:103–118)** — verify가 work-item.json에 쌓아둔 각 AC의 `verdict`+`evidence`를 그대로 `buildCompletion`에 넘긴다. 주석(completion-store.ts:86–101)이 핵심 의도를 담는다: "one evidence gate, not a weaker parallel one" — 경량 경로가 autopilot과 **같은** `buildCompletion`을 쓰므로 증거 게이트가 하나로 유지된다. pass-without-evidence AC는 여기서 pass로 남되 `completionEvidenceGate`가 잡는다.

## 6. 설계 의도 ↔ 실제 동작 일치 여부

확인 범위: verify.ts 전체, evidence-store/completion-store, evidence-log/evidence-record/completion-contract 스키마, gates.ts의 completion 계열 게이트, work.ts의 `work done` 경량 경로 소비부.

- **일치**: "실제 실행 → exit code → AC verdict → completion 게이트"의 사슬이 코드로 연결됨을 확인. no-op 거부, criterion 미지정 시 verdict 불변, pass 전수 규칙 모두 코드에 존재.
- **verdict 표현력 갭(미확인 아님, 설계상 축소)**: CLI verify는 `pass`/`fail` **둘만** 낼 수 있다(verify.ts:129). 스키마 verdict enum은 `pass|partial|fail|unverified` 4종(common.ts:51)인데, `partial`·`unverified`를 CLI로는 표현할 수 없다. 이 4종 판정은 `verifier` 에이전트/스킬의 몫으로 분리돼 있다(agents/verifier.md:31–36). 재설계 시 이 분업이 의도된 것인지 확인 필요.
- **evidence-index.json 미사용**: verify는 `appendCommand`(raw jsonl)만 호출하고, 커밋 가능한 ledger `evidence-index.json`을 쓰는 `appendRecord`는 호출하지 않는다(grep 결과 `appendRecord` 호출부는 codeql 경로뿐). 따라서 verify가 남긴 증거는 raw `evidence/`(gitignore)에만 있고, **다른 clone/세션에서 메타데이터로 판정 가능**하다는 evidence-record.ts:73–77의 의도는 verify 경로에서는 실현되지 않는다. completion의 `evidence`(bare evidenceRef)로는 전달되지만 freshness/portability sidecar는 비어 있다.
- **freshness sidecar 미채움**: `buildCompletion`은 `evidence_records`를 항상 `[]`로 둔다(completion-store.ts:56). evidenceRecord 스키마의 freshness/portability/stale_reason 필드(evidence-record.ts:21–71)는 verify→done 경로에서 채워지지 않는다 — 스키마 능력은 있으나 이 경로에선 미사용(codeql 경로에서만 채움, 추론).

## 7. 잠재 위험·부작용·재설계 시 고려점

- **동시성(명시된 미해결)**: `appendCommand`는 read-existing + atomic-write이라, 두 verify가 같은 work item에 동시에 append하면 마지막 쓰기가 앞 쓰기를 덮을 수 있다(lost update). evidence-store.ts:35–37이 "concurrent writers ... deferred"로 인정. 워크트리 병렬(worktree)에서 같은 wi를 동시에 verify하면 증거 유실 가능. 재설계 시 O_APPEND 단일 write 또는 per-writer 파일 고려(ADR-20260628-append-decision-atomicity가 결정 로그에 쓴 접근과 유사).
- **no-op denylist의 회피 가능성**: `true`/`:`/`echo`만 막으므로 `bash -c ':'`, `sh -c 'exit 0'`, `python -c ''` 등은 통과한다. denylist는 명백한 사례만 막는 보수적 방어이지 완전한 가짜-통과 차단이 아니다(verify.ts:23–26이 이를 인정). 재설계 시 "명령이 실제로 무언가를 검증했는가"는 근본적으로 결정 불가 — 이 게이트에 과신하면 안 됨. 진짜 방어선은 `verifier`의 독립 판정과 completion 게이트다.
- **verdict 축소로 인한 오판**: CLI가 exit≠0을 무조건 `fail`로 기록하므로, "부분 통과"인 상황도 fail이 된다. 경량 경로에서 이를 되돌리려면 다시 verify하거나 `verifier`를 써야 한다. 재설계 시 CLI에 partial/unverified 입력 경로를 줄지, 아니면 이 축소를 유지하고 4종 판정은 에이전트로만 낼지가 핵심 결정.
- **재설계 시 반드시 보존할 불변식**:
  1. verdict는 **방금 실행한** 명령의 결과에서만 파생(fresh evidence). 이전 실행 재사용·자기신고 금지.
  2. no-op은 결코 AC를 pass로 만들지 않는다.
  3. `final_verdict=pass`는 전 AC pass ∧ in-scope unverified 0일 때만(completion-contract.ts:198). 경량 경로와 autopilot 경로가 **같은** `buildCompletion`/게이트를 통과해야 한다(단일 증거 게이트).
  4. 커밋 가능 ledger(`evidence-index.json`)와 raw 증거(`evidence/`)의 tier 분리(ADR-20260706).
- **재고 가능한 결정**: denylist vs 더 강한 검증, evidence-index.json을 verify 경로에도 채울지, freshness sidecar를 verify가 기록할지.
