# Goal / Loop 엔지니어링을 DITTO 재구축 빌드-수단에 적용

> 목적: 짝 문서 `goal-loop-engineering-survey.md`(외부 사실 서베이)의 결론을, "지금 하려는 재구축을 *어떤 수단으로 착수·구동할 것인가*" 결정에 적용한다.
> 작성일: 2026-07-20 · 이 문서는 **적용·권고**다. 사실 근거는 서베이(이하 [S§n])와 우리 정초 초안 `docs/redesign/ditto-rebuild-draft.md`(이하 [초안§n]), 앞선 dialectic 원장(`scratchpad/dialectic-ultracode-go-nogo.md`)에 있다.
> 상태: 착수는 **사용자 허가 대기**(코드 변경 lazy 게이트). 이 문서는 그 결정을 위한 근거다.

---

## 0. 한 문단 요약

외부 문헌은 우리 정초 설계를 **독립적으로 재확인**한다. 우리 작업은 loop-fit이다(greenfield + 기계검증 가능). 다만 정답은 순정 `/goal`도, 순정 ultracode 팬아웃도 아니라 **Ralph형 하이브리드** — *코드가 소유한 유계 루프* + *실테스트 backpressure 게이트* + *교차모델(Codex) 검증* + *독립 슬라이스만 팬아웃*이다. 이건 초안 §5.10/§6/§7이 이미 설계한 그 구조이고, dialectic이 낸 수정사항(#7 증거바인딩·#1 교차모델·#4 유계·#8 drained≠done)이 Claude-편향이 아니라 **필드 합의**임을 외부 소스가 증명한다. 사용자의 "빅뱅·집중 소모" 욕구도 greenfield 루프 문헌과 **정렬**된다("한 번의 집중 실행으로 ~90%"). 핵심 재귀: 우리는 *이 루프 엔진 자체를 짓는 중*이라, 빌드에는 아직 엔진을 못 쓴다 → 그 규율을 **손으로** 적용해(내가 테스트 실행=backpressure, Codex=교차모델, 유계 페이즈) 자동화 버전을 만든다.

---

## 1. 지금 상황 (근거 고정)

- **목표:** DITTO 엔진을 zero-start 재구축. 철학·불변식 보존, 구현 기층 교체. `rebuild/`는 옛 `src/`와 격리된 greenfield. 계약은 잠김(rebuild/schemas 5 zod + rebuild/seam HostAdapter·boundaryEnvelope·AgentText·FakeHost·isQueueDrained). fresh 게이트 GREEN 확인: `bun test rebuild/` 51 pass exit 0, `tsc -p rebuild/seam` exit 0.
- **다음 단위:** 얇은 게이트 코어 + drive-loop(§5.10 Layer 2) + 실 HostAdapter 네이티브 배선(Stop hook·CLI --resume outer-loop·subagent 팬아웃·--json-schema).
- **사용자 결정·바:** 빅뱅으로 초기 자원 집중 소모 후 지속 관리. 의도 충실 + "완벽" 구현 + **유지보수 편한 형태**.
- **수단 논쟁 경과:** dialectic은 `revise`(순정 ultracode 한방 기각, 얇은 코어 설계는 건전) → 사용자 "빅뱅·무조건 ultracode" → 사용자 재고 "이 작업엔 goal이 더 적합?" → 그 주장의 1차 소스 재검증(이 조사).

---

## 2. 연구를 우리 결정에 대입

### 2.1 우리 작업은 loop-fit인가? — 예 (사용자 직감 지지)
[S§3.5·3.1]: 루프는 **greenfield + 기계검증 가능 + 수렴형**에 강하고, 레거시·모호·주관엔 약하다. 우리는 셋 다 만족 — `rebuild/`는 greenfield, `bun test rebuild/`가 결정적 오라클, 진전은 증분·수렴. → **loop-fit.** 이는 "지루한 순차 TDD 의례"보다 goal/loop 형태가 맞다는 사용자 직감을 뒷받침한다.
**단서:** 엔진 *코어*는 상호의존적이다(스키마→게이트→drive-loop→seam 배선이 서로 참조). [S§3.5] 팬아웃은 밀결합·순차·소형에서 손해다. → 코어 구성은 **순정 팬아웃 부적합**, Ralph 하이브리드(직렬 검증 병목 + 병렬 탐색)가 맞다.

### 2.2 어떤 프리미티브인가?
- **`/goal` 단독 = 부적합(1차 소스 확정).** [S§1.1] `/goal`의 판정자는 transcript만 읽고 도구를 실행 못 한다. "테스트 통과 시 정지"를 못 한다. 빌드를 순정 `/goal`로 몰면 재구축이 죽이려는 병(모델 자기선언 완료)을 도그푸딩하는 꼴. → 앞선 내 주장은 맞았고, 이제 우리 내부 초안이 아니라 **공식 문서**로 접지됨.
- **맞는 프리미티브 = 코드 소유 유계 루프 + 증거 게이트.** [S§2·3.3·3.4] 완료는 외부·결정론 grader(테스트 green)로, 정지는 코드에(반복/예산 상한), 검증은 backpressure로. Claude Code 표면: **agent-based Stop hook**(도구 실행 가능, [S§1.2]) 또는 **headless `--resume` outer-loop + `--json-schema` 경계**([S§1.3]). → 이는 초안 §6.1이 "왜 /goal이 아니라 agent Stop hook인가"로 이미 내린 결론이고, 이제 외부 문헌·Anthropic 공식이 같은 결론(코드 grader > judge, 완료 외부강제)으로 뒷받침한다.

### 2.3 부트스트랩 재귀 (가장 중요한 실무 함의)
우리는 *이 루프 엔진을 짓는 중*이다. 그래서 빌드에는 아직 그 엔진(유계 루프·증거 게이트)을 못 쓴다 — dialectic obj #4가 짚은 부트스트랩 갭. 해법: **엔진이 자동화할 규율을 이번 빌드엔 손으로 적용**한다.
- backpressure = 내가 매 증분마다 `bun test rebuild/`·`tsc` 실행, exit code를 근거로(transcript 주장 아님).
- 교차모델 = 경계에서 Codex 적대 검증(이미 이 세션 dialectic에서 실증).
- 유계 = feature-list(닫힌 집합)로 페이즈, 반복/예산 상한 폴백.
- 메모리 = git 커밋 + 진행 파일([S§2·3.1]의 filesystem-as-memory).
즉 "손으로 도는 Ralph"로 "자동으로 도는 Ralph(=우리 drive-loop)"를 짓는다. 빌드가 곧 설계의 첫 도그푸딩.

### 2.4 dialectic 수정사항 = 필드 합의 (Claude-편향 아님)
| dialectic 수정 | 외부 재확인 |
|---|---|
| #7 완료를 `evidence.length>0` 아닌 실행 exit code/해시로 | [S§2] Anthropic "코드가 돌고 테스트 통과하나"·"테스트 삭제 금지"; [S§3.4] backpressure·reward hacking 실측 |
| #1 교차모델(다른 provider) 검증 | [S§3.4] 다른 학습분포 적대 검증("Claude가 본 Codex PR > Codex가 본 것") |
| #4 유계·정지 in-code | [S§3.3] max_turns/budget·"정지는 추론으로 무력화 못 할 코드에" |
| #8 drained≠done, escape→unverified | [S§2] 완료 외부강제·feature-list `passing`·"grade the output not the path" |
→ dialectic이 Claude 자기채점이었을 위험을 사용자가 우려했으나, 교차모델 Codex Opponent였고 결론이 **독립 필드 문헌과 일치**한다.

### 2.5 사용자의 "빅뱅·ultracode"와 문헌의 화해
- **"빅뱅·집중 소모 upfront" ↔ greenfield 루프 문헌 정렬.** [S§3.1] Ralph는 greenfield에서 "한 집중 실행으로 ~90%"를 노린다. 빅뱅 욕구는 greenfield에선 문헌 지지. 단 [S§3.1] overbaking(너무 오래·큰 체인지셋 → 창발·병합충돌) 경고 → 빅뱅도 커밋 잦게·증분 검증.
- **"ultracode(팬아웃)"은 전면 폐기가 아니라 슬라이스 한정.** [S§3.5] 팬아웃은 *독립* 작업에 강하고 밀결합 코어엔 손해. 우리 빌드엔 두 형태가 공존: 상호의존 코어(루프/직렬) + 병렬 가능한 슬라이스(교차모델 검증 셀·독립 모듈 스캐폴드·조사). → **하이브리드**: 코어는 코드소유 루프, 독립 슬라이스만 유계 팬아웃. 이게 Ralph 자신의 패턴(직렬 검증 병목 1 + 병렬 탐색)이자 사용자 속도 욕구와 규율을 둘 다 만족.

---

## 3. 권고 — 우리 빌드 수단 ("손으로 도는 Ralph 하이브리드")

원 의도(순효능·증거완료·context rot·monoculture 탈출)와 사용자 바(빅뱅·완벽·유지보수)를 [S] 규율로 실현하는 구체 형태:

1. **PLANNING 패스(커밋 없음).** §7 불변식 + drive-loop + 실증거 바인딩 + 네이티브 배선을, 현재 `rebuild/` 상태 대비 갭 분석 → **feature-list**(per-feature `passing:false`, [S§2·3.1]). 이 닫힌 집합이 **capture window** — "끝없는 후속"을 불동점으로 묶는다([초안§5.10]). = intent-lock + AC.
2. **BUILDING 루프(한 번에 한 feature).** [S§3.1 "one thing per loop"] 가장 중요한 미완 1건을 *완전* 구현(placeholder 금지) → **backpressure**: `bun test rebuild/`·`tsc -p rebuild/seam` 실행, green일 때만 `passing:true`·커밋([S§3.4]). 상호의존 코어라 한 컨텍스트로 코히어런트하게(§4-9 맥락 누수 방지).
3. **경계 교차모델 검증.** 각 완료 슬라이스를 **Codex** 적대 검증(AC·§7 불변식·#7/#8 대비). 다수 반증이면 kill([S§3.4]·obj #1). maker(Claude)≠checker(Codex).
4. **유계·정지 in-code.** feature-list 소진이 1차 종료; 반복/시간/토큰 예산이 폴백([S§3.3]). productive-divergence는 새 발견을 current/new-scope로 분류해 current만 완료 저지([초안§5.10]).
5. **유지보수성·완전성 비평(fresh).** "코어 아직 얇은가?([초안§11 반패턴]) 오케스트레이션 새는가? `src/*` 누출(#9)? seam 명료·불변식 문서화?([S§2] 단순 우선)". 발견 → 다음 라운드.
6. **독립 슬라이스만 팬아웃.** 교차모델 검증 셀·독립 모듈 스캐폴드·조사·문서는 병렬([S§3.5]). 코어 구성은 팬아웃 안 함.
7. **메모리·체크포인트.** git 커밋 + 진행 파일. Claude Code Checkpoints는 편집 되감기 보조([S§1.3]).
8. **앵커.** 코드 변경이므로 **work item**으로 intent-lock + AC + 증거완료. 구동은 위 손-Ralph, 완료는 실테스트 green + Codex 검증으로 닫는다.

### 3.1 `/goal`을 쓸 자리 (선택)
`/goal`의 transcript-only 판정자는 우리 **완료 게이트가 될 수 없다**([S§1.1]). 다만 세션 *지속*(턴 넘김) 편의로는 쓸 수 있다 — 단 완료 판정은 내가 돌린 테스트가 하고 `/goal`은 "테스트 green 로그가 transcript에 있나"만 본다. 더 견고한 자동화를 원하면 **agent-based Stop hook**(도구 실행)이 정답이나, 이는 우리가 *짓는 대상*의 일부라 부트스트랩상 이번 빌드엔 손-backpressure로 대체([§2.3]).

### 3.1b 공식 `ralph-loop` 플러그인 — 실제 동작과 한계 (소스 검증)
이 환경에 **공식 `ralph-loop` v1.0.0**(claude-plugins-official)이 설치돼 있다. 소스(`hooks/stop-hook.sh`) 직접 확인 결과:
- **메커니즘:** `/ralph-loop "<prompt>" --max-iterations N --completion-promise "TEXT"` → 상태파일 `.claude/ralph-loop.local.md`. **Stop hook**이 종료를 가로채 매 반복 같은 프롬프트를 되먹인다. **같은 세션 안**에서 돈다(외부 bash 루프 아님).
- **주는 것(견고):** ① `--max-iterations` = **코드 강제 반복 상한**(stop-hook.sh L61, stop-in-code [S§3.3] 충족). ② persistence(조기 종료 block). ③ session_id 격리(다른 세션 안 막음). ④ 파일/git 메모리.
- **★ 안 주는 것(치명적, 우리 맥락):** **완료 게이트가 증거가 아니라 모델 자기선언이다.** 훅은 테스트를 돌리지 않는다 — transcript의 마지막 assistant 텍스트에서 `<promise>TEXT</promise>`를 **문자열 매칭**할 뿐(prompt-based, agent-based 아님). 즉 완료 = *모델이 매직 워드를 타이핑*. 유일한 가드는 프롬프트 문구("TRUE일 때만 출력, 도망치려 거짓 promise 금지") — **honor-system이지 코드 강제 아님**. 이건 `/goal` transcript-only와 **같은 자기채점 표면**(§5.2 덫·obj #7), reward hacking 실측([S§3.4])이 정확히 노리는 자리다.
- **또 안 주는 것:** fresh context(같은 세션 → 컨텍스트 누적 → rot, [S§3.1 Johnson 비판]과 정합; 우리 §5.12 context-rot 관리 미해결, compaction 의존) · 교차모델(단일 모델, obj #1 미해결).

**결론(적용):** 플러그인을 **persistence + 반복상한 backbone**으로는 쓸 수 있다(그 부분은 코드 강제라 견고). 단 **`<promise>`를 완료 게이트로 신뢰하면 안 된다** — 그건 우리가 죽이려는 자기채점이다. 대신 **`<promise>COMPLETE` 방출을 §3.3의 다층 증거에 묶는다**(test-green은 그중 한 층일 뿐). 훅의 honor-system이 *내 backpressure 규율로* 강제된다(코드-강제는 아직 우리가 짓는 agent-Stop-hook의 몫 — 부트스트랩 [§2.3]). context 누적은 one-thing-per-loop + 잦은 커밋 + compaction으로 완화. → §3의 "손-Ralph"에서 **persistence·반복상한 절반을 이 플러그인이 자동화**하고, **증거 게이트·교차모델 절반은 여전히 내 규율**로 남는다.

### 3.2 유지보수성 (사용자 바) — 문헌 반영
[S§2·5]: 얇은 코어 유지("단순 우선, 필요 없으면 에이전트 안 만든다"), 외부메모리·구조화 핸드오프, one-thing-per-loop로 리뷰 가능한 증분, feature-list `passing`로 상태 가시화, 스키마=SoT. → 유지보수는 "빅뱅 후 큰 덩어리"가 아니라 *증분·문서화·얇음*으로 확보. [초안§11] 반패턴(코어 비대화=3시간 엔진 부활) 가드를 §5 비평에 상설.

### 3.3 완료 게이트 = test-green이 아니라 다층 증거 (green은 필요조건일 뿐)
**`bun test rebuild/` exit 0은 "모든 테스트가 통과"이지 "잘 구현됐다"가 아니다.** green은 필요하되 충분하지 않고, 게이밍 가능하며, 설계·의도엔 무언이다([초안§5.11 완료≠건강]·[S§3.4 "no single reward signal is hack-proof"→다층 독립 체크]). green이 놓치는 것과 각 층의 실제 증거:

1. **테스트 적정성** — green은 테스트가 *검증하는 것*만큼만 안다. 안 짠 동작엔 무언. 테스트가 구현이 아니라 **AC에서 나왔나**(red-first), 약화/삭제 안 됐나(git diff on tests). [S§4.1·4.4 Anthropic "테스트 삭제·편집 용납 불가"]
2. **게이밍 없음** — 하드코딩·특수분기·stub·테스트 약화로도 통과([S§3.4] 2026 벤치마크 실측). → Codex가 *결과가 아니라 **diff**를 읽어* 확인(테스트가 impl에 맞춰 co-written 아닌지 포함).
3. **per-AC 실증거(obj #7)** — "테스트 하나 통과"가 아니라 각 AC가 자기 증거(실행 exit code/동작 데모)로 닫힘. 스키마-유효 sidecar ≠ 라이브 증거.
4. **FakeHost ≠ live** — rebuild/ 유닛은 **FakeHost 대상**(결정적, live 모델 없음). 실 HostAdapter 네이티브 배선(Stop hook·CLI resume·--json-schema)은 **별도 라이브 검증** 필요. green FakeHost ≠ 실제 Claude Code 경로에서 동작.
5. **설계 건강·유지보수([초안§5.11 완료≠건강])** — all-green도 나쁜 설계 가능(추상화 수준·개념 무결성·rot은 부분적으로 oracle 없음). → 유지보수 비평(§3-5) + 인간 판단(사용자 "유지보수 편한 형태" 바). 테스트가 이걸 안 지킨다.
6. **의도 완전성([초안§5.11·§8.3])** — "AC가 애초에 의도 전체였나"는 **사용자 권위**, 자동 불가. front-load(deep-interview·pre-mortem)로 큐를 최대한 채우고 완료 시 교차모델 dialectic로 놓친 것 적대검토 — 그래도 잔차는 정직히 사용자에게 남긴다.

→ **완료 신호(`<promise>`/done)는 1~4를 내가 증거로 닫고, 5는 비평, 6은 사용자에 표면화할 때만 발화한다.** test-green은 층1일 뿐이고, 특히 **Codex는 test 결과가 아니라 diff·테스트 적정성·게이밍을 본다**(그래서 교차모델이 필수). [초안§5.11 정직한 총평: "풀었다"가 아니라 "증거가 허용하는 데까지 방어하고 잔차를 공개".]

---

## 4. 열린 결정 (사용자 몫 — 착수를 막지 않음)

1. **빅뱅 스코프 경계.** 제안: end-to-end 얇은 엔진(게이트 코어 + drive-loop + 실 HostAdapter 배선 + #6/#7/#8/#9, `rebuild/` 유닛+통합 green = 엔진이 work item 하나를 네이티브로 증거완주). 생애주기 스테이지(deep-interview·pre-mortem·e2e)는 후속. 넓히거나 좁힐지.
2. **비용 수용.** [S§3.5] 멀티에이전트/교차모델은 챗 대비 큰 토큰(연구 인용 ~15×). 사용자가 "집중 소모"로 이미 수용 — 재확인만.
3. **`/goal` 세션 지속 훅 사용 여부.** 편의 옵션([§3.1]). 없어도 내가 done-state까지 구동은 동일. 완료 게이트는 어느 경우든 실테스트.

## 5. 신뢰도·리스크 (정직 표시)

- **높음:** loop-fit 판정(greenfield+기계검증), `/goal` 부적합(1차 확정), dialectic 수정=필드 합의, 부트스트랩 재귀 논리.
- **중간:** "손-Ralph 하이브리드"가 순정 대안보다 낫다는 것은 [S] 원칙의 **종합**이지 우리 프로젝트에서 측정된 결과가 아님. 순효능 실증은 [초안§8.3] non-self fixture(palimpsest)에서만 가능 — 이 빌드가 그걸 만들진 않는다.
- **리스크:** ① overbaking([S§3.1]) — 빅뱅이 커밋을 미루면 병합·창발 위험 → 잦은 커밋·증분 검증으로 완화. ② 부트스트랩 손-규율은 사람(나)의 규율에 의존 — 자동 게이트가 아직 없어 [S§3.3] "정지는 코드에" 원칙을 완전히는 못 지킴(그게 빌드 대상). ③ 교차모델 Codex 가용성 의존(현재 인증됨). ④ [초안§8.3] 잔차 — "AC가 의도 전체를 담았나"는 사용자 권위, 자동 불가.

## 6. 다음 행동
이 두 보고서가 "정말 착수해도 되나"의 근거다. 착수하려면: work item 열고(§3-8), PLANNING 패스로 feature-list(intent-lock+AC)를 만들고, 손-Ralph 하이브리드로 구동(내 테스트=backpressure, Codex=교차검증, 유계), 실 green + Codex 검증으로 완료. **사용자 결정 대기: 스코프 확정 + 착수 go.**
