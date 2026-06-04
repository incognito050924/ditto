# Dialectic Review 7 — 코드정합 설계문서 갱신의 적대적 검증

- **review_id**: rv_acg7codetruth · **mode**: review · **max_rounds**: 1
- **대상**: 코드 현실 반영 편집 (00/10/20/60/v0-implementation-plan, baseline d378267) + 누락 점검(30/50)
- **질문**: "구현됨/가동됨"으로 뒤집은 주석이 실제 코드와 일치하는가? 과장·오참조·누락된 stale 라인은 없는가?
- **역할**: Producer=Claude · Opponent=**Codex**(codex-plugin-cc, codex:codex-rescue) · Synthesizer=Claude-opus

## 평결: `revise` → 반영 완료

거시적으로 편집은 대체로 정확(WU-6 Stop 게이트 실제 가동 stop.ts:175-184/319-333→exit2, impact/fitness 소비, propose.ts·assessDelta 실재). 그러나 **행동을 요구하는 정확성 결함 6건(major)** + minor 1건이 적출되어 전부 반영했다.

## 채택·반영된 결함

| # | 종류 | 결함 | 수정 |
|---|---|---|---|
| 1 | 과장 | 00:241 "CompletionContract가 직접 소비하는 슬롯으로 배선" — 실제는 *기록* 슬롯, *집행*은 Stop 훅(`completion-contract.ts:75-79`) | 기록/집행 분리 명시 |
| 2 | 누락-stale | 10:127 게이트 "evidence 또는 unresolved marker" — 구현은 `high ∧ evidence===undefined`로 막고 unresolved 단독은 안 풀림(`stop.ts:160-184`) | 구현 바인딩 키잉 주석 추가 |
| 3 | 과장 | v0-plan:44 "단계3 impact 게이트(caller 누락 0) ... Stop 게이트" — Stop은 `unresolved[]`만 막음, caller 해석은 analyzer 몫 | analyzer/CLI vs Stop 게이트 분리 |
| 4 | 자가오류 | 20:578 내가 단 `fitness_kind` 주석이 spec-form 예시에 binding 필드명을 주입해 incoherent | **주석 revert**(스펙은 spec-form 유지, 바인딩 rename은 §0.2/D1) |
| 5 | 누락-stale(30) | 30:235 ICL 예시 envelope가 컴파일러 산출(`schema_version`/`kind` literal/`fitness_kind`)과 불일치 | "스펙-form 표기, wire-form 아님" 주석 |
| 6 | 누락-stale(30) | 30:148 "세 산출물로 컴파일 ... 핵심 가치" — 컴파일러는 B-only, A·C OUT(D6) | "v0는 B만, A·C OUT" 명시 |
| 7 | 누락-stale(50) | 50:22 Change Map "ICL에서 자동 생성(타깃 C)" — 렌더러 OUT, 미구현 | "타깃 C 렌더러 v0 OUT" 명시 |
| 8(minor) | 오참조 | v0-plan:34 Stop 등록을 `claude-code.ts`로 인용 — 실제 명령 등록은 `hooks/hooks.json` | 두 출처 분리 인용 |

## 이 리뷰가 보여준 것

- 내 코드정합 편집은 **5개 문서만** 봤고, 30·50도 같은 "자동생성/세 산출물" stale 주장을 갖고 있던 걸 놓쳤다 — 적대적 패스가 그걸 잡았다.
- "게이트"를 CLI 산출기·ledger writer·Stop 소비처에 뭉뚱그려 쓴 데서 과장이 나왔다(impact "caller 누락 0 게이트"). 이제 analyzer/Stop을 분리 표기.

## 남은 열린 질문

1. ~~v0-plan 테스트 pass-count 재실행 안 함~~ → **재검증 완료(2026-06-04)**: conformance 24 · icl 14 · review(adapter+producer) 13 · journey 10 · stop+producer 48 · beyond(impact/boundary/arch/fitness/codeql) 42 — 전부 0 fail. 인용 숫자 정확.
2. 60:222 "목표:" 표현이 이제 배선된 60:151과 인접 — cosmetic readability seam(비강제).

## 비고

- Dialectic `revise`는 작성/정합 보강 필요지 코드 동작 판정이 아니다.
- 결함 1·3·4·8은 *이번 편집*이 유입, 2·5·6·7은 *기존* stale을 못 잡은 것.
