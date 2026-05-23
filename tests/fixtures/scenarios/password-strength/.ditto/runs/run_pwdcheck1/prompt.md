# Context Packet — run_pwdcheck1

## Current goal
POST /users 요청 시 비밀번호가 프로젝트 정책에 미달하면 400과 명시적 메시지를 반환한다.

## Acceptance criteria
- ac-1: 짧은 비밀번호로 POST /users 요청 시 400 응답
- ac-2: 정책 통과 비밀번호로 POST /users 요청 시 201 응답
- ac-3: 정책 위반 응답 body에 어떤 규칙이 깨졌는지 사람이 읽을 수 있는 메시지 포함

## Current git state
- branch: feature/password-policy
- head: 4079028
- dirty: false

## Relevant files
- src/api/users.ts
- src/auth/password-store.ts (참고용, 수정 금지)
- tests/api/users.create.test.ts

## Last failure
- 없음 (work item 시작 시점)

## What not to touch
- src/auth/password-store.ts
- 인증 토큰 발급 흐름

## Evidence and artifact pointers
- 정책 후보 논의: .ditto/work-items/wi_pwdcheck/decisions.md

## Expected output contract
- changed files 명시
- 각 acceptance criterion에 대해 verdict 명시
- 검증 실패 항목은 unverified로 기록, 완료 주장 분리
