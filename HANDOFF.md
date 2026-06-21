# HANDOFF — 다른 PC 이어받기 (2026-06-20)

호스트 메모리는 전파되지 않으므로 다른 PC에 필요한 것을 여기 싣는다. **작업은 `main`(`48d6d44`)에 있다 — origin 푸시 완료, 미커밋 없음.** feature 브랜치 `claude/deep-interview-skill-gaps-g5liop`는 main에 FF 머지 후 local·remote 삭제됐고 그 worktree도 제거됐다. **이어받을 위치 = `~/dev/projects/ditto`, 브랜치 `main`** (worktree 아님). 코드·테스트·git이 권위다(헌장 §4-11) — 이 문서는 "어디서 이어받나 + 남은 위험" 포인터이지 사실의 원본이 아니다.

## 0. 직전 세션 (2026-06-20) — setup 수정 머지 + 도그푸딩 + 환경 정리

- **setup 버그 수정 `bbed714`** (main 반영, behavioral): `ditto setup`가 instruction 파일을 역할로 분기 설치하도록 고침 — AGENTS.md=source(raw·create-if-missing, authored 헌장 미덮어쓰기), CLAUDE.md=projection(`source=AGENTS.md`로 on-disk AGENTS.md verbatim mirror). 이전엔 CLAUDE.md source가 CLAUDE.md로 뒤바뀌고(모든 setup 프로젝트 `doctor instructions` drift) ditto 자기 repo에선 AGENTS.md 헌장이 중복됐다. 핵심=`src/core/setup.ts`의 `installResource()`. work item `wi_260619r0o` done. **블라스트 반경**: source-flip은 setup된 모든 프로젝트에 영향 — 기존 프로젝트는 고친 `ditto setup` 재실행으로 self-heal(AGENTS.md kept, CLAUDE.md만 재투영).
- **tech-spec 실 에이전트 도그푸딩 완료(PASS)** — §2 참조. question-generator/gate가 이제 main의 `dist/plugin`에 포함되므로 **새 세션은 `--plugin-dir` 우회 없이 실타입으로 바로 사용 가능**.
- **환경 정리**: FF 머지 → feature 브랜치 local+remote 삭제 → worktree 제거 → 메인 체크아웃 `main` 전환. 브랜치 전환 훅이 `dist/plugin` 재조립 → 라이브 `ditto`(심링크 `~/.local/bin/ditto` → `~/dev/projects/ditto/dist/plugin/bin/ditto`)에 수정 반영 확인(`installResource` 2).
- **선택 후속(차단 아님)**: ① 도구 불일치 — `ditto work done`은 completion.json(현재 `autopilot complete`/handoff만 생성)을 요구하는데 `ditto verify` CLI는 criterion verdict만 기록한다. 그런데 `work done` 에러는 "run `ditto verify` first"라 안내해 어긋난다. 직접 TDD 수정처럼 deep-interview→autopilot을 정당히 건너뛴 작업은 handoff 우회 없이 깔끔히 닫히지 않음(이번엔 `ditto work handoff`로 우회해 닫음). ② setup self-heal 안내(위 블라스트 반경).

## 1. 이전 세션 (2026-06-19) — tech-spec 표면 마감

전부 커밋·푸시(`037572e`~`2c9795f`). `bun test` **2450 pass / 0 fail / 9 skip**.

