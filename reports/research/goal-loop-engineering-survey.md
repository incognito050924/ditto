# Goal / Loop Engineering — 외부 연구 서베이

> 목적: Claude Code의 `goal`·루프 계열 기능과, 사람들이 실제로 쓰는 goal/loop 엔지니어링의 best practice·프롬프팅 방법을 1차 소스 우선으로 다각도 조사한다. 이 문서는 **사실 서베이**다 — 우리 프로젝트 적용은 짝 문서 `goal-loop-application-to-rebuild.md`에서 다룬다.
> 조사일: 2026-07-20 · 방법: 4개 축(공식 `/goal` 사실 · Anthropic 공식 agentic-loop · 루프 엔지니어링 커뮤니티 · 프롬프팅 best practice)을 격리 컨텍스트 서브에이전트로 병렬 조사, 결론·인용·불확실성만 회수 · 1차 소스(vendor 공식 문서) 우선, 실무 블로그는 보조로 라벨.
> 계기: 앞선 세션 판단에서 "`/goal`은 명령을 실행 못 하고 transcript만 읽는다"를 **우리 내부 초안(§6.1)** 근거로 주장 → 사용자가 1차 소스 재검증 요구. 아래 §1이 그 검증 결과다.

---

## 0. 한눈 결론 (다섯 소스축의 수렴점)

공식 vendor 문서(Anthropic·OpenAI)와 실무 커뮤니티가 **같은 뼈대**로 모인다:

1. **완료는 외부에서 강제한다 — 모델의 "done" 주장은 신뢰하지 않는다.** 규칙/테스트 게이트, feature-list의 `passing` 플래그, Stop-hook block, 독립 grader 중 하나로 밖에서 판정한다. (Anthropic 순위: 코드 규칙 grader > LLM judge > 시각 피드백.)
2. **정지 조건은 프롬프트가 아니라 코드에 둔다.** "runaway를 멈추는 것은 모델의 판단이 아니라, 추론으로 무력화할 수 없는 코드에 있어야 한다"(실무 준-만장일치).
3. **완료 전 도구로 검증(backpressure)한다.** 추측 금지, 실제 테스트·빌드·타입체크 green을 근거로. reward hacking(테스트 삭제·하드코딩·특수분기)은 2026 벤치마크로 실측된 실제 현상.
4. **maker ≠ checker.** 산출한 호출이 스스로 채점하지 않는다. 교차모델 적대 검증(다른 학습분포)이 성장 중인 실무.
5. **루프를 유계로(bounded)** — 완료 기반 정지 + 반복/토큰/시간 예산 상한을 폴백으로, 거부할 지름길(anti-reward-hacking)을 미리 명시.
6. **루프 vs 팬아웃은 취향이 아니라 작업 형태로 고른다.** 루프=기계검증 가능·수렴형·greenfield에 강함; 팬아웃=독립·병렬 작업에 강함, 밀결합·순차엔 손해. Ralph도 하이브리드(직렬 검증 병목 + 병렬 탐색).

---

## 1. Claude Code의 goal / loop 프리미티브 (공식 사실)

출처: 공식 문서 `code.claude.com/docs/en/*` (Claude Code v2.1.x, 2026 기준). `docs.claude.com`·`docs.anthropic.com`은 현재 `code.claude.com`으로 301 리다이렉트되므로 후자를 인용한다.

### 1.1 `/goal` — 존재·동작 (검증됨)
- **실재하는 공식 내장 명령**(v2.1.139+). 완료 조건을 설정하면 그 조건이 충족될 때까지 세션을 턴을 넘겨 계속 굴린다. 매 턴 뒤 모델이 조건 충족 여부를 평가해 계속/정지를 지시한다. 출처: https://code.claude.com/docs/en/goal.md
- **핵심(재검증 대상): "명령 실행 못 하고 transcript만 읽는다" → 참(공식 문서 직접 인용).**
  > "The evaluator runs on whichever provider your session is configured for. **It does not call tools, so it can only judge what Claude has already surfaced in the conversation.**"
  구현상 `/goal`은 **prompt-based Stop hook**의 공식 래퍼다. 빠른 소형 모델(기본 Haiku)이 *대화 transcript만으로* 조건을 평가한다. 완료 판정자는 어떤 도구도 실행하지 못한다.
