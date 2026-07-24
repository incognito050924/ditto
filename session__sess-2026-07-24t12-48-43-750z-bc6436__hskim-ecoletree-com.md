---
{"schema_version":"0.1.0","scope":{"kind":"session","session_id":"sess-2026-07-24t12-48-43-750z-bc6436"},"from_context":"Claude Code 세션. main 트렁크(옛 foundation 승격), retire/main=옛 트렁크 아카이브. 재진입 buildable-now 5/8 완주·push 직후.","original_intent":"DITTO를 zero-start로 재구축해 main을 재구축 ditto로 완전 대체(옛 src 은퇴). rebuild/에서 keep 능력을 rebuild 프리미티브 위에 재구현→#68 호스트 셸→#69 flip. 순수 Claude Code, ditto 기계(CLI·훅·work item 절차) 배제(사용자: 현재 ditto 불신, 재구축을 재구축 대상으로 검증하면 순환). 최대한 빨리 목적지.","current_state":"origin/main=eb931ce. 재진입 5단위 DONE·close·적대검증·push: #81 coverage(rebuild/coverage/)·#89 push-gate(rebuild/gate/push-gate*)·#85 github SoT(rebuild/github/)·#88 A17 analysis seam(rebuild/analysis/)·#90 A21 ACG(rebuild/acg/). bun test rebuild/ 575 pass/0 fail·tsc 0.","decisions_made":["구동=메인 디스패처+fresh 서브에이전트 전량위임(순수 CC general-purpose, ditto:* 아님)+적대검증(만든자≠검증자, 부모가 bun test 재실행+diff).","#68 CLI=옛 39커맨드+훅6 전수 이관 후 별도 구조커밋 정리(사용자 확정).","커밋=green일 때만 DITTO_SKIP_HOOKS=1 git commit --no-verify(옛 pre-push/pre-commit 훅이 전체테스트 66s 돌려 지연·bin 재빌드 오염)."],"critical_decisions":[{"decision":"keep=계약 재구현(adapt)","rationale":"옛 코드 복사 아님. rebuild가 foundation 재설계(이벤트소싱 record/store·oracleMapsTo 등)해 옛 코드 문자이식 불가. 각 keep 유닛=그 능력의 ADR 계약을 rebuild 프리미티브 위 재구현+fixture 계약테스트. #81 실증 확정, 모든 keep에 적용."},{"decision":"main=재구축 트렁크·retire/main=옛 아카이브","rationale":"flip은 단일 main 커밋(git rm -r src/ + .ditto/recorder.json={recorder:rebuild}), 크로스브랜치 병합 없음. flip게이트=rebuild/record/flip-gate.ts assertRebuildRecorderEnabled."},{"decision":"single-host(Claude Code 전용)","rationale":"ADR-20260722 정합, #93 Codex 표면 후행 제외."}],"irreversible_risks":[{"risk":"main 대체(git rm src/ + recorder flip)는 비가역","why_irreversible":"flip은 하드게이트 충족+throwaway 스모크 후 <FLIP-READY/>에서 사용자 한 명령으로만."}],"user_decision_block":[],"changed_files":["rebuild/coverage/","rebuild/gate/push-gate.ts","rebuild/github/","rebuild/analysis/","rebuild/acg/"],"evidence_refs":[{"kind":"note","summary":"bun test rebuild/ 575 pass/0 fail, tsc -p rebuild/tsconfig.json exit 0 (origin/main eb931ce)."}],"failed_or_unverified":[],"open_threads":["#68 호스트 셸=bin·CLI dispatch(citty)·plugin manifest·skills(18)·agents(21)·dist/install + 옛 39커맨드·훅6 이관. rebuild에 전무.","#82/#92/#87은 #68 인프라 위 조각(스키마/게이트로직은 지금 가능하나 스킬·에이전트·훅 표면/배선은 #68 필요).","#69 flip 하드게이트: G1 KEEP 전수 runnable·G2 비사소 self-host 실증·G3 ADR-0022 스모크(dogfood→릴리스→throwaway). src rm+recorder flip push=사용자 게이트(<FLIP-READY/>)."],"next_first_check":"남은 재진입 3건(#82 dialectic·#92 hooks·#87 setup)은 #68 호스트 셸과 entangle — #68부터 착수. gh issue view <n> --repo incognito050924/ditto로 사양 확인, 위상 재판단.","forbidden_scope_creep":["옛 src 코드 문자 복사(재설계된 foundation과 구조 충돌).","마이그레이션 코드 작성(실 .ditto/knowledge·memory는 읽기전용 유산).","ditto CLI/autopilot/work-item으로 재구축 구동·검증(순환).","#93 Codex 표면 재구축(single-host 결정)."],"artifact_available":true,"created_at":"2026-07-24T12:48:43.750Z"}
---

