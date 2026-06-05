# Dialectic-1 — wi_260605aw1 · semantic scan 자동배선(O2/O8) 설계

- **mode**: design · **verdict**: **revise** · Opponent: Codex(codex-rescue)
- 초안의 핵심 메커니즘이 오라클로 기계적 반증됨 → 발동점·산출물 분리로 재설계

## 초안이 틀린 곳 (검증된 결정사실)
- **OBJ-8 (결정적)**: Stop 훅에 CodeQL DB 빌드 = ADR-0001 성능계약(hook 매 tool-call spawn·100-300ms 예산) 위반 + C1/비-데몬 경계 위반. `maybeRunFitness`(stop.ts:259-282)는 **사전 산출물 소비**일 뿐 in-hook 분석 DB 빌드 안 함 → Producer "동형 슬롯" 주장 반증. **올바른 동형은 'Stop이 prewritten scan 산출물 소비'**.
- **OBJ-3**: `semantic-compatibility.json`은 파일 presence만으로 로드(stop.ts:352-356,412-413)되고 `unverified`는 무조건 차단(242-243), opt-in 플래그 미참조 → "플래그가 advisory/blocking 겸함"은 **기계적으로 불가**.
- **OBJ-1**: 8-iteration 가드는 continuation만 cap, scan 재실행은 미억제 → opt-in 켜면 Stop마다 재빌드.
- **OBJ-2**: after-DB를 HEAD sha로 캐시하면 미커밋 변경 false-clean.

## 5쟁점 합의 (재설계)
| # | 쟁점 | 결론 |
|---|---|---|
| 1 | 어디서/언제 | **Stop 배선 기각.** scan은 `/ditto:verify` 또는 autopilot node에서 intent당 1회, 타입 산출물 기록. **Stop은 read+gate만** |
| 2 | 비용 | in-hook 빌드 금지. fingerprint(work_item+base+lang+sourceRoot+worktree hash)로 unchanged skip. 첫 빌드 비용 수용. impact DB 공유는 형식검증 후 분리 |
| 3 | base ref | started_at_sha 단독 기각 → **handoff fallback 체인**(started_at_sha > origin/main > … ) 재사용 + `baseUsed` 영속 |
| 4 | advisory vs blocking | scan → 비-게이트 **`semantic-scan-observation.json`**. blocking `semantic-compatibility.json`은 명시 verdict 전용. 승격은 명시 행위. opt-in은 '실행 여부'만(직교) |
| 5 | opt-in | typed 스키마/config 홈, 기본 off, **명시 disabled/skipped 출력**(침묵 금지) |

## MVP 경계
- **정확히 1-change work item만 자동배선**. 다중변경은 durable diagnostic(명시 detect 요구), 자동 blocking 금지. 스키마 배열확장 거부(scope_creep).

## required_edits (10) — 구현 진입 시
1. in-hook CodeQL 빌드 제거, Stop은 observation read-only 소비 / 2. scan을 verify·autopilot node로 / 3. fingerprint unchanged skip / 4. after DB fresh(HEAD sha 금지) / 5. 비-게이트 observation 스키마 신규 / 6. handoff base fallback + baseUsed / 7. 1-change만, 다중 diagnostic / 8. opt-in typed 홈·명시출력 / 9. typed scan-status(ok|skipped|failed) / 10. "Stop은 prewritten 소비, in-hook 빌드 안 함" 경계 ADR/주석 명시

## 남은 열린 질문 (사용자/후속)
1. **발동점 단일화**: `/ditto:verify`만 vs autopilot node도 — 둘 다면 중복실행 방지 필요. (가치·우선순위 결정)
2. impact DB 형식 공유 가정 미검증 → 후속 분리.
3. observation→blocking 승격 UX 진입점 미정.