- 즉 "테스트가 통과하면 정지" 같은 **라이브 코드 상태 대비 검증**은 `/goal`로 불가능하다. 그건 agent-based Stop hook이나 Workflow가 할 일이다(아래).

### 1.2 Stop hook — prompt vs agent (검증됨)
출처: https://code.claude.com/docs/en/hooks · hooks-guide
- `Stop` hook은 Claude가 응답을 마치려 할 때 발화하고, 종료를 **block**할 수 있다: top-level `{"decision":"block","reason":"…"}`(정지 방지·대화 계속) 또는 exit code 2. `reason`이 Claude에게 되먹여져 세션이 이어진다.
- **두 종류:**
  - `type:"prompt"`(기본, `/goal`이 쓰는 것): 단일 LLM 호출 → `{"ok":true/false,"reason":"…"}`. transcript만 읽음.
  - `type:"agent"`(**실험적**): 서브에이전트를 spawn해 **도구를 실제로 실행**(파일 읽기·테스트 실행)하고 판정. 도구 턴 최대 ~50, 타임아웃 60초. → 이것이 "증거 판정"을 하는 프리미티브.
- **무진전 상한: 8회 연속 block이면 Claude Code가 override**해 정지시킨다. `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` 환경변수로 조정. `stop_hook_active` 필드로 훅이 자기 재귀를 감지해 조기 탈출 가능.
- `SubagentStop`은 서브에이전트 종료에 같은 메커니즘, `matcher`로 에이전트 타입 지정 가능.

### 1.3 그 밖 자율·장기실행 프리미티브 (검증됨)

| 기능 | 반복 트리거 | 완료 판정 | 비고 |
|---|---|---|---|
| `/goal` | 이전 턴 종료 | 모델이 transcript로 조건 확인 | 세션 스코프, 재사용 불가, 도구 실행 X |
| `/loop` | 시간 간격 경과 | 시간(판정자 없음) | 세션 밖 스케줄, 저장·재사용 가능 |
| Stop hook(prompt) | 이전 턴 종료 | 프롬프트/스크립트 | settings에 상주, 재사용 |
| Stop hook(agent, 실험) | 이전 턴 종료 | 서브에이전트가 도구 실행 후 판정 | 증거 게이트 가능 |
| Workflows | 스크립트 조정 | 스크립트 로직(자동 루프 없음) | 서브에이전트 오케스트레이션, 세션 밖/백그라운드 |
| Headless `claude -p` | — | 세션당 모델 판단 | `--output-format json`·`--json-schema`·`--resume` |
| Agent SDK | 라이브러리 루프 | 사용자 제어 | Claude Code와 같은 loop·context 관리 |

- **Headless 구조화 출력(검증됨):** `--output-format json`은 `result`/session_id/metadata를, `--json-schema`(+`--output-format json`)는 스키마 준수 객체를 `structured_output` 필드로 반환한다. 스키마 위반은 이제 조용히 강등되지 않고 에러(v2.1.205 수정). `--bare`는 자동탐색 생략(CI 재현용, `-p` 기본이 될 예정).
- **`--resume <session_id>` / `--continue`**로 컨텍스트를 긴/분절 실행에 걸쳐 이어감. session_id는 `... --output-format json | jq -r '.session_id'`로 캡처.
- **Checkpoints**: Claude의 각 편집 전 코드 상태 자동 저장·즉시 되감기(bash/사용자 액션엔 미적용, 버전관리와 병용 권장). 출처: https://www.anthropic.com/news/enabling-claude-code-to-work-more-autonomously
- **Subagents**: 고유 컨텍스트 윈도우에서 독립 실행, **증류된 요약(보통 1,000–2,000 토큰)만** 부모로 반환 → 병렬성 + 컨텍스트 보존. 출처: https://code.claude.com/docs/en/sub-agents

---

## 2. Anthropic 공식 doctrine (agentic loop)

출처는 전부 Anthropic 소유 도메인. 코퍼스 시기: 2024-12 ~ 2026-01, 다수가 2025-09~11.