# Handoff: sess-2026-07-24t12-48-43-750z-bc6436

from: Claude Code 세션. main 트렁크(옛 foundation 승격), retire/main=옛 트렁크 아카이브. 재진입 buildable-now 5/8 완주·push 직후.

## 원래 의도
DITTO를 zero-start로 재구축해 main을 재구축 ditto로 완전 대체(옛 src 은퇴). rebuild/에서 keep 능력을 rebuild 프리미티브 위에 재구현→#68 호스트 셸→#69 flip. 순수 Claude Code, ditto 기계(CLI·훅·work item 절차) 배제(사용자: 현재 ditto 불신, 재구축을 재구축 대상으로 검증하면 순환). 최대한 빨리 목적지.

## 현재 상태
origin/main=eb931ce. 재진입 5단위 DONE·close·적대검증·push: #81 coverage(rebuild/coverage/)·#89 push-gate(rebuild/gate/push-gate*)·#85 github SoT(rebuild/github/)·#88 A17 analysis seam(rebuild/analysis/)·#90 A21 ACG(rebuild/acg/). bun test rebuild/ 575 pass/0 fail·tsc 0.

## 내려진 결정
- 구동=메인 디스패처+fresh 서브에이전트 전량위임(순수 CC general-purpose, ditto:* 아님)+적대검증(만든자≠검증자, 부모가 bun test 재실행+diff).
- #68 CLI=옛 39커맨드+훅6 전수 이관 후 별도 구조커밋 정리(사용자 확정).
- 커밋=green일 때만 DITTO_SKIP_HOOKS=1 git commit --no-verify(옛 pre-push/pre-commit 훅이 전체테스트 66s 돌려 지연·bin 재빌드 오염).

## 핵심 결정 (재호출 불가)
- keep=계약 재구현(adapt) — 옛 코드 복사 아님. rebuild가 foundation 재설계(이벤트소싱 record/store·oracleMapsTo 등)해 옛 코드 문자이식 불가. 각 keep 유닛=그 능력의 ADR 계약을 rebuild 프리미티브 위 재구현+fixture 계약테스트. #81 실증 확정, 모든 keep에 적용.
- main=재구축 트렁크·retire/main=옛 아카이브 — flip은 단일 main 커밋(git rm -r src/ + .ditto/recorder.json={recorder:rebuild}), 크로스브랜치 병합 없음. flip게이트=rebuild/record/flip-gate.ts assertRebuildRecorderEnabled.
- single-host(Claude Code 전용) — ADR-20260722 정합, #93 Codex 표면 후행 제외.

## 비가역 위험
- main 대체(git rm src/ + recorder flip)는 비가역 — flip은 하드게이트 충족+throwaway 스모크 후 <FLIP-READY/>에서 사용자 한 명령으로만.

## 변경 파일
- rebuild/coverage/
- rebuild/gate/push-gate.ts
- rebuild/github/
- rebuild/analysis/
- rebuild/acg/

## 증거 (inline)
- {"kind":"note","summary":"bun test rebuild/ 575 pass/0 fail, tsc -p rebuild/tsconfig.json exit 0 (origin/main eb931ce)."}

## 열린 스레드
- #68 호스트 셸=bin·CLI dispatch(citty)·plugin manifest·skills(18)·agents(21)·dist/install + 옛 39커맨드·훅6 이관. rebuild에 전무.
- #82/#92/#87은 #68 인프라 위 조각(스키마/게이트로직은 지금 가능하나 스킬·에이전트·훅 표면/배선은 #68 필요).
- #69 flip 하드게이트: G1 KEEP 전수 runnable·G2 비사소 self-host 실증·G3 ADR-0022 스모크(dogfood→릴리스→throwaway). src rm+recorder flip push=사용자 게이트(<FLIP-READY/>).

## 다음 agent 가 가장 먼저 볼 것
남은 재진입 3건(#82 dialectic·#92 hooks·#87 setup)은 #68 호스트 셸과 entangle — #68부터 착수. gh issue view <n> --repo incognito050924/ditto로 사양 확인, 위상 재판단.

## 금지: scope creep
- 옛 src 코드 문자 복사(재설계된 foundation과 구조 충돌).
- 마이그레이션 코드 작성(실 .ditto/knowledge·memory는 읽기전용 유산).
- ditto CLI/autopilot/work-item으로 재구축 구동·검증(순환).
- #93 Codex 표면 재구축(single-host 결정).
