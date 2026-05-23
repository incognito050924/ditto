# Handoff: wi_pwdcheck

## 무엇이 끝났나
- 비밀번호 정책 모듈(`src/auth/password-policy.ts`)
- POST /users 요청 시 정책 위반은 400 반환 (`src/api/users.ts`)
- 단위 테스트 3개: weak-password, strong-password, 메시지 포함

## 무엇이 남았나
- ac-3: 응답 body 메시지에서 깨진 규칙을 규칙별로 분리해 노출
- 기존 사용자에 대한 영향(미적용) 회귀 테스트

## 어디서 이어받나
- 재개 명령: `ditto work resume wi_pwdcheck`
- 본 work item state: `.ditto/work-items/wi_pwdcheck/work-item.json`
- 마지막 run: `.ditto/runs/run_pwdcheck1/`
- 결정 기록: `.ditto/work-items/wi_pwdcheck/decisions.md`

## 어떤 fresh evidence가 필요한가
- 규칙별 분리 메시지 응답을 받은 curl/test 결과
- 기존 사용자가 새 정책 미달이어도 로그인/조회에 영향 없는지 회귀 테스트

## 무엇을 건드리지 않아야 하는가
- 기존 사용자 비밀번호 저장 경로 (`src/auth/password-store.ts`)
- 인증 토큰 발급 흐름 — 본 work item 범위 밖

## risk
- 기존 사용자 정책 미달 시 차후 강제 변경 정책이 도입되면 사용자 경험에 충돌. 도입 시점은 별도 결정 필요.