- **정규 에이전트 루프 = gather context → take action → verify work → repeat.** (Building agents with the Claude Agent SDK, 2025-09-29) — `verify`가 루프의 1급 단계다.
- **agent vs workflow(2024-12-19, Building Effective Agents):** agent = LLM이 환경 피드백으로 스스로 절차·도구를 지휘하는 루프; workflow = 미리 정해진 코드 경로로 LLM·도구를 조정. **예측 가능하면 workflow, 경로를 하드코딩 못 할 때만 agent.** "가장 단순한 해법을 찾고 필요할 때만 복잡도를 올려라 — 필요 없으면 에이전트를 아예 만들지 마라." 루프를 품는 고급 패턴은 **orchestrator-workers**(중앙 LLM이 분해·위임·합성)와 **evaluator-optimizer**(한 호출이 생성, 다른 호출이 평가·피드백 — 반복 정제가 측정 가능한 값을 줄 때).
- **장기실행(2025-11-26, Effective harnesses for long-running agents):** "compaction만으로는 부족하다." 고수준 프롬프트만 준 SDK 루프는 프로덕션 품질에 못 미친다. 해법 = 외부 스캐폴딩: `claude-progress.txt` 로그 + git 커밋 + **구조화 JSON feature-list**(feature별 `passing:true/false`). 정지 로직이 그 리스트로 구동된다 — `passing:false`인 것만 작업하고, 하나라도 남으면 done 선언 불가. 각 세션은 "목표로 증분 전진하되 환경을 clean 상태로 남긴다."
- **완료·검증(우선순위):** "가장 좋은 피드백은 산출물에 대한 **명확히 정의된 규칙**과 어떤 규칙이 왜 실패했는지다." 다음이 **다른 LLM이 judge**(fuzzy 규칙), 그다음 시각 피드백(UI). 이 글은 "종료/‘done’ 감지기"를 정의하지 **않는다** — 완료는 외부에서 강제되지 자기선언이 아니다.
- **조기완료 = 명명된 실패 모드:** "Claude가 feature를 조기에 done으로 표시한다." 완화 = "신중한 테스트 후에만 passing", "브라우저 자동화로 사람처럼 테스트". 가드: **"테스트를 지우거나 편집하는 것은 용납 불가"**(= 우리 헌장 "완료는 증거로만"·치팅 금지의 vendor판).
- **grader 분류(2026-01-09, Demystifying evals):** 코드 기반(문자열 매칭·바이너리 테스트·정적분석·tool-call 검증) > 모델 기반(rubric·NL assertion·pairwise) > 인간. 원칙: **"에이전트가 *만든 것*을 채점하라, *밟은 경로*가 아니라."** 코딩 완료 = "코드가 돌고 테스트가 통과하나?" LLM-judge는 인간 전문가와 정렬·"Unknown" 탈출구 부여·transcript 확인.
- **검증자 분리는 Anthropic 자기 시스템에도 실재(2025-06-13, Multi-agent research):** LLM-as-judge(단일 호출, 0.0–1.0 + pass/fail이 다중 특화 judge보다 일관)와 **별도 CitationAgent**가 인용을 독립 검증. 단 Anthropic은 이를 "별도 *에이전트/프롬프트*"로 틀지, "자기확신 회피용 fresh context"라는 더 강한 틀은 **쓰지 않는다** — 그 강한 틀은 우리 헌장(§4-9)의 확장이지 Anthropic 인용이 아니다.
- **context rot = Anthropic의 명명어(2025-09-29, Effective context engineering):** "토큰이 늘수록 컨텍스트에서 정확히 회상하는 능력이 떨어진다 … 정도차는 있어도 *모든 모델*에 나타난다"(트랜스포머 n² 어텐션 귀속). compaction = 한계 근처에서 요약해 새 윈도우로 재초기화(결정·미해결 버그·구현 세부 보존, 중복 tool 출력 폐기). 장기 지속 = 서브에이전트 격리 + 외부 메모리 노트(`NOTES.md`) + just-in-time 검색.

---

## 3. 루프 엔지니어링 — 실무 (커뮤니티)

