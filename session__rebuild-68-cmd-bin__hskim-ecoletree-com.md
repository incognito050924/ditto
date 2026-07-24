---
{"schema_version":"0.1.0","scope":{"kind":"session","session_id":"rebuild-68-cmd-bin"},"from_context":"Claude Code 세션(순수 CC 디스패처+fresh 서브에이전트 위임). #68 커맨드+bin 완주·push 직후.","original_intent":"DITTO를 zero-start로 재구축해 main을 재구축 ditto로 완전 대체(옛 src 은퇴). 순수 Claude Code, ditto 기계(CLI·훅·work-item 절차) 배제(재구축을 재구축으로 검증하면 순환). rebuild/ keep 능력을 rebuild 프리미티브 위 재구현→#68 호스트 셸→#69 flip. 최대한 빨리 목적지. [최신 사용자 지시] 멈추지 말고 '동작 가능한 상태'로 완주하고 push하라; 방법·이슈는 에이전트가 최선으로 처리.","current_state":"origin/main=18ac282(push완료, pre-push 863 pass 게이트 통과). #68 커맨드+bin DONE: rebuild/cli citty 척추+엔진배선 10커맨드(knowledge·memory·github·hook·gate·handoff·coverage·verify·acg·drive, 엔진 실제 받치는 verb만)+실 바이너리 번들러(bun run build:bin-rebuild→dist/ditto-rebuild 0.42MB, 바이너리에서 10커맨드 전부 실행 확인). tsc 0·rebuild 575 pass. bin/ditto는 여전히 옛 src(live dogfood, 무접촉). recorder=legacy(pre-flip).","decisions_made":["엔진 실제 받치는 verb만 노출(옛 39커맨드 전수이관 물리적 불가; 미배선 verb는 지어내지 않고 omit)","구현=fresh general-purpose 서브에이전트 per-command 위임 + 부모가 tsc·bun test 재실행+diff 적대검증(만든자≠검증자). 커밋 DITTO_SKIP_HOOKS=1 git commit --no-verify","build-bin.mjs entry 파라미터화(기본=src 불변→live bin/ditto 무영향); build:bin-rebuild가 rebuild/cli→dist/ditto-rebuild; #69 flip은 이 기본값만 뒤집음"],"critical_decisions":[{"decision":"keep=계약 재구현(adapt), 옛 코드 복사 아님","rationale":"rebuild가 foundation 재설계해 문자이식 불가"},{"decision":"rebuild/cli는 상대경로 임포트 필수, ~/ 별칭 금지","rationale":"~/*는 옛 src(./src/*)를 가리킴"},{"decision":"full flip(#69)을 지금 안 함","rationale":"미배선 30여커맨드+훅 5이벤트가 빠져 지금 flip하면 live 제품이 깨짐. parity(#92 hooks 등)+하드게이트 후 사용자 한 명령으로만"},{"decision":"실 HostDeps=rebuild/seam/live-host.ts:liveHostDeps; drive가 이걸로 배선됨","rationale":"drive 라이브 실행 미스모크(claude 스폰), runDrive 엔진은 575 FakeHost 테스트 커버"}],"irreversible_risks":[{"risk":"flip=git rm -r src/ + recorder.json flip + build 기본값 rebuild 재지정","why_irreversible":"비가역. 사용자 게이트(하드게이트 G1 KEEP runnable·G2 비사소 self-host·G3 ADR-0022 스모크 후 FLIP-READY)"}],"user_decision_block":[],"changed_files":["rebuild/cli/index.ts·util.ts·commands/{knowledge,memory,github,hook,gate,handoff,coverage,verify,acg,drive}.ts","scripts/build-bin.mjs·package.json"],"evidence_refs":[{"kind":"note","summary":"origin/main 18ac282; rebuild 575 pass·tsc 0; push-gate 863 pass; dist/ditto-rebuild 바이너리 10커맨드 실행"}],"failed_or_unverified":[],"open_threads":["[착수 방법] 1) git fetch origin && git checkout main && git reset --hard origin/main (HEAD=18ac282). 2) bun install. 3) bun run build:bin (옛 dogfood bin) 후 ./bin/ditto handoff consume session__rebuild-68-cmd-bin__hskim-ecoletree-com (이 핸드오프). 4) baseline 재현: bun test rebuild/ (575 pass)·npx tsc -p rebuild/tsconfig.json --noEmit (0)·bun run build:bin-rebuild && ./dist/ditto-rebuild --help (10커맨드). 5) 작업 시작.","#68 남은 층=plugin dist/install/release. hooks.json이 6이벤트 전부를 ditto hook으로 배선하는데 rebuild hook은 stop만 받침→설치 시 5이벤트 세션 깸. plugin/install은 #92 hooks 재구현 의존","미배선 verb(엔진 부재)=coverage store/ledger·memory 13verb·github backlog/mirror/setup·acg fitness(실 host 없음 Fake만)·verify run 오케·hook 5이벤트·handoff show/purge","재진입 남음 #82 dialectic·#92 hooks·#87 setup(#68 표면 entangle)"],"next_first_check":"git fetch로 origin/main=18ac282 확인 후 '착수 방법'대로 baseline 재현 → gh issue view 92/68로 hooks 재진입(#92) 사양 확인 → #69 flip parity 경로 재판단.","forbidden_scope_creep":["지금 full flip(#69) 실행","옛 src 코드 문자 복사","ditto CLI/autopilot/work-item으로 재구축 구동·검증(순환)","#93 Codex 표면 재구축(single-host ADR-20260722)"],"artifact_available":true,"created_at":"2026-07-24T13:50:03.544Z"}
---

