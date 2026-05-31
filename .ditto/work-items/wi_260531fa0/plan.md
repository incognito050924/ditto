# Plan — wi_v04dialectic_runtime (wi_260531fa0)

## 배경

`DialecticDeliberationContract` schema(`src/schemas/dialectic.ts`, 123줄)와 3역 agent 파일은 있으나 **호출자 0건**: agent 본문은 skeleton, `/ditto:dialectic` skill은 "how는 contract 문서 소유"라고만 함, `OpponentModelRouter` 미구현, Stop hook이 dialectic ledger를 안 봄.

## 핵심 결정 (권위 문서 ↔ 메모리 충돌 해소)

메모리 ③ 노트는 "nodeKind enum에 dialectic 추가 + 드라이버가 dialectic 노드 자동 spawn"을 제안했다. 그러나 **권위 문서가 다르게 규정**한다:
- `autopilot-contract.md §2.2 line 67`: `review` owner = reviewer, **"high-impact 산출물은 dialectic 3역(§6.6)"**.
- `dialectic-deliberation-contract.md §1.2 line 47`: dialectic은 high-impact 노드(review·plan·architecture)에서 드라이버가 *호출*하는 검증 단계.

헌장 §2 우선순위(도메인/저장소 규칙 > 내 메모리)에 따라 **문서를 따른다**: dialectic은 새 nodeKind가 아니라 review/high-impact 노드의 메커니즘. `nodeKind`/`nodeOwner` enum, `KIND_TO_OWNER` **미변경**. 이 결정으로 ③ 범위가 메모리 추정(1500-2500줄)보다 작아진다(~700-1200줄).

## AC (work-item.json 요약)

- **AC-1** `OpponentModelRouter`(`src/core/opponent-router.ts`): `resolveOpponentCandidates` + `selectOpponent`(가용성→fallback provenance). 결정론.
- **AC-2** 3역 agent 본문(skeleton 제거): Context Isolation·oracle-linked objection·admissibility.
- **AC-3** `/ditto:dialectic` SKILL.md 운영 절차(별도 spawn·router·산출물·라운드 정책).
- **AC-4** Stop hook dialectic ledger cross-check(verdict reject/blocked·미해결 admissible → continuation; taste 제외; malformed fail-closed).
- **AC-5** conformance + 회귀 + 문서.

## 모델 라우팅 (dialectic-contract §3)

| token | provider(enum) | model | 비고 |
|---|---|---|---|
| `codex` | `codex` | `codex` | opponent 기본(있으면 우선) |
| `claude-opus` | `claude-code` | `claude-opus` | fallback 1 |
| `claude-sonnet` | `claude-code` | `claude-sonnet` | fallback 2 |
| 기타/`current-host` | `claude-code` | token | 기본 |

fallback 사유 enum: `auth|network|cost|runtime|none`(`opponentFallbackReason`, 이미 schema에 존재). Codex 불가 자체는 실패 아님(§3.2) — fallback이 정상 경로.

## admissibility (dialectic-contract §6, convergence와 동형)

- objection이 **admissible** = `maps_to` 비어있지 않음(oracle 연결) ∧ `severity ∈ {critical, high}`.
- `maps_to` 없으면 `taste` — 기록은 하되 action/blocker 아님(convergence honesty의 finding⇔hypothesis와 동형).
- Synthesizer는 admissible objection만 action gate; 나머지도 ledger에 기록.

## Tidy First 분리 (예상 commits)

1. `feat(M3): OpponentModelRouter — codex→claude fallback resolution + provenance (동작적)` — AC-1 + 단위 테스트.
2. `feat(M3): dialectic 3-role agent bodies (producer/opponent/synthesizer) (동작적)` — AC-2.
3. `feat(M3): /ditto:dialectic skill driver procedure (동작적)` — AC-3.
4. `feat(M3): Stop hook cross-checks dialectic ledger admissibility (동작적)` — AC-4.
5. `feat(M3): conformance — opponent router + admissibility + Stop dialectic cross-check (동작적)` — AC-5.
6. `docs(v0): conformance matrix + plan reflect wi_v04dialectic_runtime (검증 전용)`.
7. `docs(ditto): close wi_v04dialectic_runtime`.

## 검증

```
bun test
bun test tests/core/opponent-router.test.ts
bun test tests/hooks/stop.test.ts
bun test tests/conformance/m3.conformance.test.ts
bun run lint
```

## 범위 밖

- 실제 Codex CLI 호출 glue(§3.4 별도 얇은 층) — v0는 router 정책 + provenance 기록까지.
- nodeKind/owner enum 변경(권위 문서상 불필요).
- KnowledgeContract(⑤), E2E(⑥).
