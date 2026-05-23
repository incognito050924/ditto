# ADR-0001: 런타임 및 구현 스택

- 상태: accepted
- 결정 일자: 2026-05-24
- 결정자: hskim, claude (claude-opus-4-7)

## 컨텍스트

DITTO는 사용자 machine에서 자주 실행되는 wrapper이며 Claude Code hook 환경에서는 매 tool 호출마다 spawn될 가능성이 있다. 따라서 다음 제약이 있다.

- single binary 배포 (사용자 환경에 런타임 의존성 추가 금지)
- 빠른 startup (hook 환경에서 100~300ms 추가가 사용자 경험을 망가뜨림)
- provider CLI(codex, claude) spawn과 stdout/stderr/exit 캡처가 표준이어야 함
- schema 6개 이상을 runtime + 타입으로 다뤄야 함
- 외부 도구가 contract를 import할 수 있어야 함

후보군:
- Go: single binary, 빠른 startup, 표준 라이브러리 풍부. schema 작업이 다소 verbose.
- Rust: 안정성, 성능. 초기 prototype 속도 느림.
- TypeScript + Bun: schema/타입 DX 우수, `bun build --compile`로 single binary, Bun 자체가 빠른 startup.
- TypeScript + Node: 자료 풍부하나 startup 느리고 single binary 배포가 까다로움(pkg/nexe/sea).
- Python: 빠른 iteration, 배포 가장 까다로움.

## 결정

- 언어: TypeScript
- 런타임: Bun
- 배포: `bun build --compile`로 OS별 single binary
- CLI 프레임워크: citty
- Schema 라이브러리: zod
- 외부용 schema export: zod-to-json-schema
- 테스트 러너: bun:test
- 포맷/린트: Biome
- repo 구조: 단일 패키지 (v0.4 전후 분리 검토)

## 근거

- TS DX와 zod의 결합으로 runtime 검증 + 타입을 단일 소스로 관리 가능.
- Bun이 Node 호환성을 유지하면서 startup이 빨라 hook 환경 제약을 충족.
- `bun build --compile`이 single binary 배포를 단순화함.
- citty는 ESM/TS-first에 객체 기반 declarative 정의로 schema-driven 코드와 자연스럽게 결합. 번들 크기가 작음(~10KB).
- Biome가 포맷+린트 통합으로 설정 비용을 줄임.

## 결과

긍정적
- 단일 binary로 사용자 설치 부담이 작음.
- TS 타입과 zod schema가 한 소스에 묶여 drift 감소.
- citty의 declarative 정의가 CLI 명령 자체를 fixture/manifest로 다루기 좋음.

부정적
- 현재 사용자 환경 Bun 버전이 1.0.2로 다소 구버전. 1.1.x 이상으로 업그레이드 권장.
- Bun 생태계는 Node보다 작아 일부 native module 비호환 위험이 있음(현 의존성에는 해당 없음).
- citty는 자료가 적어 trouble shooting 시 직접 코드 읽어야 할 수 있음.

## 대안과 폐기 사유

- Go: schema와 타입 작업이 generic 제한으로 verbose함. JSONSchema 1차 소스로 두면 가능하지만 TS DX보다 비효율.
- Rust: 초기 prototype 속도 손실이 v0.1 ~ v0.6 진행을 늦춤.
- Node + Commander: startup 시간과 single binary 배포 어려움이 hook 환경에 부적합.
- Python: 배포 모델이 사용자별로 달라 일관성을 보장하기 어려움.

## 되돌리기 비용

- 언어 자체 변경: 매우 큼. 전체 코드 재작성 필요.
- 런타임 Bun → Node: 작음. 거의 호환 가능. `bun:test` → `vitest` 또는 `node:test`로 마이그레이션 필요.
- CLI 프레임워크 citty → commander: 작음. 명령 정의 재작성.
- Biome → ESLint+Prettier: 작음. 설정 교체.
- schema 라이브러리 zod 변경: 중간. 전체 schema 재작성.

## 검증

- `bun --version` 1.0.2 이상
- `bun test` 통과
- `bun x tsc --noEmit` 통과
- `bun run lint` 통과
- `bun run schemas:export`로 schemas/*.schema.json 생성 확인
