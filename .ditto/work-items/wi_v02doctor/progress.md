# Progress: wi_v02doctor

## 현재 상태
`in_progress` — 2026-05-24 18:30 D-1 ~ D-11 모두 [DECIDED]. status를 draft → in_progress로 전환. P-0(host adapter)부터 시작.

## 진행 로그
- 17:50 work item 초안 작성. D-1, D-2 확정. D-3~D-8 사용자 결정 대기.
- 18:00 D-8 [DECIDED: Codex + Claude Code]. D-3~D-7 두 host 관점으로 재정의. D-9~D-11 신규 결정 항목 추가.
- 18:30 D-3~D-11 추천안 채택. D-4는 사용자 보정: Claude Code MCP 경로를 공식 scope 순서(.mcp.json → ~/.claude.json project entry → user entry → 그 외 unverified)로 변경. status 전환.

## 진행 로그 (이어서)
- (새 세션) P-0 host adapter + P-1~P-5+P-5b 묶음 + P-6 fixture/regression 한 번에 구현. bun test 98 pass.
- 1차 review: 9개 finding(F-1~F-9). 사용자 fix.
  - F-1 InvalidHostError + instanceof
  - F-2 fixture <host>/<scenario>/ 일관 패턴
  - F-3 instructions test 5+ 케이스 회귀
  - F-4 HostAdapter.loadInstructions 사용
  - F-5 .claude/settings.json mcpServers server name 포함
  - F-6 surface-catalog zod schema + self-validation 등록
  - F-7 agents .md 파일 + 디렉터리 둘 다 수집
  - F-9 unverified가 dangerous_count 제외
  - F-8 (side_effect_label enum 정리)은 v0.3로 미룸 (사용자 동의)
- 2차 review: F-10, F-11 추가 발견 후 사용자 fix.
  - F-10 agents listFiles에 .md 필터
  - F-11 instruction-bridge source fallback에서 codex hard-bind 제거, registry 동적 탐색 + 회귀 테스트
- 일관성 보완: commands에도 .md 필터 추가 (107 → 107 pass 유지).

## 자기 마감 (P-7 + P-8)
ditto verify로 ac-1~ac-8 검증 (모두 해당 회귀 테스트 묶음 실행):
- ac-1 ↔ tests/doctor/instructions.test.ts
- ac-2 ↔ tests/doctor/permissions.test.ts
- ac-3 ↔ tests/doctor/mcp.test.ts
- ac-4 ↔ tests/doctor/surface.test.ts
- ac-5 ↔ tests/doctor 전체 (출력/exit 회귀)
- ac-6 ↔ tests/schemas/repo-self-validation.test.ts
- ac-7 ↔ tests/bridge/sync.test.ts
- ac-8 ↔ tests/core/hosts/registry.test.ts

전부 exit 0 → verdict=pass. `ditto work handoff wi_v02doctor`로 final_verdict=pass, status=done, closed_at 박힘. changed_files 99개 자동 수집(origin/main 대비).

## post-review correction
- AC-8 scope 보정: 새 host 자동 지원 claim을 제거하고 codex(primary)/claude-code(compatibility) 두 built-in host 지원으로 정리.
- AC-1 보강: `doctor instructions --output json`에 host별 `results[]`를 추가해 정상 상태에서도 path/status/sha/findings가 드러나도록 구현.
- 검증: `bun test` 107 pass / 0 fail, `bun run tsc --noEmit` exit 0, `bun run lint` exit 0.

## 결과
- bun x tsc --noEmit 통과
- bun run lint 통과 (55 files)
- bun test: 107 pass / 0 fail
- wi_v02doctor.status=done, final_verdict=pass
- DITTO가 v0.2 doctor + bridge를 자기 도구로 검증해 마감한 두 번째 사례(wi_v01implement에 이은).

## 새 세션에서 이어받기

진입 순서:
1. `git status` clean 확인
2. `bun install`
3. `bun test`로 기준선(현재 79 pass) 통과 확인
4. `cat .ditto/work-items/wi_v02doctor/context-packet.md`로 review 합의/금지 사항 숙지
5. `cat .ditto/work-items/wi_v02doctor/plan.md`로 P-0부터 진행

review timing은 context-packet.md의 "Review 합의" 표 참조. 4회 review로 묶음.