# Handoff: rebuild-68-cmd-bin

from: Claude Code 세션(순수 CC 디스패처+fresh 서브에이전트 위임). #68 커맨드+bin 완주·push 직후.

## 원래 의도
DITTO를 zero-start로 재구축해 main을 재구축 ditto로 완전 대체(옛 src 은퇴). 순수 Claude Code, ditto 기계(CLI·훅·work-item 절차) 배제(재구축을 재구축으로 검증하면 순환). rebuild/ keep 능력을 rebuild 프리미티브 위 재구현→#68 호스트 셸→#69 flip. 최대한 빨리 목적지. [최신 사용자 지시] 멈추지 말고 '동작 가능한 상태'로 완주하고 push하라; 방법·이슈는 에이전트가 최선으로 처리.

## 현재 상태
origin/main=18ac282(push완료, pre-push 863 pass 게이트 통과). #68 커맨드+bin DONE: rebuild/cli citty 척추+엔진배선 10커맨드(knowledge·memory·github·hook·gate·handoff·coverage·verify·acg·drive, 엔진 실제 받치는 verb만)+실 바이너리 번들러(bun run build:bin-rebuild→dist/ditto-rebuild 0.42MB, 바이너리에서 10커맨드 전부 실행 확인). tsc 0·rebuild 575 pass. bin/ditto는 여전히 옛 src(live dogfood, 무접촉). recorder=legacy(pre-flip).

## 내려진 결정
- 엔진 실제 받치는 verb만 노출(옛 39커맨드 전수이관 물리적 불가; 미배선 verb는 지어내지 않고 omit)
- 구현=fresh general-purpose 서브에이전트 per-command 위임 + 부모가 tsc·bun test 재실행+diff 적대검증(만든자≠검증자). 커밋 DITTO_SKIP_HOOKS=1 git commit --no-verify
- build-bin.mjs entry 파라미터화(기본=src 불변→live bin/ditto 무영향); build:bin-rebuild가 rebuild/cli→dist/ditto-rebuild; #69 flip은 이 기본값만 뒤집음

## 핵심 결정 (재호출 불가)
- keep=계약 재구현(adapt), 옛 코드 복사 아님 — rebuild가 foundation 재설계해 문자이식 불가
- rebuild/cli는 상대경로 임포트 필수, ~/ 별칭 금지 — ~/*는 옛 src(./src/*)를 가리킴
- full flip(#69)을 지금 안 함 — 미배선 30여커맨드+훅 5이벤트가 빠져 지금 flip하면 live 제품이 깨짐. parity(#92 hooks 등)+하드게이트 후 사용자 한 명령으로만
- 실 HostDeps=rebuild/seam/live-host.ts:liveHostDeps; drive가 이걸로 배선됨 — drive 라이브 실행 미스모크(claude 스폰), runDrive 엔진은 575 FakeHost 테스트 커버

## 비가역 위험
- flip=git rm -r src/ + recorder.json flip + build 기본값 rebuild 재지정 — 비가역. 사용자 게이트(하드게이트 G1 KEEP runnable·G2 비사소 self-host·G3 ADR-0022 스모크 후 FLIP-READY)

## 변경 파일
- rebuild/cli/index.ts·util.ts·commands/{knowledge,memory,github,hook,gate,handoff,coverage,verify,acg,drive}.ts
- scripts/build-bin.mjs·package.json

## 증거 (inline)
- {"kind":"note","summary":"origin/main 18ac282; rebuild 575 pass·tsc 0; push-gate 863 pass; dist/ditto-rebuild 바이너리 10커맨드 실행"}

## 열린 스레드
- [착수 방법] 1) git fetch origin && git checkout main && git reset --hard origin/main (HEAD=18ac282). 2) bun install. 3) bun run build:bin (옛 dogfood bin) 후 ./bin/ditto handoff consume session__rebuild-68-cmd-bin__hskim-ecoletree-com (이 핸드오프). 4) baseline 재현: bun test rebuild/ (575 pass)·npx tsc -p rebuild/tsconfig.json --noEmit (0)·bun run build:bin-rebuild && ./dist/ditto-rebuild --help (10커맨드). 5) 작업 시작.
- #68 남은 층=plugin dist/install/release. hooks.json이 6이벤트 전부를 ditto hook으로 배선하는데 rebuild hook은 stop만 받침→설치 시 5이벤트 세션 깸. plugin/install은 #92 hooks 재구현 의존
- 미배선 verb(엔진 부재)=coverage store/ledger·memory 13verb·github backlog/mirror/setup·acg fitness(실 host 없음 Fake만)·verify run 오케·hook 5이벤트·handoff show/purge
- 재진입 남음 #82 dialectic·#92 hooks·#87 setup(#68 표면 entangle)

## 다음 agent 가 가장 먼저 볼 것
git fetch로 origin/main=18ac282 확인 후 '착수 방법'대로 baseline 재현 → gh issue view 92/68로 hooks 재진입(#92) 사양 확인 → #69 flip parity 경로 재판단.

## 금지: scope creep
- 지금 full flip(#69) 실행
- 옛 src 코드 문자 복사
- ditto CLI/autopilot/work-item으로 재구축 구동·검증(순환)
- #93 Codex 표면 재구축(single-host ADR-20260722)
