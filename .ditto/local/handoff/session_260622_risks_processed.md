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

## 금지/주의
- B(A-1) 측정 게이트 없이 착수 금지(ADR-0013 D4)
- surfaces.json은 gitignored — 손편집 말고 `bun run surfaces:gen`으로 재생성
- 코드가 권위 — 이 핸드오프가 코드와 어긋나면 코드 확인 우선
