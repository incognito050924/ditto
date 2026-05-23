# Handoff: wi_v01bootstrap → wi_v01implement

## 무엇이 끝났나
- TypeScript + Bun + citty + Biome + zod 스택 결정과 ADR 보존
- zod schema 6개와 JSONSchema export 동작
- golden fixture(password-strength) 한 세트와 schema 검증 테스트 11개
- citty 기반 CLI 5개 명령 골격(`work start|status|handoff`, `run record`, `verify`) — 동작은 not_implemented(exit 64)이지만 인자/플래그/help/JSON 출력은 완성

## 무엇이 남았나
- CLI 5개 명령의 실제 동작: `.ditto/` 파일 읽기/쓰기, schema 검증, completion contract 적용, evidence 기록
- WorkItemStore/RunStore 구현
- 다른 세션/PC 동기화를 위한 `.ditto` commit/sync policy 결정과 적용
- v0.2 doctor의 schemas drift 검사가 본 work item에서 약속된 보강 항목

## 어디서 이어받나
- 다음 work item: [[wi_v01implement]] (사전 plan/dod/rollback/context-packet 작성 예정)
- 본 work item 상태: `.ditto/work-items/wi_v01bootstrap/work-item.json`
- ADR: `.ditto/knowledge/adr/ADR-0001-runtime-stack.md`, `.ditto/knowledge/adr/ADR-0002-schema-source-of-truth.md`
- glossary: `.ditto/knowledge/CONTEXT.md`, `.ditto/knowledge/glossary.json`

## 어떤 fresh evidence가 필요한가
- wi_v01implement에서는 각 acceptance에 대해 *실제 `.ditto` 파일 생성/수정*을 evidence로 요구한다.
- 단순 `--help` 출력이나 `not_implemented` exit 64는 v0.1 실제 구현 단계에서 acceptance 증거로 사용하지 않는다.

## 무엇을 건드리지 않아야 하는가
- `src/schemas/`의 기존 필드 의미(필드명, enum 값, cross-field 룰). 변경 필요 시 ADR 추가하고 fixture/테스트 동기 갱신.
- `tests/fixtures/scenarios/password-strength/` 골든 fixture. 새 acceptance를 시연하고 싶다면 새 시나리오 디렉터리로 분리.
- `bun:test`와 `citty`와 `Biome` 선택. 교체는 ADR 신규 작성 후에만.

## risk
- 사용자 환경 Bun 1.0.2 구버전: 의존성에는 영향 없으나, native module 호환 이슈가 등장하면 1.1.x 이상 업그레이드 필요.
- plan-check 누락 사례: 본 부트스트랩은 사용자 합의로 회고형 기록으로 정당화되었으나, 다음 work item에서 반복하면 절차 자체가 무력화된다.
