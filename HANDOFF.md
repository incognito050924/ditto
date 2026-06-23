# HANDOFF — 다른 PC 이어받기 (2026-06-23, floor-research 설계 세션)

호스트 메모리·work-items(`.ditto/local/`, gitignored)는 git으로 전파되지 않는다. 코드·테스트·git이 권위(헌장 §4-11). 이 문서는 "어디서 이어받나 + 안 넘어가는 것".

## 0. 전파 상태 (먼저 읽기)

- **이번 세션 산출은 git-tracked지만 아직 커밋 안 됨** — 다른 PC로 가려면 `commit + push` 필요:
  - `reports/design/floor-raising-blueprint.md` (신규 청사진)
  - `.ditto/knowledge/adr/ADR-0024-floor-raising-inplace-hardening.md` (신규 ADR, proposed)
  - `.ditto/knowledge/glossary.json` (`oracle` 항목 추가)
  - `CLAUDE.md` (knowledge 재투영 — ADR-0024·oracle 반영, drift 0)
- **안 넘어가는 것**(`.ditto/local`, gitignored): wi_260623dfa의 `intent.json`·`reviews/dialectic-1.{json,md}`·`completion`·`interview-state` — 이 PC 로컬. 요지는 아래 §1에.

## 1. 이번 세션 (2026-06-23) — wi_260623dfa **DONE** (설계 WI)

"far-field 재설계"로 시작했으나 **진짜 목적은 floor-research**로 재정의: *약한 기획자도 ditto를 거치면 autopilot 최종 산출물 품질 floor가 일관되게 오르게 하는 방법*. deep-interview(8턴, 의도 잠금) → dialectic(Codex 교차모델 Opponent, verdict=**revise**) → 청사진+ADR 공동작성 → 독립 verify(7 AC 전부 pass) → `ditto work done`.

**핵심 설계 결론 (권위=ADR-0024 + 청사진):**
- **4단계 *분리* 아님 → `design` 노드 제자리(in-place) 경화.** plan을 autopilot 밖으로 빼지 않음(dialectic O1 critical: design 노드 `producePlanGate`가 plan 단계 *유일 증거 기록기*, `autopilot-loop.ts:944-985`; 분리=ADR-0023 거부한 중복 sweep). 라이프사이클 서사 의도→계획→구현→회고→정리는 유지.
- **AC↔oracle 수렴**: 완료 통화 = "AC가 *재평가 가능* oracle로 닫힘"(LLM-verdict 아님). oracle = **대상**(`maps_to`) × **검증법 3부류**: hard·동적(테스트=실행) / hard·정적(스캔=재스캔, `file:line` 앵커) / soft·판단. **forward AC = behavioral/정적(코드-포인터 금지 — 변경에 드리프트: raise≠resolution); backward finding만 `file:line`.** 변환기 적대 검증 + **oracle frozen**(구현자 oracle 수정 금지). 부착 지점: 매치=design 노드, 전달=`buildDelegationPacket`(`autopilot-dispatch.ts:108-144`, 현재 AC id만 운반), 판정=`gates.ts`.
- **회고 측정**: ①산출물 floor(AC-oracle 종결·`completion-coverage-doctor`·escape ledger) + ②과정 건강도(`intent-quality` post_cost) — **분리**. ③회고 서술 = *기존 기록(`residual`·`close_reason`·intent-drift·evidence) 투영만*, 자유 reflection 생성 금지. **지표 자체도 anti-SLOP**(근거 없으면 제외). 구조 건강(fitness)은 floor에 *안 넣음*(슬롯=유도 편향; standalone `ditto fitness`).
- **의사결정 투명성**(횡단): 게이트 판정·oracle 배정·far-field skip/route·루프 종료를 확인/문서/계약 중 하나에 기록(조용한 결정 금지, §4-10 일반화).
- 강도 = **raise + measure**(보장 아님).

## 2. 다음 착수 후보 — 구현 (전부 미착수, 후속 WI들)

ADR-0024는 **설계 결정**(코드 0). 청사진의 in-scope를 구현 WI로 분리:
- AC↔oracle 매치(design 노드)·packet 농축(`buildDelegationPacket`: AC id→AC 문장+oracle)·완료 게이트 oracle화.
- AC→oracle 변환기 적대 검증 + oracle frozen.
- deep-interview dimension 시딩(`interview-driver.ts:70` `dimensions:[]` 공허) + readiness 코드계산(`:271` LLM 자기보고).
- 출력 floor + 과정 건강도 지표 합성(기존 doctor 재료 fold).
- 루프 예산 cap + wrong-fixpoint.
- **상류 의존(별도 WI)**: AC 관측성 게이트=tech-spec(`tech-spec.ts:204-235` 형태만 검사), 과정측정=**wi_260608acp**, far-field 비용=**wi_26062227h**, fitness/구조건강=**wi_260615lj6**.

## 3. 비전파 GOTCHA / 검증 절차

- WI done 절차: `ditto verify wi_260623dfa --criterion ac-X -- grep -qF "<token>" <doc>`(정적 doc 검사 = oracle 모델의 "정적" 부류, 도그푸딩)로 7 AC pass 기록 → `ditto work done`. *deep 검증은 독립 `ditto:verifier`(fresh context)가 수행*(전부 pass).
- glossary/ADR 변경 후 `ditto bridge knowledge`로 CLAUDE.md 재투영(drift 0), `bun test tests/scripts/adr-guard.test.ts` green 확인.
- 훅이 repo 밖 쓰기(`/tmp`·scratchpad) 차단 → 임시파일은 repo 안에. 정상 CLI는 `DITTO_SKIP_HOOKS=1` prefix.
- wi_260623dfa work-item `title`은 옛 "far-field 재설계 (신뢰성·라우팅)" 그대로(goal/AC는 갱신됨) — 표시상 stale, 무해.

## 4. 다른 PC 세션 시작 — 재빌드 & setup (변동 시)

```
git pull 후: bun install (no-op 가능) → bun run build:bin && build:plugin && build:codex-plugin → ditto setup
검증: ditto doctor 전 축 drift 0. surface drift 뜨면 surfaces:gen 재생성.
```
