# prism — 모호한 코드 변경 요청을 코드 작성 전에 "공유된 의도"로 정제하는 이해-우선 관문

> 문서 성격: 코드 설명(재설계용). 코드 변경에 자동 동기화되지 않으므로 시간이 지나면 실제 코드와 어긋날 수 있다(권위는 코드에 있다). 기준: HEAD `c2d2e16` (2026-07-19), `src/core/prism/*` 최종 변경 `278ed87` (2026-07-15). 인용한 파일:라인은 이 시점 기준이다.

## 1. 이 기능이 실현하려는 설계 의도 (개념)

prism은 "이거 좀 고쳐줘 / 이 기능 다시 설계하자" 같은 **모호한 코드 변경 요청**을, 구현에 들어가기 전에 **검증 가능한 공유 의도**로 바꾸는 앞단 관문이다. 한 번의 루프로 처리한다 (`skills/prism/SKILL.md:8-18`):

1. 모호함을 **인터뷰**해서 작은 이슈 맵(무엇을 실제로 정해야 하는가)으로 키운다.
2. 사람과 DITTO가 둘 다 읽는 **평문 설계 문서**(`.ditto/specs`와 동형)를 낸다.
3. 확정된 설계를 **승인 하에** 항목별 work item 초안으로 **분할**한다.
4. 확정된 문서를 `intent.json`으로 **컴파일**한다 — 단, deep-interview의 단일 writer를 통해서만.

DITTO 4축 중 **의도(intent) 축**에 속한다. prism은 의도를 정제할 뿐 코드를 구현하거나 리뷰하지 않는다 — 그건 하류의 autopilot / `ditto verify` 소관이다 (`skills/prism/SKILL.md:20-22`).

핵심 설계 명제 세 가지:

- **prism은 tech-spec(spec-doc)을 진화·대체(alias)한다.** prism이 내는 설계 문서는 별도 포맷이 아니라 기존 `spec-doc.ts`의 스펙 문서와 동형이며(`designdoc.ts`가 `SPEC_SECTIONS`·`computeSpecDigest`를 그대로 재사용), 코드베이스에 `tech-spec`이라는 독립 CLI 표면은 남아있지 않다(확인: `grep -rln "tech-spec" src/cli/commands/` → 결과 없음). 즉 "설계 문서 → 의도" 경로의 유일한 사용자 표면이 prism이다.
- **prism은 `intent.json`을 직접 만들지 않는다.** 컴파일은 `finalizeInterview`(deep-interview의 단일 IntentStore writer)에 위임한다 (`src/core/prism/finalize.ts:15-19`).
- **종료선(무엇이 "충분히 정제됐나")은 ditto가 소유한다.** 착수 가능 여부는 결정적 게이트(`criticalTermination`, `finalize` AND-게이트)가 판단하지, 에이전트나 사용자가 임의로 "됐다"고 선언하는 게 아니다.

## 2. 코드 위치와 진입점

| 파일 | 역할 |
|---|---|
| `src/cli/commands/prism.ts` | CLI 진입 — 서브커맨드 전체를 정의·배선 |
| `src/core/prism/engine.ts` | 순수 엔진 — 심각도 권위(MODEL-2), 닫기 게이트(MODEL-1/A2), 임계 종료, 라벨-only 요약, 착수 알림, 발산 감지, cap 루프 |
| `src/core/prism/loop.ts` | 불순(impure) 드라이버 — 발산 라운드/반대검토 라운드를 store에 기록 |
| `src/core/prism/opponent.ts` | 모델-보조 반대검토 seam(critique/dissent/semantic) — 순수 정책 + host 위임 |
| `src/core/prism/designdoc.ts` | 설계 문서 렌더 + fail-closed emit 게이트 |
| `src/core/prism/backlog.ts` | 백로그 분할 — propose(제안)·materialize(승인 후 물화) + 스키마 |
| `src/core/prism/finalize.ts` | 설계 문서 → `intent.json` 컴파일(단, `finalizeInterview`에 위임). **CLI는 `ditto deep-interview finalize-from-doc`에서 호출** |
| `src/core/prism/store.ts` | Run-tier 영속화(issue-map / decisions / backlog-split / value trail) |
| `src/schemas/prism.ts` | zod 스키마(SoT, ADR-0002) — 이슈맵·심각도·평가·결정·반대검토 판정 |

서브커맨드 (`src/cli/commands/prism.ts:1332-1344`):