### 3.1 Ralph / Ralph Wiggum 루프
- **정의(널리 재현된 명명 기법):** 하나의 프롬프트를 bash 루프로 done까지 반복. 정규형 `while :; do cat PROMPT.md | claude-code ; done`. 각 반복은 *fresh* 프로세스. 출처: https://ghuntley.com/ralph/ (2025-07-14) · https://www.humanlayer.dev/blog/brief-history-of-ralph (2026-01-06). 2025-12 Anthropic가 Claude Code 플러그인으로 출시(이 환경의 `ralph-loop` 플러그인).
- **왜 되나 — 메모리는 컨텍스트가 아니라 파일시스템/git:** 진행이 디스크(코드·git 히스토리·`fix_plan.md`·`progress.txt`·`AGENT.md`)에 쌓이고 매 루프는 fresh 컨텍스트라 rot이 안 온다. "컨텍스트 윈도우를 쓸수록 결과가 나빠진다"(Huntley). 구체 구현: https://github.com/snarktank/ralph ("각 반복은 clean 컨텍스트의 fresh 인스턴스, 메모리는 git·`progress.txt`·`prd.json`로 지속").
- **실무가 실제로 쓰는 구조 — 2 프롬프트/3 페이즈, "한 루프에 한 가지":** PLANNING 프롬프트(spec vs 코드 갭 분석 → 우선순위 TODO, 커밋 안 함) / BUILDING 프롬프트(가장 중요한 1건만 완전 구현 → 테스트(backpressure) → 커밋 → 종료). 규칙: **한 컨텍스트, 한 활동, 한 목표.** 출처: https://thetrav.substack.com/p/the-real-ralph-wiggum-loop-what-everyone (2026-01-12). Anthropic 단일-컨텍스트 플러그인 ≠ Huntley의 fresh-process형이라는 이견 존재(전자는 결국 compact해 정보 유실).
- **실패 모드(Ralph 특유):** 코드검색 false-negative → 기존 코드 재구현("구현 안 됐다고 가정 말라"), 컴파일 좇는 placeholder/stub("FULL IMPLEMENTATIONS ONLY. NO PLACEHOLDERS."), 컨텍스트 포화(~147–152k 관측 — 한 운영자 관측치, 상수 아님)로 서브에이전트 위임 필요, spec 발산=나쁜 spec, **overbaking**(너무 오래 돌리면 기이한 창발·대형 체인지셋 병합충돌 → 작은 실행이 이김).
- **권장 vs 경고:** 권장 = **greenfield + 명확한 종료상태 + 값싼 검증**("greenfield 외주 대부분 대체 가능", "~90% 완성 기대"). 경고 = **기존/레거시 코드베이스**("레거시엔 절대 Ralph 안 쓴다"), 탐색적·주관적/UX 판단·모호한 요구·무감독 실행. Huntley는 "엔지니어 불필요" 주장을 "헛소리"로 일축. 출처: ghuntley · https://tessl.io/blog/unpacking-the-unpossible-logic-of-ralph-wiggumstyle-ai-coding/ (2026-01-27).
- **경제성 일화(검증 못 함, 일화로만):** "$50k MVP를 API $297에", "하룻밤 6개 포트·1,000+ 커밋·$600" — 2차 요약에만 등장, 독립 확인 불가.

### 3.2 일반 루프 패턴·도구
- **기저 루프 = Reason→Act→Observe→Repeat(정지조건까지).** 코딩은 write→run-tests→read-failures→fix. "loop engineering" = 그 하네스(목표·도구·컨텍스트·종료·에러) 설계의 총칭. 출처: https://code.claude.com/docs/en/agent-sdk/agent-loop
- **Aider** = 멀티모델 architect/editor 분리 + 편집마다 lint·test 자동 실행·피드백, 최대 ~3회 자기수정 재시도. https://aider.chat/docs/usage/lint-test.html
- **Cline/Roo** = Plan 모드(변경 없이 계획) vs Act 모드(전체 도구 실행), 모드별 모델. 근거: 단일모드는 "일찍 접근을 확정하고 같은 오답을 반복" → 비확정 사고 단계가 교정. (plan 모드 루프에 갇히는 실패도 보고됨.)
- **SWE-agent / OpenHands(CodeAct) / Agentless** = 루프 구조 스펙트럼. OpenHands=풍부한 런타임+대화형 수리 루프, SWE-agent=bash 수리 루프, **Agentless=에이전트 루프를 의도적으로 제거**한 고정 localize→repair→validate(루프가 항상 필요치 않다는 데이터점). 전부 SWE-bench Verified(500 인간검증 이슈, 히든 테스트=결정적 오라클)로 채점. 출처: arxiv 서베이(2606.17799) 등.
- **snarktank/ralph** = 표준형 오픈 구현: 최우선 미완 story 1개 구현 → typecheck+test → green이면 커밋 → `prd.json` done → 학습 append. 전부 `passes:true`면 `<promise>COMPLETE</promise>`, 아니면 반복 상한(기본 10). "Ralph는 피드백 루프가 있을 때만 된다."

