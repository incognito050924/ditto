# Decisions: 사용자 등록 API 비밀번호 강도 검증

## D-1: v0 정책 범위
- 결정: min length 12, 영문 + 숫자 혼용만 v0에서 적용.
- 이유: breach list 조회는 외부 의존성으로 networked profile이 필요하며, 본 work item의 acceptance에 포함되지 않음.
- 적용 범위: 신규 등록 경로에만 적용. 기존 사용자 마이그레이션은 별도 work item.

## D-2: 응답 body 메시지 포맷
- 결정: v0은 한 줄 메시지로 통합. 규칙별 분리는 ac-3 partial로 남기고 후속 fresh evidence 후 결정.
- 이유: 첫 PR scope를 좁히기 위함. 정책 객체 자체는 규칙 배열로 이미 구성되어 추후 분리 비용은 작음.
