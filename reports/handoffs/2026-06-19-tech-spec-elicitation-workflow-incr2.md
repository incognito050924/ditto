# HANDOFF — tech-spec 질문 생성·선정 워크플로 (증분 2, wi_260619tf7) · 2026-06-19

새 세션 이어받기용. **설계 합의·커밋 완료, 구현 미착수.** 설계 본체는 설계문서에 있고, 여기는 운영 포인터 + 잠긴/열린 결정 요약.

- **work item**: `wi_260619tf7` (이 머신). 새 세션: `ditto work resume wi_260619tf7`. (다른 PC면 `.ditto/local` 미전파 → 설계 §7 AC로 새로 생성.)
- **브랜치/worktree**: `claude/deep-interview-skill-gaps-g5liop` @ `.ditto/local/worktrees/deep-interview-skill-gaps-g5liop`. origin 대비 **ahead, push 안 함**.
- **설계 (먼저 읽어라)**: `reports/design/tech-spec-expert-elicitation-design.md` — **§6-6**(워크플로 전체) · **§7 ac-10~12** · **§9 #3~#7**(열린 결정) · 상태 헤더.
- **머신 핸드오프**: `.ditto/local/handoff/wi_260619tf7.md` (ditto 생성 — resume·changed_files).
- **선행**: 증분 1(소프트 계약 ac-1~9) 커밋 `54c5743`. 증분 2 설계 커밋 `330207b`.

## 1. 무엇인가 (한 문단)

질문 생성을 driver 인라인 → **fresh·최소-패킷 서브에이전트**로 옮긴다. 다수 생성기(×N 병렬)가 최소 컨텍스트로 후보 질문 생성 → 선정 게이트가 fan-in으로 점수화·선정 → 임계 이상 질문이 없으면 점수 기반으로 라운드/인터뷰 종료. 목적 = 편향(fresh context) + context rot(최소 패킷·driver-leanness) 둘 다 차단. 질문은 점수 스키마로 구조화해 나중 활용. (상세 §6-6.)

## 2. 잠긴 결정 (재논의 X) — 상세 §6-6

- 로직 3역할: driver / 생성기 ×N(병렬·fresh·최소패킷) / 선정 게이트(fan-in 점수·선정).
- **서브에이전트 무중첩** 제약(`agents/researcher.md` 등 Agent 도구 없음) → 게이트가 직접 생성기 호출 못 함. **driver가 fan-out**, 게이트는 선정 전용.
- 최소 패킷 = {정해진 사실·결정(맹점 가드), 프로젝트 현황·환경, 현재 draft/빈 섹션}. 제외 = 인터뷰 서사·driver 추측.
- driver-leanness: 압축 SoT(문서 + 사실 ledger + §12 요약)에서 일하고 긴 세션 handoff reset → driver도 rot 방지.
- 종료 = loop-until-dry, 게이트 점수 임계 기반(고정 개수 아님).
- 점수 스키마: `{text, 성질태그(맹점/확장/정향), why_matters, scores:{consensus,quality,necessity,answer_value}, selected, rationale}`.
- deep-interview zero-diff. 사용자 표면 캡(스킬1·템플릿1) 무변경 — 추가는 substrate(에이전트 2종). dogfooding 제품 동작이라 **ADR 승격 없음**(SoT=배포 스킬/에이전트).

## 3. 착수 전 풀 것 (사용자 몫) — §9

- **#3 "공통 질문 개수" 의미**: 합의 중복도(필요성 신호) vs 목표 개수(예산) vs 둘 다.
- **#4 종료 임계 + 단위**: 임계를 고정/적응형/사용자설정 중 무엇으로 · "라운드 종료" ↔ "인터뷰 종료" 관계.
- #5~#7은 기본값 있음(생성기 N=3 / 점수 영속 위치 / 게이트 직접질문=driver 반환). 그대로면 그대로.

## 4. 이어가는 절차

1. `ditto work resume wi_260619tf7` → 설계 §6-6·§9 정독.
2. §9 #3·#4 사용자 확정.
3. (착수 전) `ditto memory query`로 ADR 충돌 확인(ADR-0020; projection absent면 `.ditto/knowledge/adr/` 직접 읽기).
4. 구현: `agents/tech-spec-questioner.md`(생성기) + `agents/tech-spec-question-gate.md`(선정 게이트) 신규 — `agents/researcher.md`의 6-section 패킷·Context-Isolation 패턴 차용. SKILL "Expert elicitation" 인라인→위임 재배선 + driver-leanness 명시. 점수 스키마(zod SoT는 `src/core` 확인).
5. 검증: `bun run surfaces:gen` + 에이전트 인벤토리 테스트 + `bun test`(기준선 2377 pass). ac-10·11·12.
6. 완료 게이트: `ditto work done`(evidence).

## 5. gotchas

- fresh worktree/clone: `bun install` + `bun run surfaces:gen` 먼저 — 안 하면 surface-inventory 7건이 환경 원인으로 false-fail. 이 worktree는 이미 됨.
- `.ditto/local` work item은 이 머신 한정(미전파).
- 커밋은 했지만 **push 안 함**.