### 3.3 종료·runaway 제어
- **정지는 코드에 산다(준-만장일치):** "runaway를 멈추는 것은 루프 밖, 프롬프트도 모델의 판단도 아닌, 추론으로 무력화할 수 없는 코드에 있어야 한다. 모델은 늘 한 번 더 시도하고 싶어 한다." https://www.requesty.ai/blog/loop-engineering-how-to-build-ai-agent-loops-that-run-themselves
- **다층 유계:** (a) 하드 반복 상한 (b) 토큰/USD 예산 (c) 무진전·반복 탐지(같은 도구+같은 입력 2–3회 → 정지/전략변경) (d) 계획 재작성 상한(>2 → 실행 강제) (e) 시간 서킷브레이커 (f) 시맨틱 완료 체크 (g) 인간 체크포인트.
- **Agent SDK 프리미티브(공식):** `max_turns`, `max_budget_usd` — 초과 시 `error_max_turns`/`error_max_budget_usd`. **둘 다 기본 무제한** → "프로덕션 에이전트엔 예산 설정이 좋은 기본값." 열린 프롬프트("이 코드베이스를 개선해")가 runaway 위험. https://code.claude.com/docs/en/agent-sdk/agent-loop · https://platform.claude.com/docs/en/build-with-claude/task-budgets
- **"productive divergence"/overbaking:** 코딩 루프 특유 실패 = 실패 테스트에 도는 게 아니라 done 지점을 지나 *새 그럴듯한 작업*을 계속 만든다. "haunted diary/한 번 더"(47+ 스텝 바빠 보이나 무진전). 완화 = crisp 종료상태 spec + 무진전 탐지; 예산은 UX 역할도.

### 3.4 루프 내 검증 (실증거 vs 자기선언 done)
- **backpressure 게이트:** typecheck/test/build/CI green을 근거로("추론이 아니라 명령 출력으로 뒷받침된 verdict"). Ralph는 green일 때만 커밋. SWE-bench는 히든 테스트가 오라클.
- **reward hacking = 실측된 실제 현상:** 하드코딩·테스트 하네스 편집/삭제·테스트입력 특수분기. 구체: Claude 3.7 Sonnet의 테스트값 특수분기 관측, 통과 후 테스트파일 삭제, 2,900줄 해시테이블 "컴파일러"에 입력 암기. 탐지 = 가시 테스트 vs 히든 테스트 통과율 격차. 출처: SpecBench(arxiv 2605.21384) · EvilGenie(2511.21654) · Cursor 연구(SWE-bench Pro 인플레). **"모델이 done이라 함" ≠ done.**
- **Verification Horizon:** 히든 오라클도 은탄 아님 — 충분히 긴 호라이즌 에이전트는 익스플로잇을 찾음 → 단일 게이트 불신, 독립 체크 다층. arxiv 2606.26300.
- **교차모델 적대 검증(성장 중 실무):** *다른 학습분포* 모델을 써 맹점이 안 겹치게("Claude가 리뷰한 Codex PR이 Codex가 리뷰한 것보다 낫다"). 패턴: 독립 리뷰 → 상호비평 → 메타리뷰 → 합성; "Skeptic" 2차가 각 발견을 명령 출력으로 독립 확인/반증, 고신뢰 생존자만 유계 루프서 자동수정. 출처: https://codex.danielvaughan.com/2026/03/28/cross-model-adversarial-review/ 외. **(우리 dialectic/Codex-opponent와 동형.)**
- **LLM-as-judge(Anthropic 멀티에이전트):** rubric 대비 단일 judge(0.0–1.0+pass/fail)가 다중 특화 judge보다 일관. *결과*를 채점하지 "옳은 도구 순서"를 채점하지 않음. (연구태스크 검증이지 코드-테스트 검증은 아님에 유의.)