| 서브커맨드 | 하는 일 | 주요 인자 |
|---|---|---|
| `seed` | 이슈 맵에 노드 1개 추가(인터뷰 라운드, cap 적용) | `--wi --label [--critical] [--max-nodes]` |
| `diverge` | 한 라운드를 발산 감지에 넣고 판정을 emit(ac-10) | `--wi (--question \| --challenge-of) [--seen ...] [--new-evidence]` |
| `close` | 노드를 닫기(MODEL-1 + A2 게이트) | `--wi --node --state [--reason --residual --justifying-reason --refutation-attempted]` |
| `summary` | 남은 범위의 **라벨만** 출력(ac-3) | `--wi` |
| `status` | 임계 종료 상태 + 1회성 착수 알림(ac-2/ac-4) | `--wi` |
| `tree` | 이슈맵 트리 순수 조회(무변이, ac-4) | `--wi` |
| `opponent` | 반대검토 seam 실행(host 위임, 무host면 degrade) | `--wi [--concern critique\|dissent] [--host]` |
| `opponent-briefs` | host가 반대검토 에이전트를 띄울 브리프 emit(모델 호출 없음) | `--wi` |
| `opponent-record` | host가 낸 판정 JSON을 이슈맵에 반영(fail-closed) | `--wi --json [--briefed]` |
| `doc` | 설계 문서 emit(근거 게이트 + digest 바인딩) | `--wi --input [--out --allow-ungrounded]` |
| `backlog propose\|materialize` | 분할 제안 / 승인 후 물화 | `--wi --input` / `--wi --statement` |

## 3. 데이터 흐름 (입력 → 변환 → 저장/출력)

모든 prism 상태는 **Run tier**(`.ditto/local/work-items/<id>/prism/`)에 산다 — 커밋되는 Record base가 아니라, 확정된 WI를 **앞서는** 폐기 가능한 탐색 트레일이다 (`src/core/prism/store.ts:38-55`).

저장 파일:

- `issue-map.json` — 탐색 초안(이슈맵). 단일 writer, 전체 교체. 스키마 `prismIssueMap` (`src/schemas/prism.ts:143`). 트리 자체는 `coverageMap` 재사용.
- `prism-decisions.jsonl` — 결정급 트레일(approval/unknown-close/skip/early-exit/notified/challenge-admit). 스키마 `prismDecision` (`src/schemas/prism.ts:184`).
- `prism-backlog-split.json` — 분할 제안 + 1회 승인 + 물화 백링크 원장. 스키마 `prismBacklogSplit` (`src/core/prism/backlog.ts:83`).
- VALUE trail — 별도 파일이 아니라 보존된 question-round sink(`WorkItemStore.appendQuestionRoundLine`)에 append해서 `ditto doctor intent-quality`가 계속 prism 라운드를 본다 (`src/core/prism/store.ts:137-165`).

흐름:

```
요청(모호)
  └─ seed ──▶ issue-map.json (노드 append, 심각도 게이트, VALUE trail)
  └─ diverge ─▶ 발산 판정 emit + Record급 결정(early_exit/challenge_admit)
  └─ close ──▶ MODEL-1/A2 게이트 통과 시 노드 닫힘 (거부 시 unevaluated 스탬프)
  └─ status ─▶ criticalTermination + 1회성 착수 알림(notified_at 스탬프)
  └─ doc ────▶ .ditto/specs/<wi>-design.md (근거 게이트 + digest)
  └─ backlog propose/materialize ─▶ 승인 시 항목별 WI 초안(intent.json 없음)
                                        │
  (별도 표면) deep-interview finalize-from-doc
     └─ compileSpecDoc(design.md) ─▶ finalizeInterview ─▶ intent.json (digest 바인딩)
```

## 4. 핵심 개념과 채택 이유 (왜 이 개념인가)

### 4-1. 트리 엔진을 재구현하지 않는다 (설계 결정 1)
이슈맵 트리는 세 번째 트리 엔진이 아니라 `coverageMap`을 그대로 쓴다. 노드 CRUD·닫기·false-green 게이트·cap 평가는 전부 `coverage-manager.ts`의 순수 함수를 재사용하고, prism은 그 위에 순수 net-new 관심사만 얹는다 (`src/schemas/prism.ts:5-17`, `src/core/prism/engine.ts:17-28`).

