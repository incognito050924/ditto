# Progress: wi_v02doctor

## 현재 상태
`in_progress` — 2026-05-24 18:30 D-1 ~ D-11 모두 [DECIDED]. status를 draft → in_progress로 전환. P-0(host adapter)부터 시작.

## 진행 로그
- 17:50 work item 초안 작성. D-1, D-2 확정. D-3~D-8 사용자 결정 대기.
- 18:00 D-8 [DECIDED: Codex + Claude Code]. D-3~D-7 두 host 관점으로 재정의. D-9~D-11 신규 결정 항목 추가.
- 18:30 D-3~D-11 추천안 채택. D-4는 사용자 보정: Claude Code MCP 경로를 공식 scope 순서(.mcp.json → ~/.claude.json project entry → user entry → 그 외 unverified)로 변경. status 전환.

## 다음 fresh evidence
- P-0 (host adapter) 완료 시점에 `tests/core/hosts/{codex,claude-code}.test.ts` 통과 결과 + 전체 `bun test`/`lint`/`tsc` 통과 결과

## 새 세션에서 이어받기

진입 순서:
1. `git status` clean 확인
2. `bun install`
3. `bun test`로 기준선(현재 79 pass) 통과 확인
4. `cat .ditto/work-items/wi_v02doctor/context-packet.md`로 review 합의/금지 사항 숙지
5. `cat .ditto/work-items/wi_v02doctor/plan.md`로 P-0부터 진행

review timing은 context-packet.md의 "Review 합의" 표 참조. 4회 review로 묶음.