| 커밋 | 내용 |
|---|---|
| `037572e` | 질문 옵션 enforcement seam — `ditto tech-spec next-round`(매 라운드 levers 하달 + `tech-spec-rounds.jsonl` 카운트로 `max_rounds`/`max_questions` cap 강제). `gate_mode` `confirm`/`draft`(draft=답 가능한 건 에이전트가 근거와 함께 채우고 비가역·가치만 사용자). `generator_effort`/`granularity` 행동 rubric(`agents/question-generator.md`). SKILL §6-6 경화. **코드 강제는 cap(개수)뿐, 품질 lever는 gate 판단** |
| `531aa68` | intensity 다이얼 정상화 — `MAX_SELECTION_BAR=0.9` 캡(intensity 100→threshold 1.0 게이트 무력화 제거), `count_hint` `/25`. 5 프리셋(glance/quick/standard/deep/exhaustive)이 인접마다 ≥2 lever로 구별 |
| `931ff53` | reports/ tech-spec 문서 7개 삭제 + 배포표면 design-source 연결 제거(코드에 동기화 안 되는 설계/기획은 drift → 제거). 죽은 링크 0 |
| `f6696ff` | charter §4-11 "권위는 코드에" 추가(`AGENTS.md` canonical → bridge sync로 `CLAUDE.md`/`resources/managed`/`dist/plugin` 전파, GLOBAL_* 제외) |
| `2c9795f` | 사용자 가이드 `skills/tech-spec/GUIDE.md`(사용법·옵션·최적화·config) + README "Authoring a tech-spec" 연결 |
| `39d2913` | follow-up #2·#3 — config fail-open 경고(`.ditto/local/config.json` 파싱 실패 시 `onMalformed` 콜백으로 CLI 경고, fail-open 유지) + `agents/question-gate.md`에 threshold=anchor(hard cut 아님) 명시 |

## 2. 남은 위험 / follow-up (정적 검증 SOUND; 행동 검증 완료)

최종 독립 점검(fresh context)에서 정적은 전부 OK였다(삭제 문서 죽은 링크 0, charter 6곳 일관, CLI verb 5/5, 옵션 resolver↔GUIDE 프리셋 표 정합). 직전 점검의 미세 정합 2건(#2 gate.md threshold 문구, #3 config fail-open 무경고)은 `39d2913`에서 처리했다.

1. **실 에이전트 도그푸딩 — 완료(2026-06-19)**. `ditto:question-generator`/`question-gate`는 실행 중 세션 레지스트리(세션 시작 시 로드)에 없어, **worktree 플러그인을 `claude --plugin-dir`로 로드한 헤드리스 중첩 세션**으로 실타입 검증했다. 부모 세션 transcript에 `ditto:question-generator` ×3 + `ditto:question-gate` ×1 spawn 확인(`general-purpose` 대역 0). 관측: next-round levers 전달 · 옵션 obey(`tech-spec-state.json`의 generators 3 / gate_mode draft / threshold 0.8) · numeric cap 집행(cap_reached false→true) · gate 네이티브 4축 점수+rationale(영속 `tech-spec-rounds.jsonl`) · `gate_mode=draft` fill-vs-escalate 경계(변환 시맨틱·DST 정책 등 가치/도메인 질문 escalate, 가역 관례만 fill, 오답 0). **verdict PASS.** 검증 강도: 4축은 하드 아티팩트, draft 경계는 추론 수준(provisional fill은 ledger 미영속). gate의 4축 결합함수 자체는 미재현.

기존 보류(ADR-0013): 승인게이트 적대적 차단 · bootstrap handoff-archive 신뢰등급 · pull actionability 측정 — 별도 소관.

## 3. 핵심 파일

- `src/core/tech-spec-options.ts` — 순수 resolver: `PERFORMANCE_PRESETS`, `MAX_SELECTION_BAR`, `intensityToSubLevers`, `resolveQuestionConfig`.
- `src/core/tech-spec.ts` — `startTechSpec`/`recordSection`/`recordRound`/`nextRound`/`finalizeTechSpec`.
- `src/cli/commands/tech-spec.ts` — 5 verb(start/record-section/record-round/next-round/finalize).
- `src/schemas/{tech-spec-state,tech-spec-round,ditto-config}.ts` — 스키마.
- `skills/tech-spec/{SKILL,TEMPLATE,GUIDE}.md` · `agents/question-{generator,gate}.md`.

## 4. 다른 PC 설치/갱신 체크리스트

marketplace 소스 = **GitHub incognito050924/ditto**.

```bash
claude plugin marketplace add incognito050924/ditto    # 미등록 시
claude plugin marketplace update ditto-local           # ★ 기존 설치 PC는 필수 (stale 클론 함정)
claude plugin install ditto@ditto-local
```

함정: 소스 변경 반영은 push 후 `claude plugin marketplace update ditto-local`가 **필수**다(`claude plugin update`는 버전 0.0.0 고정이라 no-op). 테스트는 bun ≥1.3.14, `bun test` 기대값 **0 fail**.