### 4-2. 심각도 권위 = 코드 게이트 (MODEL-2)
노드 기본 심각도는 `noncritical`이고, `critical`은 명시적 게이트 할당으로만 부여된다. 이유: **착수 게이트의 수혜자(에이전트)가 부수효과로 노드를 critical로 만들거나 떨어뜨리지 못하게** 하기 위함 (`src/core/prism/engine.ts:32-39`). critical→noncritical **강등**은 명시적 이유를 반드시 기록해야 한다(non-resolved 닫기의 residual_risk와 동형) — 조용한 강등은 거부 (`engine.ts:52-78`).

### 4-3. 임계 종료 + 공허참 가드 (ac-2)
"모든 **critical** 노드가 resolved면 최소 착수 가능; noncritical 생존자는 종료를 막지 않는다"가 종료 규칙 (`engine.ts:236-268`). 함정: `every()`는 빈 집합에서 `true`라 0-critical/빈 맵이 거짓으로 "종료됨"이 되고 착수 알림까지 쏜다. 그래서 **탐색된 노드 ≥1 AND critical 노드 ≥1**일 때만 종료가 발동한다(B1 공허참 가드). 이것이 "종료선을 ditto가 소유한다"의 구현부 — 결정적 술어가 판단한다.

### 4-4. 닫기 게이트: MODEL-1 residual + A2 argumentation (ac-1)
critical 노드를 `out_of_scope`/`user_owned`("모름-닫기")로 닫으려면 `residual_risk`가 필수 — 안 적으면 거부, 핵심 해결로 치지 않는다 (MODEL-1, `engine.ts:154-161`). critical `resolved` 닫기는 **셋 다** 필요하다: 채운 근거 사유(`justifying_reason`), 반박 시도 기록(`refutation_attempted`), 이번에 새로 더해진 근거(하위 분할 또는 반대검토 기록) (A2, `engine.ts:163-188`). 하나라도 빠지면 닫기를 거부하고 노드를 `unevaluated`로 스탬프한다. 근거: 구조적 닫힘 ≠ 건전함(Verheij 2005 Dung in/out/undec 3치) (`src/schemas/prism.ts:43-55`). **gate↔score 자기점검**: 종료 점수(`isCriticalResolved`)가 닫기 게이트가 쓰는 것과 **같은** 평가 입력을 읽어서, `unevaluated`로 스탬프된 노드는 resolved 상태에 도달했어도 절대 해결로 세지 않는다 (`engine.ts:214-219`).

### 4-5. 발산 규율 (ac-10) — 모델 호출 없이 결정적
세 가지 "쳇바퀴" 형태를 LLM 없이 감지한다: `repeat_question`(앞 질문과 거의 동일), `trivial_streak`(사소한 질문 연속 `TRIVIAL_STREAK_CAP=3`), `decided_conflict_no_evidence`(이미 정한 항목을 새 근거 없이 재문제화) (`engine.ts:568-614`). 새 근거를 가진 재도전은 **한 번만** 보이는 challenge 노드로 승격(조용한 억제 금지). cap HIT은 **성공이 아니라 STOP+escalate**다(cap ≠ converged) (`engine.ts:616-685`).

### 4-6. 착수 알림 = 1회성 콘솔, 질문 훅 아님 (ac-4)
모든 critical이 resolved되고 noncritical만 남으면 `status`가 **한 번** 평문 콘솔 줄로 알린다 — 인터랙티브 훅이 아니고, 재알림 안 함(durable one-shot), critical 회귀 시 스탬프 철회(재도달 시 재알림) (`engine.ts:479-502`). ac-3 재앵커: 알림이 뜰 때 원 의도(원문) + "달성 vs 특징서술만" 프롬프트를 **비차단**으로 곁들인다 (`engine.ts:442-465`).

### 4-7. 사용자 표면은 라벨만 (ac-3)
`summary`/`status`는 열린 항목의 **자연어 라벨만** 출력한다 — node id·심각도 enum·축 이름·스키마 필드 누출 없음 (`engine.ts:504-517`). `close`는 node id를 받으므로 드라이버/오퍼레이터 명령이고, 사용자 화면엔 안 간다 (`skills/prism/SKILL.md:79-83`).

### 4-8. 분할 = 승인 프리미티브 (ac-8)
`propose`는 아무것도 물화하지 않고 제안만 쓴다. `materialize`는 **사용자가 직접 쓴 승인 문장**(`--statement`)이 있어야만 동작 — 명령만 실행하는 건 승인이 아니다 (`backlog.ts:54-77`, `211-225`). 물화는 WI **초안만** 만든다: intent.json 없음, 자동 시작 없음(AUTH-2 no-auto-drive) (`backlog.ts:15-22`). 항목별 백링크 원장으로 멱등(부분 실패 재실행이 중복 안 만듦) (`backlog.ts:239-278`).

