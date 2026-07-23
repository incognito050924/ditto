---
{"schema_version":"0.1.0","scope":{"kind":"session","session_id":"sess-2026-07-23t00-51-57-150z-087734"},"from_context":"재설계를 완주한 세션 — deep-interview→autopilot 8노드→검증→결함수정(wi_2607220o1)→랜딩·push까지","original_intent":"핸드오프 재설계(wi_260722g7h, done·push 완료)의 잔여·후속을 새 세션에서 진행","current_state":"완료: 숨은 ref 바통 스토어·동기화·CLI·채점 분리·구 스토어 제거·문서·ADR-20260722 전부 랜딩, origin에 브랜치+refs/ditto/handoffs push됨(마이그레이션 바통 5건 포함), 9/9 AC 증거 검증. 미착수 잔여만 남음.","decisions_made":["핸드오프=사용자-개시 1:1 소멸성 바통, 숨은 ref 단일 스토어 (ADR-20260722-handoff-hidden-ref-baton)","push 상시허가: refs/ditto/* 한정 ①바통 ②삭제기록 ③보존 truncation(force-with-lease만), 코드 브랜치 불포함"],"critical_decisions":[{"decision":"채점·done/partial 전환을 핸드오프에 재결합하지 않기로 확정","rationale":"사용자 정의 — 핸드오프는 컨텍스트 압축+목적지+현재 상태 전달뿐, 자동 발행·자동 저장도 정의상 핸드오프가 아님"}],"irreversible_risks":[],"user_decision_block":[],"changed_files":[],"evidence_refs":[],"failed_or_unverified":[],"open_threads":["wi_2607222uc: stop 게이트 decision-conflict 캐리어에 해소 전이 부재(supersede 랜딩 후 영구 블록) — 등록만 됨, 미구동","glossary.json의 handoff 정의가 구 모델 서술로 stale — 바통·숨은 ref·1:1 미반영","docs/features/memory.md:235 — 제거된 handoff archive를 살아있는 전제처럼 언급","purgeHandoffHistory는 core 함수만 있고 CLI 표면 없음 — 비밀 유출 시 회수 경로의 사용자 접근성","online consume이 ref를 2회 fetch(해석 전+삭제push lease) — syncHandoffRef 시그니처 변경 필요한 최적화, 비용은 단일 ref 왕복 1회","고엔트로피 스크럽 휴리스틱 오탐 시 UX 마찰 가능(40+자 혼합 문자열이 push 거부됨) — 경고문에 우회 안내는 있음"],"next_first_check":"ditto work show wi_2607222uc 로 후속 1건 확인 후, 이 바통의 열린 스레드 목록과 대조해 어떤 것부터 갈지 사용자와 정하기","forbidden_scope_creep":["핸드오프에 채점·완료판정·자동 발행 재도입","잔여 처리를 핑계로 바통 모델 자체 재설계"],"artifact_available":true,"created_at":"2026-07-23T00:51:57.150Z"}
---

# Handoff: sess-2026-07-23t00-51-57-150z-087734

from: 재설계를 완주한 세션 — deep-interview→autopilot 8노드→검증→결함수정(wi_2607220o1)→랜딩·push까지

## 원래 의도
핸드오프 재설계(wi_260722g7h, done·push 완료)의 잔여·후속을 새 세션에서 진행

## 현재 상태
완료: 숨은 ref 바통 스토어·동기화·CLI·채점 분리·구 스토어 제거·문서·ADR-20260722 전부 랜딩, origin에 브랜치+refs/ditto/handoffs push됨(마이그레이션 바통 5건 포함), 9/9 AC 증거 검증. 미착수 잔여만 남음.

## 내려진 결정
- 핸드오프=사용자-개시 1:1 소멸성 바통, 숨은 ref 단일 스토어 (ADR-20260722-handoff-hidden-ref-baton)
- push 상시허가: refs/ditto/* 한정 ①바통 ②삭제기록 ③보존 truncation(force-with-lease만), 코드 브랜치 불포함

## 핵심 결정 (재호출 불가)
- 채점·done/partial 전환을 핸드오프에 재결합하지 않기로 확정 — 사용자 정의 — 핸드오프는 컨텍스트 압축+목적지+현재 상태 전달뿐, 자동 발행·자동 저장도 정의상 핸드오프가 아님

## 열린 스레드
- wi_2607222uc: stop 게이트 decision-conflict 캐리어에 해소 전이 부재(supersede 랜딩 후 영구 블록) — 등록만 됨, 미구동
- glossary.json의 handoff 정의가 구 모델 서술로 stale — 바통·숨은 ref·1:1 미반영
- docs/features/memory.md:235 — 제거된 handoff archive를 살아있는 전제처럼 언급
- purgeHandoffHistory는 core 함수만 있고 CLI 표면 없음 — 비밀 유출 시 회수 경로의 사용자 접근성
- online consume이 ref를 2회 fetch(해석 전+삭제push lease) — syncHandoffRef 시그니처 변경 필요한 최적화, 비용은 단일 ref 왕복 1회
- 고엔트로피 스크럽 휴리스틱 오탐 시 UX 마찰 가능(40+자 혼합 문자열이 push 거부됨) — 경고문에 우회 안내는 있음

## 다음 agent 가 가장 먼저 볼 것
ditto work show wi_2607222uc 로 후속 1건 확인 후, 이 바통의 열린 스레드 목록과 대조해 어떤 것부터 갈지 사용자와 정하기

## 금지: scope creep
- 핸드오프에 채점·완료판정·자동 발행 재도입
- 잔여 처리를 핑계로 바통 모델 자체 재설계
