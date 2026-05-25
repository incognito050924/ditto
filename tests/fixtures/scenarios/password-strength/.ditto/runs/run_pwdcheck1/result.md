# Result — run_pwdcheck1

## 변경 요약
비밀번호 정책 모듈을 추가하고, 신규 사용자 등록 경로에서 정책 위반 시 400을 반환하도록 했다. 정책 위반 응답 메시지는 한 줄 통합 형식으로 v0 구현했다.

## 변경 파일
- src/api/users.ts
- src/auth/password-policy.ts
- tests/api/users.create.test.ts

## acceptance verdict
- ac-1: pass — weak-password 케이스 통과
- ac-2: pass — strong-password 케이스 통과
- ac-3: partial — 메시지는 포함되지만 규칙별 분리되지 않음

## 검증한 명령
- `bun test tests/api/users.create.test.ts -t weak-password` exit 0
- `bun test tests/api/users.create.test.ts -t strong-password` exit 0
- `bun test tests/api/users.create.test.ts -t message-includes` exit 1

## 검증하지 못한 항목
- ac-3 규칙별 분리: 현재 메시지는 한 줄이라 자동 검증 어려움
- 기존 사용자 영향 회귀 테스트: 별도 fixture 미존재

## 남은 risk
- 기존 사용자 정책 미달 처리 정책 미정

## 다음 handoff
- .ditto/work-items/wi_pwdcheck/handoff.md
