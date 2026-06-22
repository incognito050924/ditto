---
{
  "original_intent": "이전 핸드오프가 남긴 '살아있는 위험 2건'을 처리(variant 라우팅 검증 + cap-crowding)하고, 이어서 남은 이슈 중 C-6(단일 소스)와 사소 항목을 정리한다. 처리 과정에서 장기기억(GraphRAG) 전략 방향이 확정됐다 — 이게 다음 세션의 핵심 컨텍스트다.",
  "current_state": "위험 2건 + surface 회귀 + C-6/C-7/C-8/C-9 전부 처리. 전체 2619 pass / 0 fail. main HEAD = 이 핸드오프 커밋. **전략 결정: 내부 ditto memory는 동결, 에너지는 신규 GraphRAG standalone 프로젝트로(ADR-0021).** 열린 work item 2개(wi_260621i0w·wi_26062257r)는 둘 다 draft — 작은 fix라 full close 생략, 무시하거나 abandon.",
  "next_first_check": "1) git pull (main HEAD = 이 핸드오프 커밋). 2) 다른 PC면 아래 '재빌드 & setup' 프롬프트 먼저. 3) DITTO_SKIP_HOOKS=1 bun test → 2619 pass/0 fail. 4) 다음 작업 결정: GraphRAG 신규 프로젝트 부트스트랩(아래 '전략' 참고) vs C-6 외 잔여.",
  "decisions_made": [
    "★전략(ADR-0021): 장기기억=GraphRAG는 ditto repo 밖 별도 standalone 프로젝트. ditto는 소비자. 내부 memory-librarian은 D4(seam 연속성)대로 '현 동작 유지'=버그/회귀만, 기능 확장 동결. A-1/B-3/B-4(발견축·결정계보 확장)는 D2(feature parity 비목표)상 신규로 이식 안 되므로 sunk cost → 안 한다",
    "C-6 variant 단일소스: 자동생성(.claude→.ditto)은 agent-link-step.ts:72가 match=[]로 생성해 라우팅 정밀도를 깸 → 채택 안 함. 대신 spawn 가능성 불변식 가드(findOrphanVariants: .ditto/agents variant ⊆ .claude/agents)로 drift만 차단(a5af7a6)",
    "C-9: root .gitignore가 tier 정책 SoT를 이미 완전히 가짐(L473~482) → setup이 만드는 중복 .ditto/.gitignore는 추적 대신 무시(2ce079e)",
    "C-8: codex/omx-reset-plan·feat/cli-wizard-provisioner는 main 반영 확인(cherry 0) 후 로컬+원격 삭제. experiment/reframe-gap은 미병합이라 보존. archive/acg-full-bar-auto-commit은 보존 브랜치(project_acg_full_bar)라 건드리지 않음",
    "C-7: terminal work item 16개 → .ditto/local/archive/2026-06 (gitignored, 로컬 정리)"
  ],
  "failed_or_unverified": [
    "variant 실제 Task spawn은 하네스 동작이라 코드 증명 불가(검증 경계=코드↔하네스). C-6 가드는 spawn 가능'성'(host 등록 존재)까지만 보증, 실제 spawn 행위는 아님",
    "GraphRAG 신규 프로젝트 미시작 — 시드 스펙(reports/design/memory-librarian-external-seed-spec.md)만 존재, 코드 0. gbrain_verify/는 외부 참고 모델(Garry Tan/YC)이지 신규 프로젝트 아님"
  ]
}
---

# Handoff: 위험 2건 + 잔여 정리 + GraphRAG 전략 (session 2026-06-22)

## ★ 다음 세션 핵심: 장기기억 전략 (ADR-0021)

사용자가 **GraphRAG 기반 장기기억 시스템을 빨리 개발**하려 한다. ADR-0021(accepted)이 이미 방향을 못박았다:

- **신규는 ditto repo 밖 별도 standalone 프로젝트.** MCP 서버 또는 ditto-pluggable 표면. ditto는 소비자(D1).
- **흡수 = seam 대체, feature parity 비목표(D2).** 기존 ditto memory 기능을 신규로 이식하지 않는다 → **내부 memory-librarian을 더 키우는 건 신규로 안 넘어가고 seam 대체 시 폐기된다.**
- **내부 memory는 D4(seam 연속성)대로 동결** — 신규가 실증·연결되기 전까지 '현 동작 유지'(버그/회귀 수정만), 기능 확장 중단.
- 신규 = git=SoT + 그래프 투영 + 생성형 큐레이터(출처+gap+confidence, 할루시네이션 최소화) — D3/D5. gbrain 모델 차용.

**그래서 A-1/B-3/B-4(아래)는 하지 않기로 확정.** retrieval·합성·교차청크(B-5)를 신규 GraphRAG가 통째로 가져간다.

