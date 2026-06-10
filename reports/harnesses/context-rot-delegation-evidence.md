---
title: "Context rot과 위임 — 헌장 §4-9의 근거"
tier: 1
repo: all
last_updated: 2026-06-10
scope: "context rot의 실증 근거(Chroma), Claude Code 실증상(GitHub issues), Anthropic 공식 처방, 위임의 편향 감소 메커니즘과 비용 트레이드오프. 헌장 AGENTS.md §4-9(위임으로 컨텍스트를 지킨다)의 근거 문서."
kind: ditto-research
sources:
  - https://www.trychroma.com/research/context-rot
  - https://code.claude.com/docs/en/best-practices
  - https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
  - https://www.anthropic.com/engineering/multi-agent-research-system
  - https://www.anthropic.com/engineering/harness-design-long-running-apps
  - https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them
  - https://claude.com/blog/context-management
  - https://github.com/anthropics/claude-code/issues/1534
  - https://github.com/anthropics/claude-code/issues/13112
  - https://github.com/anthropics/claude-code/issues/10881
last_ingested: 2026-06-10T16:30:00+09:00
---

# Context rot과 위임 — 헌장 §4-9의 근거

> **무엇에 대한 문서인가**: 헌장 `AGENTS.md §4-9`(위임으로 컨텍스트를 지킨다)를 추가하며 수집·검증한 근거. 1차 자료 9건을 subagent가 직접 fetch해 검증했다(2026-06-10, wi_2606108ht).
> **소비자**: §4-9를 적용·수정·반박하려는 세션. `blogs/01-anthropic-engineering-survey.md`·`blogs/02-managed-agents-annotated-ko.md`와 보완 관계 — 그 둘이 하네스 구조 일반론이라면, 이 문서는 "main agent가 언제 위임해야 하나"에 한정한다.

## 1. 두 메커니즘 — 용량과 편향

context rot은 한 단어지만 결과물을 해치는 경로는 둘이고, 해법이 다르다.

**(A) 용량 문제 — attention budget 고갈.** 입력이 길수록 성능이 비균일하게 저하된다. 실증: Chroma의 18개 frontier 모델 통제 실험(2025) — window 한도 도달 훨씬 전부터 저하가 시작되고, distractor 1개만으로도 정확도가 떨어지며 길이가 길수록 증폭된다. Claude 계열은 focused(~300토큰) vs full(~113k토큰) 프롬프트 격차가 측정 모델 중 가장 컸다. Anthropic은 자사 블로그(Effective context engineering)에서 이 연구를 "context rot"이라는 용어로 직접 인용하고, transformer의 n² pairwise attention에서 비롯한 유한한 "attention budget"으로 원인을 설명한다. Claude Code 공식 best practices는 모든 권고의 제1 전제를 "context window fills up fast, and performance degrades as it fills"로 명문화한다.

**(B) 편향 문제 — context as prior.** 적재된 맥락은 in-context conditioning으로 작동해 이후 판단을 자기 서사 쪽으로 끌어당긴다. 근거:
- Harness design(Anthropic, 2026-03): self-evaluation 과신 관찰 — "에이전트에게 자기 산출물을 평가시키면 명백히 평범한 결과도 자신 있게 칭찬한다". 처방 = generator/evaluator의 컨텍스트 분리.
- Best practices: "서브에이전트로 코드를 리뷰시켜라 — fresh context는 자기 코드에 편향되지 않는다"; "같은 이슈를 2번 이상 교정했으면 컨텍스트가 실패한 접근법으로 오염된 것 — 깨끗한 세션 + 더 나은 프롬프트가 누적된 세션을 거의 항상 이긴다".
- (A)의 distractor 실험은 (B)의 정량 단서이기도 하다: 오염 맥락은 수동적 낭비가 아니라 판단을 능동적으로 끌어내린다.

