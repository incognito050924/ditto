# LSP for Agentic Coding — 연구 + DITTO 적용성 평가

- 성격: 연구/설계 평가 보고서 (결정 아님 — 결정은 별도 ADR/증분에서)
- 출처: work item wi_2606168m0 (2026-06-16). 근거 = deep-research 하니스(102 에이전트·24/25 주장 검증) + boxwood-workspace frontend 실측(LSP 도구 직접 실행) + provisioning 코드 분석(`src/core/codeql/install.ts`).
- 거버넌스 링크: LSP를 DITTO에 통합할 경우 그것은 **ADR-0018(옵셔널 도구 우아-degrade 불변식)이 규율하는 선택적 도구**다 — 부재 시 degrade, AC를 단독으로 certify 불가.
- 상태: **평가만 완료.** 구현(provisioning / diagnostics 게이트)은 착수 안 함 — 아래 "다음 증분" 참조.

## 1. 결론

에이전트에게 LSP는 IDE 편의 도구(자동완성)로는 가치가 낮지만, **컨텍스트 효율 + 의미 grounding + 편집 후 검증 신호**로는 가치가 실증된다. 사람과 달리 가치의 분포가 옮겨간다.

## 2. 연구 findings (출처 표기)

- **가치의 본질 = 토큰/컨텍스트 효율 + grounding, 저작 편의 아님.** 자동완성은 조사한 *모든* 에이전트용 LSP 통합에서 일괄 제외. (Serena, mcp-language-server, vscode-mcp, SWE-Master) — high.
- **LSP 도구 추가 → 성공률 소폭↑ + 턴수↓.** SWE-Master(arXiv 2602.03411, SWE-bench Verified): 68.4→70.4%, 66.2→67.6%; 증류 설정 입력토큰 -23.7%, 궤적 -17.5%. 단서: 단일 벤치·Python/pyright·저자 자체평가·학습과 교란, 델타 작음(+1.4~2.0pp).
- **의미 내비게이션 제거 시 최대 하락.** HyperAgent(arXiv 2409.16299) ablation 27→19%, 24→9%. 단서: 서브에이전트 역할 전체 제거.
- **grep은 의미/교차파일에서 실증적 실패.** SWE-Master xarray 케이스: grep 91스텝 실패 vs LSP 57스텝(-37%).
- **좌표 정밀도가 LLM에 안 맞음** — go-to-def가 정확 line/col 요구; HyperAgent는 근사검색 레이어로 9→15%. (도입 최대 함정)
- **언어별 서버 셋업이 지배적 비용** → bulk 추출은 ctags/tree-sitter 선호(HyperAgent ctags; Aider tree-sitter+PageRank).
- **diagnostics = build/test 전 검증 신호**(vscode-mcp, kiro) — medium(벤더 README 근거, staleness 단서).
- **보편 우위 없음 → 하이브리드 수렴**(관계형=그래프/LSP, 전체맥락·패턴=grep). "~10배 토큰절감" 과장 주장은 반증됨(0-3).
- 연구 공백: Claude Code/Cursor/Cline의 실제 LSP 전략 1차 출처 없음.

## 3. boxwood 실측 (frontend, TS 720파일 — fresh evidence)

- **정밀도/죽은코드**: `@repo/utils`의 `formatDate` → grep 10건(활발히 쓰는 듯) vs LSP findReferences **1건(정의뿐)=미사용 export**. grep 10건은 무관한 재구현 6개 + 문자열 1개. 교차파일 색인은 `ConnectorApi`(27건/4파일)로 검증.
- **call hierarchy**: `incomingCalls`가 실제 호출자 5(교차파일 1 포함)를 *참조*와 구분 — DITTO 자가점검 "호출자 전수 확인" 그 자체.
- **hover/documentSymbol**: 시그니처+JSDoc·파일 구조맵을 파일 안 읽고(컨텍스트 효율).
- **diagnostics**: 파일 터치만으로 deprecation 자동 표출.
- **셋업 비용 실증**: 환경에 `clangd`만, `typescript-language-server`·`jdtls`·`kotlin-language-server` 부재. 좌표 정밀도 함정도 실측(메서드 위치 char 오차 → 실패).

## 4. DITTO 적용성 (티어)

- **Tier A (가치↑·마찰↓, 추천 1순위)**: autopilot implementer/verifier의 **편집 후 diagnostics 사전게이트** — 전체 테스트 전에 타입오류 컷. TDD 루프와 정합.
- **Tier B (가치↑·마찰 있음)**: 메모리그래프(ADR-0013) 코드구조 레이어의 **VERIFIED edge 출처**(LLM INFERRED 대비), 자가점검 grep→LSP. 언어별 서버 필요.
- **Tier C (본질적 긴장)**: 언어별 서버 수명주기 vs stack-agnostic·dual-host(ADR-0016/0008). raw positional LSP 직노출 금지 → 심볼이름 래퍼 필요.
- 권고: grep/Explore를 대체하지 말 것(추가). raw LSP 직노출 대신 심볼 래퍼. tree-sitter로 bulk 구조맵 + LSP는 on-demand 정밀질의(Aider 모델).

## 5. Provisioning ("CodeQL처럼 자동화" 가능한가 — 가능)

- Claude Code 공식 LSP 플러그인(typescript-lsp/jdtls-lsp/…)은 **바이너리 미동봉 설정 래퍼** — 사용자가 직접 설치(README 명시). 그래서 환경에 서버가 없으면 플러그인이 "not found".
- DITTO엔 정본 템플릿이 있다: `src/core/codeql/install.ts` — opt-in(`doctor codeql --install`), 탐지순서(env→PATH→ditto-managed), 다운로드→심링크, graceful-fail+수동안내, install.sh 부트스트랩. + `language ledger`로 대상 repo 언어를 알아 매칭 서버만 깐다.
- CodeQL과 다른 비용: CodeQL=도구1개, LSP=언어당 서버 N개·설치법 제각각(npm/jdk-download/go install) → 단일 설치기가 아니라 **언어별 provisioner 레지스트리**.

## 6. 거버넌스 링크 (ADR-0018)

LSP 통합 시 그것은 ADR-0018의 선택적 도구다: 부재→degrade(우회/대체), 단계실행·계약 안 깨짐, **diagnostics 결과는 AC를 단독 certify 못 함**(단조 사용: loud-fail 허용, silent-certify 금지). 이로써 LSP는 설계상 단일 실패점이 될 수 없다.

## 7. 다음 증분 (착수 안 함 — 별도 허가 필요)

- **(A) LSP provisioning**: `ditto doctor lsp --install`(install.ts 미러 + language-ledger 연동) — 중간 증분.
- **(B) Tier A diagnostics 게이트**: autopilot 편집 후 LSP 진단을 전체 테스트 전 단계로 — ADR-0018 단조 사용 원칙 하에.
- (C) 메모리그래프 VERIFIED edge — 큰 다증분.

## 8. 한계·미검증

정확도 이득 근거는 단일·교란 논문 1편(재현 약함). Java(portal-backend/automation-engine) LSP는 미실행(jdtls 부재). "효율·grounding"은 강하나 "정확도↑"는 과신 금물.
