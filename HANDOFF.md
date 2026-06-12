# HANDOFF — 다른 PC 이어받기 (2026-06-11)

이 PC의 호스트 메모리는 전파되지 않으므로, 다른 PC 세션에 필요한 것을 전부 여기 싣는다. **origin/main 최신 = 이 문서가 포함된 커밋. 미커밋·미푸시 변경 없음**.

## 1. 닫힌 작업 — 전부 main에 푸시됨

### 2026-06-10 오후~심야 세션 (tech-spec 표면)

| work item | 내용 |
|---|---|
| wi_260610z2z | tech-spec 표면 기획문서 (`reports/design/tech-spec-surface-design.md`, dialectic-1 revise 반영, 열린 결정 2건 확정: 저장 위치=`.ditto/specs/` tier ②, digest=컴파일 입력 섹션) |
| wi_260610hwd | **ditto:tech-spec 구현 M1~M3 + deep-interview→autopilot 풀 파이프라인으로 종결(final_verdict=pass, AC 10/10)**. 산출: `skills/tech-spec/{SKILL,TEMPLATE}.md`, `ditto tech-spec start\|record-section\|finalize`(ac-9 근거 필수 스키마, 문서→intent 단방향 컴파일+source_digest), autopilot next-node digest 신선도 게이트. deep-interview는 zero-diff(계약 테스트 14건 무변경) |
| wi_260610iex | autopilot 결함 2건 수정: ① lease `scope_source(declared\|derived)` — derived(=changed_files fallback)는 훅이 차단하지 않음(오차단→Bash 우회 학습 방지), 선언 스코프만 allow-list 집행 ② generated_nodes 승격 시 커버된 pending 후속 시드(N2/N3) supersede(보수적 고정점 폐쇄) + `superseded_node_ids` 반환 |

추가: 헌장 §3에 **코드베이스 변경 lazy 게이트** 신설(아래 §4), dogfooding 산출 스펙 2부 커밋(`.ditto/specs/fact-consistency-checker{,-oneshot}.md` — 사실 일치 checker, 시뮬레이션 리뷰 라벨 명시). dogfooding fixture work item 2개(wi_2606101qn, wi_260610irs)는 `.ditto/local`(개인 구획)이라 이 PC에만 있음 — 다른 PC에서 신경 쓸 것 없음.

### 2026-06-10 오전 세션 (memory/헌장)

wi_260610s7c(memory 종합 리뷰) · wi_260610u8t(R1~R10 처리) · wi_260610767(잔여 3건 — **전체 bun test 0 fail이 정상**) · wi_260610idf(autopilot worst-fold 수정) · wi_2606108ht(헌장 §4-9 위임) · wi_260609td5(memory-graph plugin umbrella 마감). 상세는 git 이력의 2026-06-10자 본 문서.

남은 열린 work item: wi_260608pcw(환경 초기화) · wi_260608j2p(배포 재설계 — 번들 JS 런처) · wi_260608acp(intent-quality 측정). 별도 세션 소관.

## 2. 다른 PC 설치/갱신 체크리스트

설치(검증된 경로): marketplace 소스 = **GitHub incognito050924/ditto**.

```bash
claude plugin marketplace add incognito050924/ditto   # 미등록 시
claude plugin marketplace update ditto-local           # ★ 기존 설치 PC는 이게 필수 (stale 클론 함정)
claude plugin install ditto@ditto-local
```

설치 후 확인:

1. **tech-spec 표면 존재(이번 갱신의 핵심)**: `~/.claude/plugins/cache/ditto-local/ditto/0.0.0/skills/tech-spec/{SKILL,TEMPLATE}.md` 존재 + `ditto tech-spec --help`에 start/record-section/finalize. 표면 카탈로그는 30개(스킬 10).
2. **헌장 배포**: 관리블록 헌장에 `§3 코드베이스 변경 lazy 게이트`(착수=사용자 허가 후, 허가된 단위 안에서는 멈춤 금지)와 `§4-9 위임` 둘 다 존재.
3. **전역 사용자 컨텍스트**: `# 완료 게이트`/`# 사실 게이트`/`# 모호함 처리`/`# 범위`/`# TDD`/`# 커밋`/`# 자가 점검`/`# 스타일`/`# 출력` 섹션 전부 존재(상세 기준은 git 이력의 2026-06-10자 본 문서 참조).
4. **doctor**: `ditto doctor distribution --advisory` → all ok. `binary_fresh`는 설치 컨텍스트에서 vacuously true 정상.
5. **테스트 돌릴 경우**: bun ≥1.3.14, `bun test` 기대값 **0 fail**(1642+).

함정(재확인): 소스 변경 반영은 push 후 `claude plugin marketplace update ditto-local` **필수**. `claude plugin update`는 버전 0.0.0 고정이라 no-op.

## 3. 의도된 보류 + 이번 세션 follow-up 후보

기존 보류(ADR-0013에 기록): ① 승인 게이트 적대적 차단(push 확대 전 선행 게이트) ② bootstrap handoff-archive 신뢰 등급 분리 ③ pull actionability 측정.

이번 세션 추가 follow-up (전부 미착수, 우선순위 미정 — 사용자 결정 대기):

1. **실사용자 dogfooding 세션** — tech-spec ac-2/3의 생태 검증. 현재 증거는 에이전트 시뮬레이션 리뷰(라벨 명시)로 절차 동작까지만 증명.
2. **planner의 file_scope 선언 활용** — lease 수정으로 스코프 미선언 실행은 경로 강제 비활성. `nodeProposal.file_scope`(스키마 이미 지원)를 planner 프롬프트/계약에 반영하면 정밀 집행 복원.
3. **근거-주장 사실 일치 checker 구현** — 합의된 스펙이 `.ditto/specs/fact-consistency-checker.md`에 있음(stepwise 합의본). 착수 시 finalize부터.
4. **경량 모드 검토** — tech-spec 기획문서 미해결 질문 3 (12섹션 부담, 사용 증거 쌓인 뒤).
5. derived lease 환경의 우회율 계측 — 다음 autopilot 런에서 관찰(wi_260610iex completion의 unverified 항목).

## 4. 새 규칙 요약

- **헌장 §3 — 코드베이스 변경 lazy 게이트(2026-06-10 신설)**: 구현·수정·삭제는 계획 최우선, 착수는 현재 요청의 사용자 허가 후(질문·상태확인 프롬프트, 과거 승인, 핸드오프 존재 ≠ 착수 지시). 허가 단위는 사용자가 승인한 작업 단위(요청·증분·work item)이고, **허가된 실행 단위 안(autopilot 포함)에서 공연히 멈춰 절차 결정을 떠넘기는 것은 그 자체가 위반**. §10 금지에도 동기 반영.
- **헌장 §4-9**: 탐색·조사 기본 위임, 검증은 fresh context 강제, 위임엔 계약 동반. 근거: `reports/harnesses/context-rot-delegation-evidence.md`.
- **tech-spec SoT 모델**: 스펙 문서(`.ditto/specs/<slug>.md`, git 추적)가 유일 원본, intent.json은 finalize 단방향 컴파일 산출물(source_digest 스탬프). 컴파일 입력 섹션(요약·목표·비목표·AC·위험) 수정 시 autopilot이 차단되고 재-finalize 요구.
- knowledge 변경 후 `ditto memory bootstrap` 재실행(ADR-0013 drift 정책).
