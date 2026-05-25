# Progress: 사용자 등록 API 비밀번호 강도 검증

## 현재 상태
`partial` — ac-1, ac-2는 pass, ac-3은 메시지 분리가 미흡해 partial.

## 진행 로그
- 09:00 work item 생성. 정책 후보 3개(min length, character class, breach list) 중 v0은 min length + character class만 적용.
- 09:30 `src/auth/password-policy.ts`에 정책 함수 추가.
- 10:10 `src/api/users.ts`에서 정책 호출 및 400 반환 분기 추가.
- 10:40 단위 테스트 3개 추가, 모두 통과.
- 11:30 응답 body 메시지가 한 줄로 합쳐져 ac-3을 partial로 판정.

## 다음 fresh evidence
- 정책 위반 메시지의 규칙별 분리 결과를 캡처
- 기존 사용자 회귀 테스트