### 4-9. 설계 문서 emit = fail-closed (ac-5/ac-6)
경로 containment(repo 밖 거부), 컴파일 입력 절 비어있음 거부(digest anti-collapse), 원문 전사(코드펜스) 거부, 사실 주장에 근거(file:line/링크/ADR/메모리 포인터) 필수 — 없으면 emit 차단(단 `--allow-ungrounded`로 명시 결정 시 미해결 표시하고 출하) (`designdoc.ts:145-204`). 마지막에 `scrubTokens`로 토큰형 비밀값 레드액션.

### 관련 ADR
- **ADR-0002** — 스키마가 SoT. prism 계약은 `src/schemas/prism.ts` + (예외적으로) `backlog.ts` 안에 co-located(그 노드의 lease가 schemas 파일을 안 덮어서, `src/core/prism/backlog.ts:24-27`).
- **ADR-0001** — 모델 호출은 host 위임. opponent seam은 provider를 직접 spawn하지 않고 opponent-router로 "누구를 쓸지"만 순수 결정, 실제 호출은 host가 한다 (`opponent.ts:31-45`).
- **ADR-0018** — 선택적 외부도구 우아한 강등. 반대검토 host가 없으면 크래시/가짜pass 대신 `host_absent` 스탬프로 self-describing degrade (`opponent.ts:37-41`, `src/schemas/prism.ts:59-71`).
- **ADR-20260706** — work-item Record/Run 2-tier. prism 상태 전부 Run tier, 커밋 base off-limits (`store.ts:46-49`).
- **ADR-0024** — 분할 항목 AC는 statement + verification method(재평가 가능 클래스) 필수, placeholder 금지 (`backlog.ts:30-39`).

## 5. 코드 분해 (무슨 코드가 무슨 효과를 내는가)

### `prism seed` (`prism.ts:168-266`)
입력 `--wi --label [--critical]` → 하는 일: Run-tier 초안 로드(없으면 root container 시드, `prism.ts:133-159`) → **실제 cap 호출** `runPrismRounds([{addedNodeCount:1}], caps, {...})`. cap HIT이면 `drive.halted` → escalate + `RUNTIME_ERROR_EXIT`(cap≠성공, `prism.ts:205-215`). 통과 시 `addNode`로 노드 append, `--critical`이면 `assignSeverity` 게이트 → `writeMap` → VALUE trail append. 산출 효과: 이슈맵이 노드 1개 자라고, 라운드가 보존 sink에 남는다. 미묘: seed는 항상 노드를 붙이므로 구조상 novelty=true (`prism.ts:239-250`).

### `prism diverge` (`prism.ts:282-395`)
입력은 `--question`(과 `--seen`/`--seen-trivial` 히스토리) 또는 `--challenge-of`(과 `--signature`, `--new-evidence`) — 정확히 하나. `runDivergenceRound`가 `detectDivergence`를 돌려 판정+결정을 낸다 (`loop.ts:44-77`). 미묘한 순서 의존성: 히스토리를 non-trivial 먼저, trivial을 꼬리에 놓는다 — `detectDivergence`가 꼬리에서 연속 trivial을 세므로 `--seen-trivial`이 있어야 `trivial_streak`가 CLI로 도달 가능해진다(과거엔 전부 trivial:false 하드코딩이라 streak가 절대 안 찼다, `prism.ts:347-354`). **발산이 플래그되면 STOP**: `verdict.diverged` → `RUNTIME_ERROR_EXIT`(초록 continue 아님, `prism.ts:388-389`).

### `prism close` (`prism.ts:402-498`)
`--justifying-reason`/`--refutation-attempted`를 먼저 노드 평가 주석에 upsert한 **뒤** `closePrismNode`가 읽는다(A2 게이트 순서, `prism.ts:449-458`). 거부 시: `result.prism`이 있으면(=A2가 `unevaluated` 스탬프) Run tier에 그 트레이스를 영속화 — under-think 캐치가 measurable하게 남고 조용한 exit이 안 되게 (`prism.ts:462-474`). non-resolved 닫기는 Record급 결정(`unknown_close`/`skip`)도 남긴다 (`prism.ts:477-487`).

