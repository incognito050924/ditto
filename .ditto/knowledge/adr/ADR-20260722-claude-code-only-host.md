# ADR-20260722-claude-code-only-host: Claude-Code-only 호스트 — dual-host(ADR-0016) supersede · codex host flag는 시끄러운 실패 · Codex 표면 제거는 추적 후속

- 상태: accepted
- 결정 일자: 2026-07-22
- 결정자: hskim, claude
- 관련: **ADR-0016-dual-host-claude-codex (SUPERSEDE** — 이 ADR이 그 구조 결정 전체를 대체한다. ADR-0016의 상태 라인이 이 ADR을 가리킨다), ADR-0025 (Codex dogfood 격리 — Codex 표면이 제거되면 **moot**가 된다. ADR-0025 본문은 수정하지 않고 여기 기록만 남긴다; 실제 상태 전환은 표면 제거 후속에서), ADR-0008 (호스트-추상 기계 보류 — HostAdapter 축 자체의 결정. 이 ADR로 그 축 위의 두 번째 호스트가 내려간다), wi_260722esa (deep interview에서 사용자 결정, 2026-07-22).

## 컨텍스트

hook 재배선 증분 3이 dual-host 질문을 강제했다: 재배선된 plugin hook들은 Claude 계약만을 대상으로 작성되고 있고, 양 호스트(both-host) 테스트 fixture는 이미 삭제된 상태다. 즉 ADR-0016이 요구하는 "두 host fixture 모두 통과"(D6)를 뒷받침할 증거 기반이 없다. 이 상태에서 세 갈래 — (a) day-one dual-host 호환 유지, (b) Codex를 legacy handler에 남기는 명시적 유예, (c) ADR-0016 supersede — 중 사용자가 wi_260722esa deep interview에서 (c) supersede를 선택했다.

## 결정

**ditto는 Claude-Code-only 호스트 제품이다. ADR-0016(dual-host)은 superseded.**

1. **Hook은 Claude 계약만을 대상으로 한다.** 재배선된 plugin hook은 Claude-only다. host 분기 없이 Claude Code hook 계약이 유일한 대상 계약이다.
2. **codex host flag는 시끄럽게 실패한다.** 새 hook 명령이 codex host flag를 받으면 게이트를 공허하게(vacuously) 통과시키는 대신 **loud non-zero 실패**를 낸다. false-green(게이트 미발화가 통과처럼 보이는 것)이 조용한 무시보다 나쁘기 때문이다.
3. **기존 Codex 빌드 표면의 제거는 추적된 후속이다 — 이 work item이 아니다.** 대상: `scripts/build-codex-plugin.mjs`, `dist/codex-plugin`, host-adapter의 codex 분기, `injectCodexHost` seam. 이 ADR은 방향(제거)을 확정하고, 실행은 별도 추적 후속으로 미룬다.
4. **ADR-0025는 Codex 표면 제거 시점에 moot가 된다.** Codex dogfood 격리 규칙은 격리할 Codex 표면이 사라지면 대상이 없다. ADR-0025 자체는 여기서 편집하지 않는다.

## 근거 (rationale)

- **증거 없는 호환 주장은 헌장 위반이다.** both-host fixture가 삭제된 상태에서 dual-host 호환을 유지한다고 말하는 것은 검증 없는 완료 선언이다. ADR-0016 D6가 요구한 fixture 증거가 없으면 그 구조 결정은 이미 집행 불능이다.
- **공허한 게이트보다 시끄러운 실패.** codex flag에서 게이트가 조용히 no-op되면 안전게이트 미발화가 green으로 보인다(ADR-0016이 D3에서 막으려던 바로 그 false-green). 명시적 non-zero 실패가 유일하게 정직한 동작이다.
- **제거를 이 WI에 섞지 않는다.** hook 재배선과 Codex 표면 제거는 별개 의도다(하나의 의도=하나의 단위, ADR-20260710). 방향 확정과 실행 분리로 이번 diff를 외과적으로 유지한다.

## 기각된 대안 (rejected alternative)

- **Day-one dual-host 호환 유지.** 기각 — 뒷받침할 테스트 증거가 존재하지 않는다(both-host fixture 이미 삭제). 증거 없는 호환 유지는 fixture 재작성이라는 미요청 비용을 강제하거나, 검증 없는 주장이 된다.
- **명시적 유예 — Codex를 legacy handler에 남겨두기.** 기각 — 사용자가 거부했다. 유예는 두 hook 체계(신규 Claude-only + legacy Codex)를 병존시켜 drift와 false-green 표면을 늘린다.

## Supersedes

- **ADR-0016-dual-host-claude-codex** — 전체 supersede. D1~D6(공통 코어+어댑터, 두 divergence 지점, host별 빌드 분리, surface projection, Codex 발견 경로, both-host 체크리스트)의 dual-host 전제가 모두 내려간다. ADR-0016의 상태 라인은 `superseded by ADR-20260722-claude-code-only-host`로 표시한다.

## 변경 조건 (change_condition)

- **두 번째 호스트 수요가 실제로 돌아오면** → ADR-0016을 되살리지 않는다. **새 ADR**로, 그 시점의 대상 호스트 계약에 대한 **fixture 증거**를 갖추고 재평가한다(증거-선행: fixture 없이 구조 결정을 다시 세우지 않는다).
- **Codex 표면 제거 후속이 완료되면** → ADR-0025의 moot 상태 전환을 그 후속에서 기록한다.
