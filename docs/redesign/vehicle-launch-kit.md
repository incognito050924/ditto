# Vehicle 저작 — 격리 세션 Launch Kit

이 파일은 **오염 없는 pure-CC 격리 세션**이 read해서 vehicle 저작을 착수하기 위한 seed다.
이 세션에는 ditto 플러그인·글로벌 CLAUDE.md·ditto git 훅이 로드되지 않는다(의도된 격리). ditto CLI·handoff는 여기서 안 돈다. 파일 read는 자유다(이 kit·draft·rebuild 계약을 절대경로로 읽는다).

---

## 0. 격리 실행 런북 (착수 절차)

```bash
# 1) 빈 config 홈 (user-스코프 전부 격리: 플러그인·훅·글로벌 CLAUDE.md·MCP·memory)
mkdir -p /Users/ecoletree/dev/project/ditto-vehicle-cfg

# 2) repo-밖 build 워크스페이스 (git init → .githooks 없음)
mkdir -p /Users/ecoletree/dev/project/ditto-vehicle
cd /Users/ecoletree/dev/project/ditto-vehicle
git init

# 3) 격리 세션 진입 (반드시 두 조건 동시: 빈 config-dir + repo-밖 cwd)
CLAUDE_CONFIG_DIR=/Users/ecoletree/dev/project/ditto-vehicle-cfg claude
```

격리 검증(이 세션 안에서 실행해 확인 — ac-7 근거):
- SessionStart 배너에 "ditto dogfood 모드" 문구가 **없어야** 한다.
- 매 턴 prime-directive 주입이 **없어야** 한다.
- `git config --get core.hooksPath` → 빈 출력(=.githooks 없음).

주의: macOS라 managed 정책 부재 확인됨(2026-07-20) → CLAUDE_CONFIG_DIR로 완전 격리. 재로그인 없음(Keychain).

세션 진입 후 첫 지시(seed): "이 파일을 read하고 §8 착수 순서대로 vehicle을 저작하라: /Users/ecoletree/dev/project/ditto/docs/redesign/vehicle-launch-kit.md" (goal 프롬프트 원안은 같은 폴더 vehicle-goal-prompt.md)

---

## 1. 원래 의도 (변경 금지 — §4-12 보존 운반)

재설계 ditto(docs/redesign)를 **zero-start**로 새로 짓기 위한 **빌드 vehicle**을 엔지니어링한다.
- 빌드 방식 = 순수 Claude Code `/goal` 구동 + 메인 세션을 거의 **무상태 디스패처**로(임계 컨텍스트에서 모든 비단순 유닛을 fresh 서브에이전트 위임, 메인은 계약+디스크상태만 보유) → 대규모에서 컨텍스트 폭발 방지.
- 완료가 **자기채점이 아니게** 강제: (a) command형 Stop hook가 실제 테스트 실행, 실패 시 exit-2로 정지 차단, (b) Codex 교차검증(maker≠checker), 부재 시 run-level unverified fail-closed.
- 스케일 목표: 한 자율 실행("빅뱅")으로 정초를 뽑되, 빅뱅=한 자율 실행이지 한 누적 컨텍스트가 아님 — 정초는 큐 드레인으로 자연히 incremental.
- 금지: 의도를 "drive-loop 기능 만들기"로 축소하지 말 것(미합의 용어).

## 2. 확정 결정 (deep-interview에서 봉인)

1. **vehicle = A**: `/goal` + 디스패처화. `/goal`의 harness continuation은 유지하되 메인 세션을 무상태 디스패처로.
2. **증거게이트** = command형 Stop hook가 실제 테스트 실행, 실패 시 exit-2로 정지 차단(=완료 자가판정 차단).
3. **외부 완료권위** = Codex 교차검증, 처분/종료 시점, 부재 시 run-level unverified fail-closed.
4. **유계+escape**, 목표 봉인(얼어붙은 goal/AC) = goal 프롬프트에 인코딩.
5. **단일-출처 디스크 상태 모델** 매 라운드 재독(compaction 손실 상쇄).

## 3. /goal 공식 사실 (재확인 완료 2026-07-20)

