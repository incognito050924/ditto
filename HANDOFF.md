# HANDOFF — 다른 PC 이어받기 (2026-06-19)

호스트 메모리는 전파되지 않으므로 다른 PC에 필요한 것을 여기 싣는다. **브랜치 `claude/deep-interview-skill-gaps-g5liop`, origin 푸시 완료, 미커밋 없음.** 코드·테스트·git이 권위다(헌장 §4-11) — 이 문서는 "어디서 이어받나 + 남은 위험" 포인터이지 사실의 원본이 아니다.

## 1. 직전 세션 (2026-06-19) — tech-spec 표면 마감

전부 커밋·푸시(`037572e`~`2c9795f`). `bun test` **2450 pass / 0 fail / 9 skip**.

| 커밋 | 내용 |
|---|---|
| `037572e` | 질문 옵션 enforcement seam — `ditto tech-spec next-round`(매 라운드 levers 하달 + `tech-spec-rounds.jsonl` 카운트로 `max_rounds`/`max_questions` cap 강제). `gate_mode` `confirm`/`draft`(draft=답 가능한 건 에이전트가 근거와 함께 채우고 비가역·가치만 사용자). `generator_effort`/`granularity` 행동 rubric(`agents/question-generator.md`). SKILL §6-6 경화. **코드 강제는 cap(개수)뿐, 품질 lever는 gate 판단** |
| `531aa68` | intensity 다이얼 정상화 — `MAX_SELECTION_BAR=0.9` 캡(intensity 100→threshold 1.0 게이트 무력화 제거), `count_hint` `/25`. 5 프리셋(glance/quick/standard/deep/exhaustive)이 인접마다 ≥2 lever로 구별 |
| `931ff53` | reports/ tech-spec 문서 7개 삭제 + 배포표면 design-source 연결 제거(코드에 동기화 안 되는 설계/기획은 drift → 제거). 죽은 링크 0 |
| `f6696ff` | charter §4-11 "권위는 코드에" 추가(`AGENTS.md` canonical → bridge sync로 `CLAUDE.md`/`resources/managed`/`dist/plugin` 전파, GLOBAL_* 제외) |
| `2c9795f` | 사용자 가이드 `skills/tech-spec/GUIDE.md`(사용법·옵션·최적화·config) + README "Authoring a tech-spec" 연결 |
| `39d2913` | follow-up #2·#3 — config fail-open 경고(`.ditto/local/config.json` 파싱 실패 시 `onMalformed` 콜백으로 CLI 경고, fail-open 유지) + `agents/question-gate.md`에 threshold=anchor(hard cut 아님) 명시 |

## 2. 남은 위험 / follow-up (선택 — 차단 아님; 정적 검증은 SOUND)

최종 독립 점검(fresh context)에서 정적은 전부 OK였다(삭제 문서 죽은 링크 0, charter 6곳 일관, CLI verb 5/5, 옵션 resolver↔GUIDE 프리셋 표 정합). 직전 점검의 미세 정합 2건(#2 gate.md threshold 문구, #3 config fail-open 무경고)은 `39d2913`에서 처리했다. **남은 건 하나뿐 — 행동 검증**:

1. **(유일하게 남은 후속) 실 에이전트 도그푸딩** — `ditto:question-generator`/`question-gate`가 실행 중 세션에서 spawn 불가(에이전트 레지스트리는 세션 시작 시 로드)라, 이번 세션은 `general-purpose` **대역**으로만 워크플로를 검증했다. next-round 하달·옵션 obey·`gate_mode=draft` 안전경계를 **실제 `ditto:` 타입으로** 검증하려면 새 세션이 필요하다 — 다른 PC에서 이어받기 좋은 첫 작업. (코드/테스트/문서는 검증됨; `bun test` 2452 pass / 0 fail. 미검증은 실타입 *행동*뿐.)

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
