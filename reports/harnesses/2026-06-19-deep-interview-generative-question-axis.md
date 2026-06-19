# 조사: deep-interview류의 "생성적 질문 vs 모호성 축소" 축 (2026-06-19)

> **목적**: tech-spec 강화 설계(`reports/design/tech-spec-expert-elicitation-design.md`)의 증거 기반. 4개 하네스(oh-my-codex, oh-my-claudecode, ouroboros, gstack)를 1차 자료(GitHub)로 조사해, 각자가 *생성적 발굴 질문*을 정의하는지 / *모호성 축소*만 하는지 가렸다.
> **방법**: 각 저장소를 병렬 subagent가 GitHub 1차 자료로 읽고, 기존 로컬 리포트(`reports/harnesses/*.md`)와 대조. finding(증거 있음)과 inference(해석) 분리.
> **계기**: DITTO deep-interview가 "요청의 모호성 축소"는 잘하지만, "사용자가 만들고자 하는 것을 발굴·확장·가지치기하는 질문"은 부족하다는 문제 제기.

## 0. 한 줄 결론

4개 모두 deep-interview류의 핵심은 **모호성 축소(narrowing) archetype**다. 생성적 발굴은 (있다면) **별도 스킬로 분리**돼 있고, 그 성격도 갈린다. **DITTO deep-interview는 이 narrowing 축에 이미 정확히 들어맞으며, 그대로 둔다.** 생성/유도 능력은 tech-spec으로 간다(설계문서 참조).

## 1. 비교표

| 저장소 | 모호성 축소 면 | 생성적 발굴 질문 정의? | 어디에/성격 |
|---|---|---|---|
| oh-my-codex | `$deep-interview`(전용) | **부분** | `$plan` Interview Mode + `$ralplan` 옵션 생성. deep-interview는 브레인스토밍을 `plan`으로 명시 리다이렉트. 반응적(선택지 떠올랐을 때) |
| oh-my-claudecode | `deep-interview`(전용) | **부분** | `omc-plan`/`ralplan`. deep-interview "Do Not Use When: explore/brainstorm → use omc-plan" |
| ouroboros | socratic-interviewer(전용) | **거의 없음** | 고정 10섹션 gap-ledger. 생성 전용 면 부재. `[from-code]→DECISIONS`만 결정-유도 |
| gstack | `spec`(5-phase 축소) | **있음 — 1급 스킬** | `office-hours`(생성)↔`spec`(축소) 아키텍처 분리. 단 질문이 비즈니스/포부형 |

## 2. 저장소별 finding (증거)

### 2-1. oh-my-codex (`Yeachan-Heo/oh-my-codex` @ `6d438dac`)

- `skills/deep-interview/SKILL.md`: "intent-first Socratic clarification loop." 6개 고정 clarity 차원(Intent/Outcome/Scope/Constraint/Success Criteria/Context) + Non-goals·Decision Boundaries 게이트. "Each round targets the weakest clarity dimension." 종료=ambiguity threshold(quick≤0.30/standard≤0.20/deep≤0.15). 유일한 tradeoff probe도 *범위를 자른다*(추가 아님). → 순수 narrowing.
- **deep-interview가 브레인스토밍을 스스로 밀어냄**: "do not use when: lightweight brainstorming only (use `plan` instead)."
- 생성 면 = `skills/plan/SKILL.md`: "Interview Mode (broad/vague requests)." 옵션 점진 제시("Present one option with trade-offs, get reaction, then present the next"; A/B/C/D 한꺼번에 = 안티패턴). 옵션 템플릿 `### Option A: [Name]/Approach/Pros/Cons`. progressive("Each question builds on the previous answer"). 숨은요구 발굴("Consult Analyst (THOROUGH) for hidden requirements, edge cases, and risks").
- `skills/ralplan/SKILL.md`: 강제 옵션 생성 — "Viable Options (≥2) with bounded pros/cons", Architect "strongest steelman antithesis". → 생성은 *솔루션 축*("어떻게 만드나"), *문제 축*("무엇을 만드나")은 아님.

### 2-2. oh-my-claudecode (`Yeachan-Heo/oh-my-claudecode` @ `1fe17f0`)

- `skills/deep-interview/SKILL.md`: 순수 narrowing. 4개 clarity 차원(Goal/Constraint/Success/Context). "targets the WEAKEST clarity dimension." Challenge 에이전트(Contrarian/Simplifier/Ontologist)가 약한 생성 기미 — 특히 **Simplifier**("What's the simplest version that would still be valuable? Which constraints are necessary vs assumed?")가 *범위 가지치기*로 의도와 부분 일치.
- "Do Not Use When: User wants to explore options or brainstorm — use `omc-plan` skill instead." → 의도적 분리.
- 생성 면 = `skills/plan/SKILL.md`(omc-plan): 옵션 생성 + pros/cons + react-loop. `skills/ralplan`: ≥2 옵션 + steelman + critic("fair alternative exploration"). 단 **반응적**(선택지가 떠오를 때), 얇은 요청에서 능동적 아이디어 확장은 아님.

