# Handoff: wi_260601kbw

## 최종 verdict
pass

## acceptance
- ac-1 [pass]
- ac-2 [pass]
- ac-3 [pass]
- ac-4 [pass]
- ac-5 [pass]

## 무엇이 끝났나
provider parity (capability matrix+fail-closed). HostAdapter.capabilities 정직 선언(claude-code 5훅 / codex hooks:[] 미지원) + `ditto doctor capability` 서브커맨드가 required 미충족·hook drift를 silent 우회 없이 fail-closed(exit 비0)로 검사. autopilot 루프(N1 design→승인→N2 implement→N3 verify→N4 fail-side CLI 강화→N5 재검증), 독립 검증 5/5 pass. 커밋 32165c8(feat)+d452343(chore), origin/main 푸시 완료.

## 남은 위험
- codex hook은 '미지원(0개)' 정직 선언만 — 기능 동등화 아님(D1). codex 플러그인 hook 런타임 구현은 follow-up.
- REQUIRED_CAPABILITIES=4 boolean(instructions/permissions/mcp/surface); hook은 host-specific이라 cross-host required에서 제외(codex hooks:[]는 정직 선언이지 required 실패 아님 — D1 정합). '모든 host가 5훅 지원'을 parity 기준으로 삼으려면 별도 결정 필요.
- 이 repo 세션의 PreToolUse 안전 훅이 정상 read-only 명령(`bun test`/`bun run lint`/`bun run <bare>`)을 false-positive 차단 → `DITTO_SKIP_HOOKS=1` prefix 필요. 안전 훅 과차단은 별개 follow-up 후보.

## 다음 세션이 볼 것
- **post-v0 4종 중 3종 마감**: M6 Knowledge(wi_260601g4t)·PreToolUse safety(wi_260601pjl)·provider parity(wi_260601kbw). 남은 건 **M5 E2E runtime**(playwright-e2e agent 본문 + `/ditto:e2e` skill + Playwright capture; 현재 contract design-lock). 자세한 트랙은 메모리 project-v04-runtime-wiring 참조.

## 변경 파일
- .ditto/work-items/wi_260601kbw/autopilot.json
- .ditto/work-items/wi_260601kbw/completion.json
- .ditto/work-items/wi_260601kbw/handoff.md
- .ditto/work-items/wi_260601kbw/intent.json
- .ditto/work-items/wi_260601kbw/language-ledger.json
- .ditto/work-items/wi_260601kbw/work-item.json
- src/cli/commands/doctor.ts
- src/core/capability-inventory.ts
- src/core/hosts/claude-code.ts
- src/core/hosts/codex.ts
- src/core/hosts/types.ts
- tests/core/capability-inventory.test.ts
- tests/core/hosts/registry.test.ts
- tests/core/instruction-bridge.test.ts
- tests/core/run-with.test.ts
- tests/doctor/capability.test.ts
