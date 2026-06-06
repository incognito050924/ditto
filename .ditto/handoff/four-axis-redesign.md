# Handoff — DITTO 4축 재설계 제안 구현 (#1·#2·4b·4c·4e·4a) + 다음 진입점

> 기준: 이 세션 커밋 푸시 완료(origin/main). 이전 핸드오프 `wi_260606e43`의 후속.
> 진실원: `reports/design/ditto-four-axis-reassessment.md`(재평가 제안 본문).

## 0. 셋업
```bash
cd /Users/incognito/dev/projects/ditto
git log --oneline -8        # 아래 6커밋 + 51ca564가 보여야
bun install && bun test     # 1259 pass / 0 fail 기대
bun run lint && bun run adr:guard
```
- `ditto` CLI = `bun run dev <cmd>`(전역 설치는 이전 세션에 되돌려 없음 → `doctor distribution`이 plugin_enabled=false로 정직 진단).
- `bun run dev`는 `$ bun ...` 프리픽스를 먼저 찍음 → JSON 파싱은 첫 `{`부터(`sed -n '/^{/,$p'`).
- **git commit 함정**: 커밋 메시지에 꺾쇠 `<...>`가 있으면 PreToolUse 훅이 "repo 밖 쓰기"로 오탐·차단함 → 메시지에서 꺾쇠 빼거나 `DITTO_SKIP_HOOKS=1 git commit`.

## 1. 이 세션에 한 일 — 재설계 제안 구현(전부 push 완료)

재평가 문서 §1~§3.5의 gap 제안 중 **코드-실증 가능한 6개**를 red→green + 라이브 실증으로 구현:

| 커밋 | 제안 | 핵심 |
|---|---|---|
| `51ca564`(기푸시) | #1 축2 false-green | autopilotNode `ac_verdicts[]` → record-result 영속 → deriveAcVerdicts worst-fold. per-AC partial이 node-pass를 cap |
| `7c77576` | #2 축3 어설션 자동평가 | `src/core/e2e/assertion.mjs`(classifyAssertion/summarizeResult). NL→`checkable=false`→`unverified`(부당 fail 아님). e2eResult에 `unverified` 추가 |
| `173f839` | (선재 fail 근본수정) | repo-self-validation이 manifest를 "if present" 가드 없이 읽던 것 수정 + journey.json 검증 추가. run dir 2종류(provider/e2e) |
| `0b338c1` | 4b 축1 종료 AND | finalize 게이트=readiness ∧ 사용자확인. `userConfirmation`(빈 boolean 금지) 스키마, `not_confirmed` status, InterviewState durable 기록 |
| `d7df711` | 4c 축4 트리거 게이트 | `knowledgeUpdateGate(triggers,delta)` under/over-recording. `ditto knowledge gate` CLI(FAIL=non-zero) |
| `43bb64b` | 4e doctor 정렬 | `ditto doctor distribution` — install status 5플래그를 런타임 점검, §3.5(A) 표대로 4 기층축 배포계약 매핑. `src/core/distribution-doctor.ts` |
| `40e4e1a` | 4a 축3 N/A 자동분기 | `src/core/e2e/applicability.ts` 웹UI 신호(프레임워크 dep + src UI파일). `ditto e2e applicable`, N/A시 covered_by 축2/축1 기록 |

- 각 항목: 순수함수 + 주입IO 단위테스트 + CLI/라이브 실증. 스킬/에이전트 문서 배선 포함.
- 전부 Tidy First 동작적 변경으로 분리 커밋. 메모리 `project-functional-4axes` 갱신됨.

## 2. 다음 세션 진입점 — 미착수 제안 (설계/가치 합의 필요)

코드-실증 6개는 끝. 남은 2개는 **임의 진행 금지**(가치/의도 결정 섞임):

### #4d — 축2 의도-drift 검출 (재평가 §1 축2 gap, line 40)
- 문제: "장시간·대규모에서 본래 목적 안 잃기"를 축2 **내부 점검**으로 박는 표면이 없음. 현재 reviewer의 **코드-수준 회귀** 검출에만 의존하는데, **의도-수준 drift ≠ 코드 회귀**.
- 합의 필요: "의도 drift"를 무엇으로 측정할지(예: intent.json의 goal/AC ↔ 현재 autopilot root_goal/노드 acceptance_refs 정합? in_scope 이탈 노드 검출? 별도 점검 노드?). 측정 정의가 곧 설계.
- 관련: `src/schemas/intent.ts`, `src/core/autopilot-*.ts`, reviewer 노드.

### #3 — Distribution 횡단축 정본화 + ADR (재평가 §3.5(A)(B), 본문 §4·§5가 "사용자 합의 후" 명시)
- (A) Distribution을 기층 4축 위 **5번째 횡단축**으로 canonical 설계 정본(`ditto-claude-code-harness-design.md §4.1`)에 반영.
- (B) **session-rooting invariant**("기층은 세션이 타겟 레포에 루트될 때만 일관 / cross-repo 비지원")를 명시 경계로 정본화 + **ADR 등록**(예 ADR-0011).
- 합의 필요: canonical 모델 개정 + "cross-repo 비지원"을 공식 결정으로 잠그는 것(되돌리기 어려움). (C) doctor 정렬은 4e로 이미 구현됨.

## 3. 상태
- **push 완료**: 이 세션 6커밋 + 이전 세션 누적 전부 origin/main.
- 미해결 잔재 없음(이전 e2e_axis3_demo manifest fail은 173f839로 근본수정).
- 메모리: `project-functional-4axes`(제안 진행현황), `project-install-script-done`.

## 4. 다음 세션 첫 프롬프트(예시)
> "이 핸드오프(`.ditto/handoff/four-axis-redesign.md`) 읽고, 미착수 **#4d(축2 의도-drift 검출)**를 진행해줘. 먼저 '의도 drift'를 무엇으로 측정할지(intent goal/AC ↔ autopilot 정합, in_scope 이탈 등) 후보를 짚고 추천 default로 합의한 뒤 구현. 재평가 문서 §1 축2 gap 기준."

또는 #3을 먼저 하려면:
> "핸드오프 읽고 **#3(Distribution 횡단축 정본화 + session-rooting invariant ADR)**를 진행. 먼저 canonical 설계 §4.1 반영안과 ADR-0011 초안을 dialectic-review로 검증한 뒤 합의."
