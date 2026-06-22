---
{
  "original_intent": "이전 핸드오프(session_260622_memory_followups)가 남긴 '살아있는 위험 2건'을 처리한다 — (1) variant 라우팅이 실제로 동작하는지 검증, (2) warm-start cap-crowding(artifact 노드가 root·Decision을 cap에서 축출) 해소. 처리 중 발견한 f95ebec surface drift 회귀도 함께 수정.",
  "current_state": "위험 2건 처리 완료 + surface 회귀 수정. 전체 2615 pass / 0 fail. 커밋 2개(47388f2 cap, 5b41ee0 surface) main에 올림 — push는 이 핸드오프 커밋과 함께. wi_260621i0w는 추적상 draft 유지(작은 fix라 full 파이프라인 close 생략; intent.json 없어 ditto work done 불가 — 닫지 말고 무시하거나 abandon).",
  "next_first_check": "1) git pull (main HEAD = 이 핸드오프 커밋). 2) DITTO_SKIP_HOOKS=1 bun test → 2615 pass/0 fail 확인. 3) 후속 우선순위 결정: B(coverageRoots 코드범위 시드, 측정게이트 선행) vs 결정계보 ③④⑤.",
  "decisions_made": [
    "위험2 cap: 사전순 .sort() → tier 정렬(roots→Decision→나머지, tier 내 사전순). memory-warmstart.ts:217~. RED(artifact:a~h 8개가 root+Decision 축출) → GREEN. 이전 핸드오프 'A.2 cap 가치순 정렬' 완료 = cap-crowding LIVE 리스크 근본 해결",
    "위험1 variant: 코드 변경 없이 검증으로 종결. .ditto/agents catalog 3개 → selectVariantCandidates가 owner+glob로 라우팅(core→core-implementer 등) 실증. 코드경로(agent-variants→autopilot-loop:267)·SKILL.md:34 지침·세션 Agent 레지스트리 모두 OK. 실제 Task spawn만 하네스 동작이라 코드 관측 불가(검증 경계=코드↔하네스)",
    "surface 회귀: f95ebec가 .claude/agents에 3 variant 추가(variant 라우팅에 필수)했으나 surface catalog 카운트 기대값 미갱신 → 테스트 4 fail. 디스크 진실(20 agents=17 plugin+3 .claude/agents)에 기대값 36→39 동기화(surface-inventory.plugin.test.ts:18). 완화 아님 — 코드가 권위",
    "surfaces.json은 의도적 gitignored(상위 .gitignore:474, per-developer 산출물). 커밋 대상 아니고 CI/로컬이 surfaces:gen으로 재생성. 그래서 fix=테스트 기대값 갱신뿐"
  ],
  "failed_or_unverified": [
    "variant 실제 Task spawn: driver(main agent)가 packet.variant_candidates에서 subagent_type을 골라 실제로 spawn하는지는 하네스 동작이라 코드로 증명 불가. 이번 세션 Agent 도구엔 cli/core/schema-implementer 등록 확인됨 — 실 spawn은 autopilot 구현 노드 돌릴 때 관측해야",
    ".ditto/.gitignore untracked(이전 핸드오프 항목10): 추적 여부 미판단, 이번 범위 밖이라 그대로 둠. 상위 .gitignore가 handoff/surfaces 중복 커버하므로 당장 문제는 아님",
    "단일 소스 follow-up: .claude/agents(호스트 spawn 등록)와 .ditto/agents(ditto variant catalog)가 cli/core/schema-implementer를 중복 보유. 한 소스에서 생성하는 step 미착수"
  ]
}
---

# Handoff: 살아있는 위험 2건 처리 (session 2026-06-22, 이어서)

## 이번 세션 완료 (커밋 main, push는 이 핸드오프와 함께)
- **위험2 cap-crowding 해소** (47388f2, 동작적, wi_260621i0w) — warm-start `RELATED_NODE_CAP` slice를 가치순 tier 정렬로. roots·Decision이 incidental Artifact 노드에 밀려 cap에서 빠지던 LIVE 리스크 제거. 테스트 RED→GREEN(`tests/core/memory-warmstart.test.ts`의 `(cap)` 케이스)
- **위험1 variant 라우팅 검증** — 코드 변경 없음. 라우팅 경로·지침·catalog 모두 작동 실증
- **surface drift 회귀 수정** (5b41ee0) — f95ebec가 남긴 surface inventory 테스트 4 fail 해소

## 검증 (fresh evidence)
- `DITTO_SKIP_HOOKS=1 bun test` → **2615 pass / 0 fail** (이전 4 fail 전부 해소, cap 회귀 0)
- variant 실증: `selectVariantCandidates(catalog, 'implementer', ['src/core/...'])` → `['core-implementer']` (cli/schema도 각 스코프 매칭, 무매칭→`[]` owner fallback)
- biome·adr-guard 통과(pre-commit)