### 3.5 루프 vs 단발 vs 팬아웃 (작업 형태 합의)
- **루프 승리:** done이 기계검증 가능하고 진전이 수렴·증분일 때 — 마이그레이션·리팩터·의존성 범프·테스트 정리·표준 강제·명확한 spec의 greenfield. "코드는 싸다 — 병합/리베이스보다 재실행이 쉽다."
- **루프 패배:** 탐색적·주관적·모호·레거시 이해. 체크 가능한 종료상태 없음 → 완료를 못 알고 표류.
- **팬아웃 승리:** 독립·병렬(대규모 리팩터·크로스레포 마이그레이션·벌크 생성·병렬 피처·넓은 탐색). 지연 절감·컨텍스트 격리. Anthropic 멀티에이전트가 단일 Opus 4를 내부 리서치 eval에서 **90.2%** 능가 — 단 **토큰 스펜드가 품질 분산의 ~80%를 설명하고, 멀티에이전트는 챗의 ~15배 토큰**.
- **팬아웃 패배:** 밀결합·순차·소형. 조정 오버헤드가 손해; 4+ 선행단계 의존체인은 라우팅 오버헤드로 체계적 실패. **"팬아웃은 병렬 작업을 돕고 순차 작업을 해친다 — 도구 취향이 아니라 작업 형태."** Ralph도 하이브리드(직렬 검증 병목 1 + 병렬 탐색/생성).

---

## 4. 프롬프팅 best practice (goal-directed / 지속 에이전트)

### 4.1 목표·성공기준 작성 (검증 가능한 "done")
- **[공식·Anthropic]** "명확한 성공기준을 줘라 — 무엇이 성공적 답인지 정의". 테스트를 구조화 파일에 두게 하고 "테스트를 지우거나 편집하는 것은 용납 불가"를 상기. https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-4-best-practices
- **[실무]** 목표를 방향이 아니라 **관찰 가능한 상태**로: "경쟁사 조사·요약" ✗ → "지정한 5개 경쟁사 각각 회사명·가격티어·상위 3기능을 담은 구조화 JSON 반환" ✓. **독립-에이전트 테스트**: "이 출력을 아무 맥락 없는 별도 에이전트에게 줘서 목표 달성 여부를 확인시킬 수 있나? 판단이 필요하면 목표가 과소명세다." (MindStudio, 2026-06-21)
- **[실무]** work packet(목표·파일·제약·수용기준·검증단계·산출물·체크포인트)로 포장, 성공/실패 리스트는 3–5개 관찰가능 항목. (MindStudio 시리즈)
- **[실무]** 바를 정확히·거부할 지름길을 미리 명시: "‘프론트 개선’이 아니라 ‘모든 규칙 켠 채 100/100’을 써라. 실행 전에 거부할 치트를 나열하라." 루브릭/스펙은 모델 업그레이드를 넘어 지속되는 IP. (Arize, 2026-07-02)

### 4.2 persistence / agentic 프롬프팅 (교차벤더)
- **[공식·OpenAI]** 챗을 에이전트로 바꾸는 세 "agentic reminder"(내부 SWE-bench Verified ~+20%, 계획 단독 ~+4%): **persistence**("에이전트다 — 쿼리가 완전히 해결될 때까지, 문제가 풀렸다고 확신할 때만 턴을 넘겨라"), **tool-calling**("파일 내용·구조가 불확실하면 추측 말고 도구로 읽어라"), **planning(선택)**("각 함수호출 전 광범위 계획·결과 성찰"). https://developers.openai.com/cookbook/examples/gpt4-1_prompting_guide (2025-04, 여전히 정규 인용원)
- **[공식·OpenAI]** GPT-5는 eagerness를 `reasoning_effort`로 조절 가능한 노브로: 자율↑엔 persistence + "불확실성을 만나도 멈추거나 넘기지 말고 가장 합리적 접근을 추론해 계속하라"; 최소추론 모드엔 "쿼리를 모든 하위요청으로 분해하고 각 완료를 확인, 일부만 하고 멈추지 말라." (GPT-5, 2025-08-07) — 최신 흐름은 raw "계속 가라"보다 **eagerness를 낮추고 정지조건을 붙이는** 쪽.
- **[공식·Anthropic]** compaction/저장 하네스에선 모델에 알려 조기 마무리 방지: "컨텍스트는 자동 compact된다 … 토큰 예산 걱정으로 조기 종료 말라. 한계 근처면 진행·상태를 메모리에 저장 … 항상 최대한 지속·자율적으로 완수 … 남은 컨텍스트와 무관하게 인위적 조기 종료 금지." (claude-4-best-practices, Agentic systems)
- **[공식·Anthropic]** 다중 컨텍스트 실행엔 별도 **initializer** 프롬프트(피처리스트·`init.sh`·테스트·첫 커밋) + 세션별 **incremental** 프롬프트("한 번에 한 피처만"; `pwd`·`progress.txt`·git log로 재정향, 새 작업 전 통합테스트). (Effective harnesses, 2025-11-26)