### `prism status` (`prism.ts:551-632`)
완결성 시드: intent.json을 fragment로 쪼개(`buildIntentFragments`) 명시 매핑(`deriveFragmentMappings`)과 역매핑해서, **어떤 노드도 안 다룬 fragment마다 noncritical open 노드를 시드**한다 (`prism.ts:584-593`). 왜 noncritical인가: critical 시드면 종료를 하드블록해서 "종료 불가 루프"를 만들 수 있는데, 그건 의도가 금지한 것이라 gap을 표면화하되(summary에 보임) `criticalTermination`은 절대 뒤집지 못하게 한다 (`engine.ts:301-361`). 그다음 `criticalTermination` → `resolveLaunchNotification`(원 의도 넘겨 재앵커 표면 포함). 알림이 뜨면 `notified_at` 스탬프 + `notified` 결정 기록.

### `prism doc` (`prism.ts:1071-1152`)
`--input` payload(JSON)를 `emitDesignDoc`에 넣어 fail-closed 게이트 통과 시 `.ditto/specs/<wi>-design.md`(기본)로 쓴다. `result.digest`(=`computeSpecDigest`)를 함께 낸다 — 이게 나중 finalize에서 문서-의도 바인딩의 앵커.

### `opponent` 3형제 (`prism.ts:765-1062`)
- `opponent`: **실제로** `runOpponentCritiqueRound`/`runOpponentDissentRound`를 호출한다(dead wire 아님). bare CLI는 host delegate가 없어(`isAvailable:()=>false`, `delegate:()=>null`) opponent-router가 usable host를 못 찾고 seam이 결정적 shell로 degrade하며 `host_absent`를 스탬프 — 그 degrade(호출은 일어나고, 스탬프는 쓰이고, 크래시/가짜pass 없음)가 bare CLI의 관측 가능한 배선 증명 (`prism.ts:751-763`).
- `opponent-briefs`: 모델 호출 없이(ADR-0001) host가 반대검토 에이전트를 띄울 브리프(critique/dissent/semantic 대상 + 원 의도)를 emit.
- `opponent-record`: host가 낸 판정 JSON을 consume. **외부 node_id를 upsert에 먹이는 첫 경로**라 3중 방어: M1 zod safeParse(malformed→USAGE_ERROR, 맵 불변), M2 tree 밖 node_id면 fail-closed(고아 upsert 거부, ADR-0018), 빈 텍스트는 `host_absent`로 degrade(가짜 engaged 금지), 정확히 1회 writeMap(OBJ-2 single-writer) (`prism.ts:938-1062`).

### `backlog materialize` (`prism.ts:1235-1312`)
`--statement` 없으면(또는 공백) 거부 — 명령 실행만으로는 승인 아님 (`prism.ts:1264-1271`). `materializeBacklogSplit`가 승인 프리미티브 재검증 → 지속된 제안 재검증(placeholder 재차단) → 항목별 WI 초안 생성 + 즉시 백링크 (멱등).

## 6. 설계 의도 ↔ 실제 동작 일치 여부

확인 범위: `src/cli/commands/prism.ts`, `src/core/prism/*`, `src/schemas/prism.ts`, `skills/prism/SKILL.md`의 정적 읽기. 테스트 실행·런타임 확인은 하지 않음(미검증).

- **의도 일치**: "prism은 intent.json을 직접 안 만든다"는 코드로 성립 — `finalize.ts`는 `finalizeInterview`에 위임하고 자체 IntentStore.write가 없다 (`finalize.ts:15-19`, `69`). "종료선을 ditto가 소유"도 `criticalTermination`·finalize AND-게이트로 성립. "tech-spec 대체(alias)"도 `designdoc.ts`가 `spec-doc.ts`의 `SPEC_SECTIONS`/`computeSpecDigest`를 재사용하고 독립 tech-spec CLI 표면이 없음으로 성립.

- **표면 분리(주의점, 죽은 경로 아님)**: 설계 문서 → intent 컴파일(`finalizeFromDesignDoc`)의 **CLI 진입은 `ditto prism`이 아니라 `ditto deep-interview finalize-from-doc`**다 (`src/cli/commands/deep-interview.ts:1243`). SKILL도 이 명령을 6단계로 안내한다(`skills/prism/SKILL.md`). 즉 prism 서브커맨드만 보면 "컴파일 단계"가 안 보인다 — 배선은 살아있고 deep-interview 표면에 있다. prism 재설계 시 이 경계(compile은 deep-interview 소유)를 인지해야 한다.