### GraphRAG 시작 방법 (미시작 상태)
1. 신규 standalone repo 부트스트랩 (ditto 밖, 예: `/Users/incognito/dev/projects/<신규>`). **이 ditto 세션에서 GraphRAG 코드 작성은 ADR-0021 D1 위반.**
2. 시드 스펙을 씨앗으로 신규 프로젝트의 deep-interview → 구체화위임: MVP·스키마·메커니즘·Memgraph vs Neo4j·MCP vs pluggable·벡터/RAG.
3. 참고: `gbrain_verify/`(외부), 시드 스펙 `reports/design/memory-librarian-external-seed-spec.md`.
- 사용자가 정할 것: 신규 repo 위치/이름. (MCP vs pluggable는 신규 deep-interview에서)

## 이번 세션 완료 (전부 main, push 완료)
- 위험2 cap-crowding (47388f2) · 위험1 variant 검증(코드 0) · surface 회귀(5b41ee0) — 이전 핸드오프 항목
- **C-6** variant↔host spawn 불변식 가드 findOrphanVariants (a5af7a6)
- **C-7** terminal work item 16개 archive (.ditto/local/archive/2026-06, 로컬)
- **C-8** 스테일 브랜치 — omx-reset-plan·cli-wizard-provisioner 로컬+원격 삭제, reframe-gap 보존(미병합)
- **C-9** root .gitignore에 중복 .ditto/.gitignore 무시 (2ce079e)
- 검증: 2619 pass / 0 fail, biome·adr-guard 통과

## 남은 후속
### 동결(하지 않음 — ADR-0021)
- ~~A-1 coverageRoots file_scope 시드~~ / ~~B-3 불변식 위반율 측정~~ / ~~B-4 contradiction 자동검출~~ — 내부 memory 확장이라 신규 GraphRAG로 흡수·폐기 대상. 손대지 말 것.
- B-5 교차청크/섬그래프 한계 → **신규 GraphRAG가 푸는 문제**(보류 합의 그대로).

### 살아있음(내부 memory와 무관)
- experiment/reframe-gap 미병합 브랜치 — 살릴지 버릴지 사용자 판단 대기(삭제=비가역이라 보존 중)
- docs/memory-librarian-spec 로컬 브랜치 — main 병합됨, 정리 가능(이번 C-8 범위 밖이라 안 건드림)

## 다른 PC 세션 시작 시 — 복붙용 프롬프트

### 1) 재빌드 & setup 재실행
```
git pull 했어. ditto 바이너리를 재빌드하고 setup을 다시 실행해서 글로벌 설치본·.claude/agents variant 링크·allowlist를 최신 코드에 동기화해줘.
- bun install (의존성 변동 대비; 변동 없으면 no-op)
- bun run build:bin && bun run build:plugin && bun run build:codex-plugin
- ditto setup (인터랙티브로 — variant agent-link 포함. --yes는 agent-link를 건너뛰니 쓰지 마)
검증: ditto doctor 로 surface/capability/distribution drift 0 확인. (PreToolUse 훅이 정상 명령을 false-positive로 막으면 DITTO_SKIP_HOOKS=1 prefix)
```

### 2) deep-interview 전역 설정(config.json) 생성
`.ditto/local/config.json`은 tier ③ per-developer · **gitignored**라 다른 PC엔 없다(push하지 않고 각 PC에서 만든다).
```
.ditto/local/config.json 을 만들어서 deep-interview 전역 기본값을 넣어줘. gitignored per-developer 설정이라 커밋·push하지 마. 이 PC와 동일하게:
{
  "deep_interview": { "threshold": 0.85, "generators": 6 },
  "tech_spec": { "question": { "performance": "exhaustive" } }
}
스키마(src/schemas/ditto-config.ts): deep_interview.threshold(0~1)·question_cap(양의정수)·generators(양의정수). tech_spec.question 은 performance(glance|quick|standard|deep|exhaustive)·intensity(0~100)·generators(1~6)·gate_mode(confirm|draft)·granularity(low|medium|high) 등. 우선순위 CLI flag > config > code default, fail-open. 파일 없으면 코드 기본값(threshold 0.7/cap 8/generators 1).
```

## 금지/주의
- **내부 memory 기능 확장 금지(ADR-0021 D2/D4)** — 버그/회귀만. 새 능력은 신규 GraphRAG 프로젝트로.
- **이 ditto 세션에서 GraphRAG 코드 작성 금지(ADR-0021 D1)** — 별도 repo여야 함.
- surfaces.json·config.json·.ditto/.gitignore·.ditto/local/은 gitignored — push하지 않는다.
- 코드가 권위 — 이 핸드오프가 코드와 어긋나면 코드 확인 우선.
