# HANDOFF — tech-spec 전문가-유도 질문 + 상시 비판축 (2026-06-19)

다른 PC에서 이어받기 위한 문서. 클라우드 세션에서 설계까지만 하고 중단 — 구현은 로컬 PC에서.

- **브랜치**: `claude/deep-interview-skill-gaps-g5liop` (이 핸드오프 + 설계문서가 포함된 커밋이 최신).
- **설계문서(본체)**: `reports/design/tech-spec-expert-elicitation-design.md` ← **여기에 합의 전부가 있다. 먼저 읽어라.**
- **부모/맥락**: `reports/design/tech-spec-surface-design.md`(tech-spec 원설계), `skills/tech-spec/{SKILL,TEMPLATE}.md`(강화 대상), `skills/deep-interview/SKILL.md`(무변경 대상).

## 1. 이 작업이 무엇인가 (한 문단)

tech-spec 작성 시 에이전트가 **과제별 전문가 고려사항을 "좋은 질문"으로 유도**(맹점을 보게 + 방향 유지)하고, 답 못하는 사용자를 **편향 비용 순 도움 사다리**로 돕고, 사용자 답변과 산출물 전체에 **상시 비판축(pre-mortem)**을 돌리며, **질문 문구는 산출물에 누출하지 않는다.** 목표: 누가 쓰든 산출물 품질 균일화. deep-interview는 모호성 축소 축으로 **무변경**.

## 2. 잠긴 결정 (재논의 불필요)

1. deep-interview는 narrowing 축 유지, **zero-diff**. 생성/유도는 deep-interview에 안 넣는다.
2. 생성/전문가-유도 능력은 **tech-spec의 핵심 동작(A)**으로 — 옵트인 모드 아님.
3. 고려사항은 **고정 체크리스트 금지, 과제별 생성**(deep-interview 7차원·ouroboros 10섹션식 고정 분류 복제 안 함).
4. gstack식 비즈니스/포부 질문("10배 버전?")은 **제외**. 차용 선례는 ouroboros `[from-code]→DECISIONS`, omx Analyst, omx `≥2 options+steelman`(반-앵커링).
5. 도움은 **편향 비용 순 사다리**(질문 설명 → 참고 지도 → opt-in 복수안 조사). "정답 주기"가 기본값이 아니다.
6. 비판축은 **답변 + 산출물 전체**를 대상으로 **상시**(1회 의식 아님).
7. 질문 문구 **산출물 누출 금지** + 기존 pre-mortem 템플릿 누출 결함 수정.

## 3. 열린 결정 2건 (이어받아 풀 것)

1. **tech-spec 범위** — 비개발 과제까지 받나(②=폭의 예시, 표면은 기술 스펙 유지가 기본값) vs 표면 확장(①). 사용자 확정 필요.
2. **균일 품질 보증 근거** — 고정 체크리스트 없이 무엇이 바닥선을 지탱하나. 잠정답은 설계문서 §9-2. wi_260608acp(intent-quality 측정)와 연계 검토.

## 4. 다른 PC에서 이어가는 절차

> ⚠ work item `wi_260619qul`는 `.ditto/local`(개인 구획, git 미추적)이라 **전파 안 됨**. 새로 만든다.

1. 브랜치 체크아웃: `git fetch origin claude/deep-interview-skill-gaps-g5liop && git switch claude/deep-interview-skill-gaps-g5liop`.
2. 설계문서 정독: `reports/design/tech-spec-expert-elicitation-design.md`.
3. (착수 전) **ADR 충돌 확인**: `ditto memory query`로 deep-interview 고정 차원/tech-spec 원설계 결정과의 정합 점검(ADR-0020). 충돌이 intent 층위면 사용자 확인.
4. work item 생성 후 tech-spec로 상세화 — 설계문서 §7 AC 후보를 입력으로:
   - `ditto work start "<goal>" --request "<...>" --title "tech-spec 전문가-유도 질문 + 상시 비판축"`
   - `ditto tech-spec start --work-item <wi> --doc .ditto/specs/tech-spec-expert-elicitation.md --mode stepwise`
   - 섹션 작성/리뷰 → `ditto tech-spec finalize ...` → intent.json + autopilot bootstrap.
5. `ditto autopilot next-node` 루프로 구현→검증. 변경 주축은 `skills/tech-spec/SKILL.md`(soft 절차), 템플릿 누출 수정, 테스트(ac-5 누출 회귀 / ac-6 deep-interview zero-diff).
6. 완료 게이트: `bun test` 0 fail(현재 기준선 1642+), `ditto work done` 증거 게이트.

## 5. 현재 상태 / 미커밋

- 생성됨(이 커밋): `reports/design/tech-spec-expert-elicitation-design.md`, 본 핸드오프.
- 코드/스킬/템플릿/스키마: **미변경**.
- 로컬 전용(전파 안 됨): work item `wi_260619qul`(draft) — 무시 가능, 다른 PC에서 새로 만들 것.