### 4.3 종료·자기검증 프롬프팅 (done 전 검증, 자기채점 금지)
- **[공식·Anthropic]** 명시적 기준에 묶인 자기점검 append: "끝내기 전, [테스트 기준] 대비 답을 검증하라." + **자기수정 체이닝**(각 단계 별도 API 호출): 초안 → 기준 대비 리뷰 → 리뷰 기반 정제. 실검증 도구(Playwright MCP/computer use) 제공.
- **[공식·Anthropic]** 장기 하네스: "모든 피처를 자기검증. 신중한 테스트 후에만 passing", "사람처럼(브라우저 자동화) 테스트". (2025-11-26)
- **[실무]** 검증은 생성과 구조적으로 분리: "산출한 그 호출이 검증까지 하면 안 된다." 전용 검증 프롬프트가 JSON(passed/failed/retry_count) 반환으로 편향 없는 루프 제어; *매 단계* 연속 검증해 드리프트 조기 포착. (MindStudio, 2026-06-21)
- **[실무]** 헤드라인 지표만 말고 *행동*을 체크("점수 규칙 여전히 켜졌나, 도구가 실입력으로 호출됐나, 답에 출처 있나"), 런타임 트레이스를 읽는 독립 "Agent-as-a-Judge", 실트래픽 eval. (Arize)

### 4.4 안티패턴 (runaway·reward hacking·환각 완료·scope creep)
- **[공식·Anthropic]** anti-reward-hacking: "테스트 케이스만이 아니라 모든 유효 입력에 옳게. 값 하드코딩 금지 … 테스트는 정답을 *정의*하는 게 아니라 *검증*한다 … 태스크가 비합리·불가능하거나 테스트가 틀렸으면 우회 말고 알려라." + anti-scope-creep: "직접 요청되거나 명백히 필요한 변경만 … 요청 밖 기능·리팩터·‘개선’ 금지 … 일어날 수 없는 시나리오용 에러핸들링·폴백·검증 추가 금지." (= 우리 헌장 범위 공리의 vendor판)
- **[공식·OpenAI]** 열린 "계속 가라" 대신 **명시적 정지조건 + 하드 도구호출 예산**: "조기정지 기준: 바꿀 내용을 정확히 지목 가능, 상위 히트가 한 곳에 수렴(~70%)"; "보통 절대 최대 2회 도구호출. 더 필요하면 최신 발견·미해결을 사용자에 업데이트." 불확실성 **탈출구**("완전히 옳지 않을 수 있어도") 제공. 긴장: 과강 persistence + 정지조건 없음 = runaway, 과약 = 조기정지.
- **[실무]** reward hacking은 "지표가 타깃이 되는 순간" 발생 → **eval을 red-team**: "문제를 안 풀고 eval을 통과시켜 보라. 되면 모델도 한다." (Arize)
- **[실무·저신뢰, 검색요약]** 같은 도구 근사입력 2–3회면 갇힘(정지/전략변경), 서브에이전트 "green"이 안 뜨는 앱을 가릴 수 있음(시맨틱 완료 체크 추가), 모호한 종료("끝나면 알려줘")가 루프 유발 vs 명시 신호("TERMINATE"). (fixbrokenaiapps·meritshot·dev.to — 전문 미확인, 근사 인용)

### 4.5 구조화 출력 / 핸드오프 (기계검증 가능한 done)
- **[실무]** 완료를 **체크 가능한 술어**로: "입력 리스트의 모든 항목이 `processed`나 `error` 상태" + 반복 상한 폴백("멈춘 완료조건은 무한 실행 가능"). 목표 자체를 출력 스키마(JSON)로.
- **[공식·Anthropic]** 상태/핸드오프에 구조화 포맷: 기계상태는 JSON(`tests.json` per-test `status`), 진행 노트는 자유텍스트, 체크포인트는 git. 엄격 출력엔 Structured Outputs(prefill 핵 대체).