## 남은 후속 (이전 핸드오프에서 승계 — 우선순위)
### A. 발견 축 가치 확장
1. **B: coverageRoots를 changed_files/file_scope(코드범위)로 시드** — "그 코드 작업 중일 때" 발견 자동 재주입. ⚠️ **ADR-0013 D4 §5 expansion → hit율 측정 게이트 선행 필수**(warmstart-usage.jsonl의 opportunity/attempt/hit/actionable). 측정 없이 착수 금지
2. ~~cap 가치순 정렬~~ — **이번에 완료**(47388f2)
3. 자동 추출 트리거 / decision-brief 격상 / dedup-vs-결정계보축 / 여정·기각이유 슬라이스

### B. 결정계보 축 잔여
4. **③ 불변식 위반율 측정** — ADR에 불변식 전용 섹션 구조화 선행 필요(현재 비결정적). measureHallucination 옆
5. **④ contradiction 자동 검출·해소** — 현재 audit은 카운트만
6. **교차 청크 의미 검색 한계** — 큰 별도 작업(GraphRAG급). "나중에" 보류 합의됨

### C. 환경/하네스
7. **단일 소스 follow-up** — .claude/agents ↔ .ditto/agents variant 중복을 한 소스 생성으로
8. done work item archive(`.ditto/local/archive/`, ADR-0005 D3)
9. 스테일 브랜치 정리 — experiment/reframe-gap, codex/omx-reset-plan, feat/cli-wizard-provisioner(wi_260616us6 done)
10. `.ditto/.gitignore` untracked 추적 여부 판단

## 다른 PC 세션 시작 시 — 복붙용 프롬프트

이번 세션에서 ditto를 재빌드했고(bin/ditto·dist/plugin·dist/codex-plugin) `.claude/agents` variant 3개가 main에 올라가 있다. 다른 PC는 pull 후 아래 두 가지를 처리한 뒤 작업을 이어가면 된다.

### 1) 재빌드 & setup 재실행 프롬프트
```
git pull 했어. ditto 바이너리를 재빌드하고 setup을 다시 실행해서 글로벌 설치본·.claude/agents variant 링크·allowlist를 최신 코드에 동기화해줘.
- bun install (의존성 변동 대비; 변동 없으면 no-op)
- bun run build:bin && bun run build:plugin && bun run build:codex-plugin
- ditto setup (인터랙티브로 — variant agent-link 포함. --yes는 agent-link를 건너뛰니 쓰지 마)
검증: ditto doctor 로 surface/capability/distribution drift 0 확인. (PreToolUse 훅이 정상 명령을 false-positive로 막으면 DITTO_SKIP_HOOKS=1 prefix)
```

### 2) deep-interview 전역 설정(config.json) 생성 프롬프트
`.ditto/local/config.json`은 tier ③ per-developer · **gitignored**라 다른 PC엔 없다(그래서 push하지 않는다 — 각 PC에서 직접 만든다). deep-interview/tech-spec 전역 기본값을 쓰려면:
```
.ditto/local/config.json 을 만들어서 deep-interview 전역 기본값을 넣어줘. 이 파일은 gitignored per-developer 설정이라 커밋·push하지 마. 내가 이 PC에서 쓰던 값과 동일하게:
{
  "deep_interview": { "threshold": 0.85, "generators": 6 },
  "tech_spec": { "question": { "performance": "exhaustive" } }
}
스키마(src/schemas/ditto-config.ts): deep_interview.threshold(0~1, readiness 게이트), question_cap(양의 정수), generators(양의 정수, 질문 생성기 fan-out). tech_spec.question 은 performance(glance|quick|standard|deep|exhaustive)·intensity(0~100)·generators(1~6)·gate_mode(confirm|draft)·granularity(low|medium|high) 등. 우선순위는 CLI flag > config > code default, fail-open(없거나 깨지면 코드 기본값으로 무시).
```
> 위 값은 이 PC의 현재 config.json 그대로다. 다른 값을 원하면 그 자리에서 조정하면 된다. 파일을 안 만들면 코드 기본값(deep-interview threshold 0.7 / questionCap 8 / generators 1)으로 동작한다.

## 금지/주의
- B(A-1) 측정 게이트 없이 착수 금지(ADR-0013 D4)
- surfaces.json·config.json은 gitignored — push하지 않는다. surfaces.json은 `bun run surfaces:gen`으로 재생성, config.json은 각 PC에서 생성
- 코드가 권위 — 이 핸드오프가 코드와 어긋나면 코드 확인 우선
