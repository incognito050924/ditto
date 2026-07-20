# 재설계 정초 빌드 vehicle (/goal + 디스패처 · 순수 CC · 무-ditto)

이 번들은 **재설계 ditto 정초**(docs/redesign/ditto-rebuild-draft.md)를 자율 빌드하는 실행 도구다.
순수 Claude Code(무-ditto) 환경에서 `/goal` 구동으로 돌고, 완주가 자기채점이 되지 않게
실제 테스트 실행 + Codex 교차검증으로 완료를 강제한다.

work item: wi_260720v4m. vehicle=A(/goal + 디스패처화).

## 구성물

| 경로 | 무엇 | 관련 AC |
|---|---|---|
| `goal.md` | 봉인된 목표 프롬프트 — 빌드타깃 명세 임베드 + 목표봉인 + 디스패처위임 + 유계/escape | ac-4 |
| `config/settings.json` | 격리 `CLAUDE_CONFIG_DIR`에 심는 설정 — command Stop hook + block cap 상향 | ac-2, ac-7 |
| `config/hooks/` | command형 Stop hook 스크립트 (실제 테스트 실행 → red면 exit 2 차단) | ac-2 |
| `hooks/` | 테스트 러너 + Codex 교차검증 스크립트 | ac-2, ac-3 |
| `agents/` | 격리 워커 서브에이전트 정의 | ac-6 |
| `state/` | 단일 출처 디스크 상태 모델 (queue.json · log.jsonl) + 재시작 재개 | ac-5 |
| `check/` | 정적/스모크 검증 oracle | ac-1, ac-4, ac-7 |

## 실행 (순수 환경 레시피)

두 조건을 **둘 다** 만족해야 순수 환경이다(하나만으론 부족):

1. `CLAUDE_CONFIG_DIR=<빈 디렉토리>` — user 스코프(플러그인·글로벌 CLAUDE.md·글로벌 hooks·MCP·auto memory) 전부 격리.
   이 빈 dir에 `config/settings.json` + `config/hooks/`만 심는다.
2. `.claude`/`.mcp.json`/`CLAUDE.md` 없는 **repo-밖 `git init` 워킹트리**에서 실행 — 프로젝트 `.claude/`와 ditto `.githooks`를 피한다.

(출처: code.claude.com/docs/en/debug-your-config.md "Test against a clean configuration". 이 머신엔 managed 정책 없음이 확인돼 CLAUDE_CONFIG_DIR로 완전 격리 가능.)
Codex 교차검증은 `codex` CLI 직접 호출이라 격리해도 그대로 쓴다.

## 검증

- ac-4 (goal 앵커 정적 체크): `sh check/goal-anchors.sh`

나머지 AC(ac-1·2·3·5·6·7)의 oracle과 스크립트는 증분으로 추가된다.

## 상태 (2026-07-20)

- **DONE(증거):** ac-4 — 세 앵커 정적 grep 통과(음성 대조 실패 확인).
- **미착수(열림):** ac-1(self-contained 스모크)·ac-2(Stop hook 게이트)·ac-3(Codex 교차검증)·ac-5(디스크상태 재시작)·ac-6(통합 스모크)·ac-7(런타임 격리 스모크).