- `/goal`(v2.1.139+) 기본형 = **prompt형 Stop hook**, transcript만 읽고 도구실행 불가 → 그 자체론 증거게이트 못 됨.
- 증거게이트 가능한 것: **command형 Stop hook**(셸 실행·exit-2로 차단) 또는 agent형(서브에이전트 50turn·실험적).
- block cap 기본 8 (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` env로만 상향).
- `/goal`은 단일 세션 컨텍스트 누적·per-iteration fresh reset 없음 → **디스패처 위임 + 디스크상태 재독**으로 상쇄 필수.
- Codex 배선 패턴: 코어는 정책해석+provenance만, 실제 Codex CLI 호출은 skill이 out-of-band로 구동(코어 밖). vehicle의 Codex 교차검증도 `codex` CLI 직접 호출(플러그인 아님)이라 격리해도 그대로 씀.

## 4. 빌드 대상 (작다) — vehicle이 지어나갈 "재설계 정초"

12 아키텍처 불변식(백서 §7)을 스키마/게이트로 + 얇은 drive-loop + 네이티브 위임 seam + §5 완전성 기계(disposition-완전성·상태 legibility·park·AC 2-facet·re-lock 라우팅). 기존 39개 명령은 스코프 아님(비-self 감사로 하나씩 재입장).

**12 불변식** (출처: `/Users/ecoletree/dev/project/ditto/docs/redesign/ditto-rebuild-draft.md` §3.3, line 97~):
1. 완료 = 모든 AC가 evidence와 함께 pass. 2. 무축소를 코드로(하나의 의도=하나의 단위). 3. fail-closed 게이트. 4. fresh context 검증. 5. 증거는 참조로. 6. 우아한 강등. 7. 호스트/프로바이더 절연(seam). 8. tier 격리. 9. 스키마가 SoT. 10. push=user-gated·commit=agent-owned. 11. 메타-도구는 사용자 환경에 맞춤. 12. 언어-중립 어휘.

**이미 지어진 정초 골격 (잠긴 계약, read해서 이어짓기)**:
- `/Users/ecoletree/dev/project/ditto/rebuild/schemas/` — verdict·evidence·gate-result(`decideGate` fail-closed)·queue-item(3exit)·completion-contract(`deriveFinalVerdict` over-claim 방지).
- `/Users/ecoletree/dev/project/ditto/rebuild/seam/` — HostAdapter 4메서드·BoundaryEnvelope 큐오라클·FakeHost·`isQueueDrained`.
- 상태: src/에서 미import되는 독립 섬, **51 테스트 통과**(2026-07-20 재확인). drive-loop 본체·라이브 어댑터·§5 기계는 **부재 = 빌드 대상**.
- "정초 첫 슬라이스"(ac-6) 권장 = fail-closed 불변식 게이트 1개(#3, 이미 `decideGate`에 부분 존재) + 그것을 통과시키는 drive-loop 스텝.

## 5. Vehicle 저작 구성물 (여기서 만들 것)

- goal 프롬프트 (빌드타깃 명세 임베드 + 목표봉인 + 디스패처 규율 + 유계/escape)
- `.claude/settings.json` (command Stop hook + block cap 상향)
- hook 스크립트 (테스트러너 + Codex 교차검증)
- 서브에이전트 정의 (격리 워커롤)
- 단일출처 디스크 상태 모델 (§5.5)
- 런북

## 6. 완료 계약 (wi_260720v4m 7 criteria — 이게 done의 기준)

- **ac-1**: vehicle 번들 self-contained — grep으로 ditto import·CLI 호출 0건, ditto 없는 깨끗한 복사에서 진입점 실행 exit 0.
- **ac-2**: command형 Stop hook 실제 테스트 실행, red→exit-2 차단·green→통과 두 경로 실행 로그로 실증.
- **ac-3**: Codex 교차검증 처분/종료 시점 발화, 부재 시 unverified fail-closed 두 경로 실증.
- **ac-4**: goal 프롬프트에 디스패처-위임·목표봉인·유계+escape 세 앵커 존재 정적 grep 통과.
- **ac-5**: 프로세스1 디스크 상태 기록 후 종료 → 프로세스2가 상태만으로 동일 미처분 큐 재개(항목 집합 일치) 재시작 테스트 통과.
- **ac-6**: 무-ditto 깨끗한 워킹트리에서 vehicle 실행 → 정초 첫 슬라이스(fail-closed 게이트1 + drive-loop 스텝) 테스트 green + Codex 발화까지 실제 산출.
- **ac-7**: 격리 CLAUDE_CONFIG_DIR + repo-밖 git-init에서 스모크 시 캡처 로그에 ditto SessionStart 배너·prime-directive 주입 0건(grep 확인).

## 7. 경계 (지킬 것)

- 이 vehicle 저작에 **ditto autopilot 쓰지 말 것**(자기참조 + 우리가 대체하는 그 엔진). work item 안에서 직접 저작 + 증거게이트로 검증.
- 원래 요청 그대로: 승인 없이 범위 확대·축소·분할 금지.
- 저작 go는 이미 받음(이 격리 세션이 그 실행 환경).

## 8. 착수 순서

`rebuild/schemas`·`rebuild/seam`(잠긴 계약) + draft §5-7(아키텍처)·§6.1/6.3(Stop hook vs CLI-resume)·§10(로드맵) read → goal 프롬프트(`vehicle-goal-prompt.md`)를 그대로 심고 → Stop hook·settings·서브에이전트·상태모델 저작 → 스모크(ac-6/ac-7).

## 9. 설계 근거·출처·잔여 위험 (사람용 — goal 프롬프트 런타임 파일에서 이관)

`vehicle-goal-prompt.md`는 dialectic 리뷰(Producer=Claude / Opponent=Codex / Synthesizer) 후 lean·operative로 재작성됐다(판정: revise → 13 편집 적용). 런타임을 오염시키는 근거·출처·위험 메타는 여기로 옮긴다.

**goal 프롬프트 선택의 근거·출처**
- 두 산출물 분리 / transcript-only 평가 / ≤4000자 / turn-bound: 공식 goal.md.
- command Stop hook exit-2 = 진짜 증거 게이트(Haiku 단독은 self-scoring): hooks.md·hooks-guide.md.
- 디스크 상태 + 매 라운드 재독 + 명시 완료 토큰 + 반복 상한: Ralph 루프(snarktank/ralph) + Anthropic effective-context-engineering. 단 `/goal`은 fresh 리셋이 없어 디스패처 위임으로 상쇄.
- 무상태 디스패처 / fresh 서브에이전트 위임 / 생성≠검증: building-effective-agents + arXiv 2407.04549(iterative self-refinement에서 evaluator==generator면 reward hacking; shared model 악화). *"별도 컨텍스트가 완전 완화"는 논문 명시 아닌 추론.*
- 양성 불동점 드레인 + 음성 backstop(cap·budget·no-progress·divergence): building-effective-agents + cloudzy/bswen(no-progress hash·phase-aware) + draft §5.10.
- 큐/게이트 어휘는 실제 코드 앵커: `rebuild/schemas/queue-item.ts`(kind 3·exit 3), `gate-result.ts` `decideGate`(fail-closed).

**잔여 위험 (미검증 — ac-6 스모크가 유일한 오라클)**
- **A안 근본 리스크**: `/goal`은 컨텍스트를 리셋 안 함 → 디스패처+디스크상태 상쇄가 대규모에서 버티는지 미확정. draft §6.3은 hard 종료 소유를 CLI `--resume` outer-loop(진짜 fresh context)로 두는 대안을 선호했다 — A는 사용자 확정이고 §2·§3 규율이 그 대가다(재-오픈 아님, 문서화된 잔여). Codex Opponent도 같은 대안을 제기 → 잔여로 접수.
- **디스패처 트리거 수치**(파일 2개 초과 등)는 미측정 잠정값 — 스모크로 보정.
- **Codex maker≠checker 독립성**은 `codex` CLI 별도 프로세스 호출을 이 초안이 명세만 함 — ac-3에서 실증.
- 후속 원문 미검증 논문: arXiv 2607.00038(loop engineering)·2605.01471(자율 test-repair 한계) — 제목만 확인, 정련 시 직접 읽기 권장.
