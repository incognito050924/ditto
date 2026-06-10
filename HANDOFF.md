# HANDOFF — 다른 PC 신규 설치 실측 준비 완료 (2026-06-10)

이 PC의 호스트 메모리는 전파되지 않으므로, 다른 PC 세션에 필요한 것을 전부 여기 싣는다. **origin/main 최신 = 이 문서가 포함된 커밋. 미커밋·미푸시 변경 없음**(예외: `agentic-coding-masters-research.md` untracked — 별도 작업 소속, 무시).

## 1. 오늘(2026-06-10) 닫힌 작업 — 전부 done, 전부 main에 푸시됨

| work item | 내용 |
|---|---|
| wi_260610s7c | memory 종합 리뷰 라운드1+2 (`reports/reviews/memory-subsystem-review*.md`) |
| wi_260610u8t | 라운드2 발견 R1~R10 전부 처리(본문검색 가시성, supersede 대칭, hook 축소, secret 배선, drift 가드 등) |
| wi_260610767 | 잔여 3건: repo-self-validation 테스트 결함 제거(**이제 전체 bun test 0 fail이 정상**), events list secret redact, hook 따옴표 오탐 해소+우회 폐쇄 |
| wi_260610idf | autopilot worst-fold(gotcha #3) 수정 — implement 노드 acrefs 정상 유지 + 하류 verifier가 닫으면 final_verdict=pass. **completion 우회 절차 폐기** |
| wi_2606108ht | 헌장 §4-9(위임으로 컨텍스트를 지킨다) + 근거 노트(`reports/harnesses/context-rot-delegation-evidence.md`) + glossary(context rot) |
| wi_260609td5 | memory-graph plugin 풀 구축 umbrella — 산출물 기준 AC 도출 후 마감(이견 있으면 재개) |

남은 열린 work item: wi_260608pcw(환경 초기화)·wi_260608j2p(배포 재설계) — 별도 세션 소관(전역 리소스 GLOBAL_*.md는 `45223d1`로 커밋됨), wi_260608acp(intent-quality 측정).

## 2. 다른 PC 신규 설치 실측 체크리스트

설치(이 PC에서 검증된 경로): marketplace 소스 = **GitHub incognito050924/ditto**.

```bash
claude plugin marketplace add incognito050924/ditto   # 마켓플레이스 미등록 시
claude plugin install ditto@ditto-local
```

설치 후 확인할 것(이 PC에서는 캐시 재설치로 전부 검증됨 — 신규 환경 실측이 목적):

1. **헌장 배포**: `~/.claude/plugins/cache/ditto-local/ditto/0.0.0/resources/managed/AGENTS.md`에 `4-9. 위임으로 컨텍스트를 지킨다` 존재.
2. **setup 적재**: 테스트 프로젝트에서 `ditto setup` → 그 프로젝트 CLAUDE.md 관리블록에 §4-9 포함 헌장, `.ditto/{knowledge,local}` 스캐폴드, `.claude/settings.json` allowlist. 전역 `~/.claude/CLAUDE.md`에 GLOBAL_CLAUDE.md 관리블록 적용(기존 내용은 블록 밖 보존 + `.ditto_bak` 백업).
3. **doctor**: `ditto doctor distribution --advisory` → all ok 기대. `binary_fresh`는 설치 컨텍스트(src/ 없음)에서 vacuously true가 정상.
4. **hook 스모크**: 따옴표 안 `>`+경로 문자열이 든 명령은 통과, repo 밖 redirect(따옴표 포함)는 차단, `~/.claude/projects/<현재 슬러그>/memory/` 쓰기는 허용·타 프로젝트는 차단.
5. **테스트 돌릴 경우**: bun ≥1.3.14, `bun test` 기대값 **0 fail**(1595+).

함정: 소스 변경을 반영하려면 push 후 `claude plugin marketplace update ditto-local`이 **필수**(생략하면 stale 클론에서 옛 코드 재설치 — 이 PC에서 실측). `claude plugin update`는 버전 0.0.0 고정이라 no-op.

## 3. 의도된 보류 (ADR-0013 보강·재검토 조건에 기록됨)

1. 승인 게이트 적대적 차단 — **§5-2~5-5 push 확대 work item을 열기 전 선행 게이트.**
2. bootstrap handoff-archive 신뢰 등급 분리 — 세탁 실측 시.
3. pull actionability 측정 — 명시 보류(hit_node_types 분해는 구현됨).

## 4. 새 규칙 요약 (이 PC 세션들이 합의한 것)

- **헌장 §4-9**: 탐색·조사는 기본 위임(반환=결론·증거·불확실성), 검증은 fresh context 강제(compaction은 편향 보존), 진짜 격리 가능할 때만 분할, 위임엔 계약 동반, 긴 세션은 handoff reset. 근거: `reports/harnesses/context-rot-delegation-evidence.md`.
- **knowledge 변경 후 `ditto memory bootstrap` 재실행**(ADR-0013 drift 정책) — 이 핸드오프 직전에 이행됨(projection fresh, 53 nodes, pending 0).
- 빌드 drift는 `ditto doctor distribution`의 `binary_fresh`가 감시(dev repo에서만 유효).
