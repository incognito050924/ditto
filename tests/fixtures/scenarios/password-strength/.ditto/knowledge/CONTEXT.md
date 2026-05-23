# Project Context — Sample Auth Service

본 fixture는 DITTO schema/fixture 검증용 가상의 인증 서비스 프로젝트 컨택스트다.

## Ubiquitous Language

### password policy
사용자 비밀번호가 등록 시점에 만족해야 하는 규칙 모음. v0에서는 최소 길이와 문자 클래스만 포함한다. breach list 조회는 정책 범위 밖이다.

별칭: `pw policy`

### policy violation
정책의 개별 규칙 위반. 코드에서는 `PolicyViolation` 타입의 string union으로 표현한다.
- `min_length`: 최소 길이 미달
- `character_class`: 영문 + 숫자 혼용 요건 미충족

혼동 금지:
- "policy error"는 본 프로젝트에서 사용하지 않는다.

### user creation
신규 사용자 등록. 본 프로젝트에서 "registration"과 "signup"은 모두 user creation으로 통일한다.

별칭: `signup`, `registration`

## 금지 약어
- `pw` (단독 사용 금지; `password`로 표기. 단, `pw policy`는 허용)
- `cls` (`character_class`로 표기)