### 2-3. ouroboros (`Q00/ouroboros` @ `32fcaf10`)

- 질문 생성이 **gap-driven**: `auto/ledger.py` `REQUIRED_SECTIONS`(고정 10섹션) → `auto/gap_detector.py` `GapType`(1:1) → `socratic-interviewer.md`가 "biggest source of ambiguity" 질문 1개 → `auto/answerer.py`가 섹션으로 재분류. 단위 = "정해진 슬롯 채우기."
- `agents/socratic-interviewer.md:13`: "generate the single best Socratic question to **reduce ambiguity**."
- **유일한 결정-유도**: `socratic-interviewer.md:28-31` — "Use `[from-code]` facts as context, but focus questions on INTENT and DECISIONS. Ask 'Why?' and 'What should change?' rather than 'What exists?' GOOD: 'Given that JWT auth exists, should the new module extend it or use a different approach?'" → 단 brownfield 한정, 이항 결정.
- `agents/seed-closer.md:8`: "unresolved decisions that would change execution exposed" — 결정 노출이되 *종료 게이트*용, 생성 아님.
- 생성/브레인스토밍/옵션-메뉴: **없음**(grep generativ|brainstorm|option|alternative → seed-closer "unasked alternatives" 종료 체크뿐). simplifier/architect/hacker는 *정체 회복* 페르소나(기존 plan에 작동), 전방 아이디어-성장 아님.

### 2-4. gstack (`garrytan/gstack`, main) — 신뢰도 高

- Garry Tan의 Claude Code/Codex 스킬 팩(~50 스킬, 역할 기반 sprint). **`office-hours`(생성/발굴, plan 이전) ↔ `spec`(축소) 아키텍처 분리. office-hours 산출물은 코드가 아니라 design doc.**
- `office-hours/SKILL.md` Builder Mode — 소스에 "generative, not interrogative", 자세="enthusiastic collaborator bringing 'what if you also...'": "What's the coolest version of this?" / "Who would you show this to? What makes them say 'whoa'?" / "What existing thing is closest to this, and how is yours different?" / "What's the 10x version?"
- Startup Mode — 수요 발굴 6문(pushback until specific): "strongest evidence someone would be genuinely upset if it disappeared", "Name the actual human who needs this most", "smallest version someone would pay for this week."
- `plan-ceo-review/SKILL.md` — 키우고-가지치기: "10x more ambitious for 2x effort, describe concretely", "Is this the right problem?" + 항목별 **A)add B)defer C)skip** 결정 + 거부항목 "NOT in scope" 카탈로그.
- `spec/SKILL.md` — DITTO 현 tech-spec과 거의 동형 축소(5-phase Why/Scope/Technical, "Don't ask questions you can answer by reading the code").

## 3. 메타 finding — 기존 로컬 리포트의 사각지대

`reports/harnesses/{oh-my-codex,oh-my-claudecode,ouroboros}.md`는 **모호성 게이트·readiness 점수·breadth control은 잘 잡았으나 생성 축을 누락**했다. 구체적으로:

- deep-interview가 브레인스토밍을 `plan`으로 *의도적으로 리다이렉트*한다는 핵심 아키텍처 사실 미기록.
- `plan`/`ralplan`의 옵션 생성·progressive 질문·option 템플릿을 분석 안 하고 이름만 나열.
- ouroboros 리포트는 인터뷰어를 모호성 축소로 (옳게) 분류했으나 *생성 부재를 공백으로 표시*하지 않음. seed-closer 결정-노출·`[from-code]→DECISIONS`·breadth-keeper/simplifier도 미표면화.
- gstack은 로컬 리포트 자체가 없었음.

→ DITTO가 이 하네스들을 흡수할 때 "모호성 축소" 렌즈만 적용해 생성 축을 통째로 빠뜨린 것이 deep-interview-contract의 사각지대 원인. (이 노트가 그 교정.)

## 4. 설계로의 차용 (inference — 상세는 설계문서)

- **deep-interview = narrowing 유지**(무변경). 생성/유도 = tech-spec 핵심 동작.
- 차용 선례: ouroboros `[from-code]→DECISIONS`(코드 닻 결정-유도), omx Analyst(hidden requirements/edge cases/risks), omx `≥2 options+steelman`(반-앵커링 복수안).
- **제외**: gstack `office-hours`의 비즈니스/포부 질문("10배 버전") — 본 의도(전문가 고려사항·방향 유지)와 어긋남.
- 고정 분류(ouroboros 10섹션·omc/omx 고정 차원)는 **복제하지 않음** — 고려사항은 과제별 생성.

> 출처 주의: 위 인용은 각 저장소의 표시 커밋/`main`에서 subagent가 WebFetch/clone으로 읽은 것. omc-codex `prometheus-strict` 등 일부는 표시 커밋 이후 `main` 파일이라 시점 차 있음(해당 보고에 명시). 재확인 시 커밋 SHA 고정 권장.