- **미배선(dead code) 하나**: `engageSemanticCritique`(A1 achieve-vs-characterize seam, `opponent.ts:384-455`)는 완전 구현돼 있지만 prism CLI에서 이를 구동하는 서브커맨드가 없다. `opponent-briefs`가 `semantic_targets`를 emit하고 `opponent-record`가 `semantic` 판정을 반영(`recordSemanticCritique`)하는 host-위임 경로는 있으나, bare-CLI에서 `engageSemanticCritique`를 직접 호출하는 지점은 확인되지 않음(미확인: 다른 host 스킬 경로에서 호출될 가능성은 이 조사 범위 밖). 즉 semantic critique의 "직접 실행" 절반은 CLI 표면에 노출돼 있지 않다.

- **gate↔score 일치**: `closePrismNode`가 쓰는 `evaluation` 스탬프와 `criticalTermination`의 `isCriticalResolved`가 같은 입력을 읽음을 코드로 확인(`engine.ts:182`, `196`, `214-219`) — 자기점검 통과.

## 7. 잠재 위험·부작용·재설계 시 고려점

### 재설계 시 반드시 보존해야 할 불변식
1. **심각도 권위는 코드 게이트로만** (MODEL-2). 착수 게이트의 수혜자가 심각도를 부수효과로 못 바꾸게 하는 것이 핵심. 이걸 완화하면 critical 게이트가 무력화된다.
2. **공허참 가드** (B1). 0-critical/빈 맵은 종료·알림 금지. `every()` 위에 얹은 이 가드를 빼면 빈 맵이 거짓 착수 알림을 쏜다.
3. **cap ≠ 성공.** 모든 cap HIT은 STOP+escalate. seed/diverge 둘 다 `RUNTIME_ERROR_EXIT`로 이 계약을 지킨다.
4. **prism은 intent.json을 직접 안 쓴다.** 단일 writer(`finalizeInterview`) 불변식. 두 번째 writer를 추가하면 digest 바인딩·freshness 게이트가 갈라진다.
5. **gate↔score 동일 입력.** 닫기 게이트가 쓰는 평가를 종료 점수가 읽는다. 둘이 갈라지면 unevaluated 노드가 해결로 세지는 false-green이 재발한다.
6. **승인 프리미티브 = 사용자 원문.** materialize/finalize 둘 다 bare 호출을 승인으로 인정 안 함.

### 약점·확장 시 깨질 지점
- **매핑이 토큰 단순 매칭**: `deriveFragmentMappings`는 fragment 키워드가 노드 라벨의 whole-token으로 나타나는지로만 커버리지를 판단한다(모델 없음). substring bleed는 고쳤지만(과거 `id`가 `provider`에 매칭되던 버그, `engine.ts:397-410`) 동의어·의역은 못 잡는다 → 실제로 다룬 fragment가 미커버로 잘못 시드되거나 그 반대가 날 수 있다. achieve-vs-characterize 의미 판단은 의도적으로 범위 밖(모델 몫).
- **정합성/동시성**: 모든 writeMap이 단일 writer 전체 교체다(`store.ts:87-91`). 같은 WI에 대해 두 세션/드라이버가 동시에 돌면 뒤쪽 writeMap이 앞을 clobber한다. opponent seam은 순차 await로 자기 안에서는 race를 피하지만(OBJ-2), **서로 다른 prism 서브커맨드의 동시 실행**은 이 store가 보호하지 않는다(미확인: 상위에서 직렬화 보장 여부).
- **Run-tier 폐기성**: prism 상태는 gitignored Run tier라 Run wipe로 사라진다. 살아남아야 하는 것(승인/unknown-close/notified 등)은 `prism-decisions.jsonl`(Record급 결정)에 별도로 남기지만, 이슈맵 자체(issue-map.json)는 폐기 가능 초안이다. 재설계 시 "무엇이 durable해야 하나"를 이 2-tier 경계로 다시 판단해야 한다.
- **컴파일 표면 분산**: §6의 표면 분리 — 컴파일이 deep-interview에 있어서, prism만 보는 사용자/문서는 마지막 단계를 놓치기 쉽다. 재설계 시 진입 표면을 prism으로 모을지, 지금처럼 deep-interview 소유로 둘지 결정 필요(비가역 아님).
- **semantic seam 미노출**: §6 dead 경로 — A1 semantic critique의 직접 실행이 CLI에 없다. 광고된 3-seam(critique/dissent/semantic) 중 semantic은 host-record 경로로만 반영 가능. 확장 시 이 비대칭을 메우거나 명시적으로 축소해야 한다.