**설계 함의**: (A)는 compaction으로도 완화되지만 **(B)는 compaction이 고착시킨다** — 요약에 결론·자기 서사가 실려 넘어간다. 그러므로 fresh-context 검증은 효율이 아니라 **검증의 유효성 조건**이다(§4-9 둘째 규칙의 근거). dialectic의 Opponent를 Codex(타 모델)로 두는 것은 컨텍스트 격리를 넘어 모델 격리까지 가는 한 단계 강한 버전이다.

## 2. 위임이 듣는 메커니즘 (정량)

- subagent는 fresh context에서 수만 토큰을 태우며 탐색하고 **1~2k 토큰의 압축 결론만 반환**한다(Effective context engineering 원문 수치).
- multi-agent research system: Opus 4 lead + Sonnet 4 subagents가 single-agent Opus 4를 내부 research eval에서 **90.2%** 능가. 토큰 사용량 단독으로 성능 분산의 80%를 설명 — 병렬 격리 컨텍스트가 단일 윈도우 총량 한계를 우회한다.
- API 차원 보강(Claude Developer Platform): context editing + memory tool로 agentic search +39%, 100-turn 워크플로 토큰 -84% (claude.com/blog/context-management).

## 3. 비용과 경계 조건 — 위임은 기본값이 아니다

같은 Anthropic 자료의 균형추:

- 멀티에이전트는 동등 작업 대비 **3~10x 토큰**(research 시스템은 chat 대비 ~15x). 가치가 비용을 지불할 만한 지점(검증·탐색)에 선별 투입한다.
- "**Each handoff loses context**" — 구현→테스트식 역할 릴레이는 "왜 그렇게 구현했는지"를 잃는다(telephone game).
- "**Work should only be split when context can be truly isolated**" — 독립 research path·명확한 component 경계는 분할 가능, 같은 기능의 순차 단계는 분할 금지. 코딩은 research보다 공유 컨텍스트 의존이 강하다.

**ditto식 해소**: 인간 조직의 의도 훼손은 구두 릴레이의 성질이다. ditto는 의도를 타입 있는 계약(IntentContract·acceptance criteria·delegation packet·completion contract)으로 운반하므로 릴레이 단계가 늘어도 원본 의도의 동일 사본이 전달된다. 뒤집으면 — **계약 없는 위임은 인간 조직과 같은 속도로 의도가 썩는다**. §4-9 넷째 규칙(위임에는 계약 동반)의 근거.

## 4. Claude Code 실증상 (커뮤니티)

- #1534: auto-compact 후 working memory 상실 — env vars·합의된 workflow를 잊고, 물으면 답하지만 능동 적용하지 않음 (closed).
- #13112: auto-compact마다 "forget everything", 수동 재구축 필요 (closed as not planned).
- #10881: 장기 세션에서 응답 수 분까지 저하 (open) — 단, 모델 rot이 아니라 클라이언트 프로세스 결함 혐의. 커뮤니티 보고는 모델 rot과 client memory leak이 섞여 있어 개별 정량화는 안 됨.

## 5. §4-9로의 귀결

| §4-9 규칙 | 1차 근거 |
|---|---|
| 탐색·조사·벌크 분석은 기본 위임, 반환은 결론·증거·불확실성 | best practices "infinite exploration" 실패 패턴 + multi-agent 압축 수치 |
| 검증·리뷰는 fresh context — compaction 맥락은 검증에 부적격 | Harness design self-eval 과신 + best practices fresh reviewer + §1(B) |
| 진짜 격리 가능할 때만 분할 | "truly isolated" 경계 조건 + handoff 손실 |
| 위임에는 계약 동반 | telephone game + ditto 계약 운반 구조(§3) |
| 요청 경계 handoff reset ≠ compaction | Harness design의 reset/compaction 구분 + blogs/02 §4.2 |

검증 한계: §2의 90.2%·80%는 research 도메인 내부 eval 수치라 코딩 작업 일반화는 미검증. GitHub 이슈 증상은 일화적이다. 두 한계 모두 §4-9가 "전부 위임"이 아니라 유형별 규칙인 이유다.