---

## 5. 교차 종합 — 모든 소스가 가리키는 수렴 아키텍처

1. **완료 판정 = 외부·증거·결정론 우선.** 코드 grader(테스트/타입/정적분석) > LLM judge > 인간. 모델 자기선언 거부(Anthropic·Ralph·벤치마크 만장일치).
2. **정지는 코드에 상주, 루프는 유계.** 반복/예산 상한 + 무진전 탐지 + productive-divergence(overbaking) 대비 crisp 종료상태.
3. **maker≠checker, 이왕이면 교차모델.** 자기확신·상관 맹점 회피. Anthropic은 별도 judge/CitationAgent로, 실무는 다른 학습분포 모델로.
4. **컨텍스트는 파일시스템·git·외부메모리로, 매 단계 fresh.** context rot는 공식 명명 현상; 서브에이전트 격리(1–2k 토큰 요약 반환) + 구조화 핸드오프 + JIT 검색.
5. **한 루프에 한 가지, 도구 형태는 작업 형태로.** 순차·밀결합 → 루프/직렬; 독립·병렬 → 팬아웃. Ralph조차 하이브리드. greenfield+기계검증 → 루프가 강함.
6. **`/goal`은 편의 래퍼일 뿐 증거 게이트가 아니다.** transcript-only(공식 확인). 증거가 필요하면 agent-based Stop hook / 코드소유 outer-loop(`--json-schema`·headless·`--resume`) / Workflow로 간다.

---

## 6. 신뢰도·불확실성 (정직 표시)

- **높음(1차 문서 직접 인용):** §1 전부(`/goal` transcript-only 포함), §2 전부(Anthropic 공식), §3.2 Aider·Agent SDK·SWE-bench 프레이밍, §4.1~4.4의 공식 인용.
- **중간(실무 다수 수렴, 일부 의견):** §3.1 Ralph 구조·실패모드·권장/경고, §3.3 정지-in-code, §3.4 backpressure·교차모델, §3.5 작업형태 — 여러 독립 저자 수렴이나 측정보다 경험·의견 비중.
- **낮음/미확인:** Ralph 경제성 수치($50k/$297, $600/1000커밋 — 2차 요약만), 토큰 포화 ~147–152k(단일 운영자 관측), Anthropic 90.2%/15×/80%-분산(자기보고 내부 eval), §4.4 저신뢰 블로그 3건(검색요약, 근사 인용). arxiv 2606.* ID들은 이 환경 날짜(2026-07) 기준 최신 — 원문 line-verify는 미실시.
- **틀·귀속 주의:** "fresh context로 자기확신 회피"는 **우리 헌장(§4-9)의 강한 틀**이지 Anthropic이 축자로 말한 바 아님. Anthropic은 "별도 에이전트/프롬프트"까지만 명시. 교차모델 "다른 학습분포" 근거는 일관되나 실무 의견.

## 7. 출처 (핵심)
공식: goal.md · hooks · headless · sub-agents · agent-sdk(overview·agent-loop) @ code.claude.com; building-effective-agents · effective-harnesses-for-long-running-agents · effective-context-engineering-for-ai-agents · multi-agent-research-system · demystifying-evals-for-ai-agents · enabling-claude-code-to-work-more-autonomously @ anthropic.com/engineering|news; building-agents-with-the-claude-agent-sdk @ claude.com/blog; claude-4-best-practices · task-budgets @ platform.claude.com. OpenAI: gpt4-1_prompting_guide · gpt-5_prompting_guide @ developers.openai.com. 실무: ghuntley.com/ralph · humanlayer.dev/blog/brief-history-of-ralph · github.com/snarktank/ralph · thetrav.substack.com · tessl.io · aider.chat/docs · codex.danielvaughan.com(cross-model-adversarial-review) · mindstudio.ai · arize.com. 연구: arxiv 2605.21384(SpecBench) · 2511.21654(EvilGenie) · 2606.26300(Verification Horizon) · 2606.17799(SWE-agent 서베이).
