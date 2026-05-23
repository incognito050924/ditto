# ADR-0002: Schema의 source of truth

- 상태: accepted
- 결정 일자: 2026-05-24
- 결정자: hskim, claude (claude-opus-4-7)

## 컨텍스트

DITTO contract는 다음 곳에서 사용된다.

- TypeScript 코드 내 runtime 검증과 컴파일 타임 타입
- 외부 도구(다른 언어로 작성된 reviewer agent, hook script)에서 동일 contract 검증
- 사용자 문서(application plan, ADR)에서 contract 참조

후보:
- TypeScript 타입 + zod 라이브러리를 source로 두고 JSONSchema는 export
- JSONSchema(.json)를 source로 두고 TS 타입은 codegen
- 두 곳을 동시에 유지 (drift 위험)

## 결정

- zod schema(`src/schemas/*.ts`)가 source of truth.
- `scripts/export-schemas.ts`가 `schemas/*.schema.json`을 생성한다.
- 외부 도구는 생성된 JSONSchema 파일을 import한다.
- 모든 변경은 zod 쪽에서 일어나야 하며, JSONSchema 파일을 직접 편집하지 않는다.

## 근거

- zod는 runtime 검증과 TS 타입 추론을 한 정의로 제공해 drift 위험이 가장 작다.
- `superRefine` 등 cross-field 룰을 표현하기 쉽다(예: `completion-contract`의 `final_verdict=pass` 검사).
- `zod-to-json-schema`로 JSONSchema 7 export가 안정적이다.
- JSONSchema-first는 TS DX(자동 추론, refine)가 떨어진다.

## 결과

긍정적
- TS 코드에서 type-safe하게 schema를 사용할 수 있다.
- 한 곳만 수정하면 외부 view가 자동 갱신된다.

부정적
- JSONSchema export를 잊으면 외부 도구와 drift가 생길 수 있다 → CI/사전 검증 필요.
- 다른 언어에서 zod schema를 직접 이해하지 못한다(JSONSchema view 의존).

## 강제 절차

- `package.json`의 `schemas:export` 스크립트를 변경 후 항상 실행한다.
- 후속 phase에서 `ditto doctor schemas` 명령이 source/export 일치를 검증해야 한다(v0.2 doctor 범위에 포함).
- `superRefine` 같이 JSONSchema로 완전 표현되지 않는 룰은 ADR 또는 schema 본체에 명시적으로 주석을 남긴다.

## 되돌리기 비용

- JSONSchema-first로 전환: 중간. 모든 schema를 .json으로 재작성하고 TS 타입은 codegen으로 전환. `superRefine` 룰은 별도 처리 필요.
- zod 라이브러리 자체 교체: 큼. 전체 schema 재작성.

## 검증

- `bun run schemas:export` 실행 후 `schemas/*.schema.json` 6개 존재 확인
- `bun test`로 fixture가 schema에 부합하는지 확인
