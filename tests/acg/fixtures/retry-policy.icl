intent "automation-engine 외부 태스크 재시도를 지수 백오프로" {
  purpose: "고정 3회 재시도를 1s/2s/4s 지수 백오프로 변경한다"

  allow {
    glob "automation-engine/**/runtime/**"
    glob "automation-engine/**/test/**/RetryPolicy*" as "관련 테스트"
  }
  forbid {
    layer "kafka-adapter"                       # "메시지 계약 불변"
    surface "external-client task contract"
    symbol "TenantContext"                      # "테넌트 격리 불변"
  }

  invariant {
    "external-client가 받는 태스크 페이로드 형태는 동일하다"
    "재시도 중에도 tenant 격리가 유지된다" promote
  }

  accept {
    "재시도 간격이 1s,2s,4s 지수 백오프를 따른다" by test
    "기존 RetryPolicy 단위 테스트가 통과한다" by test
  }

  meta {
    risk: medium
    decision: "ADR-automation-0007"
    rationale: "automation-engine 커버리지 2.7%라 회귀 위험 높음 — characterization test 선행"
  }
}

fitness "tenant 격리 불변" {
  statement: "재시도 경로에서 TenantContext가 항상 전파된다"
  kind: semantic
  check: judge "재시도 핸들러 diff에서 TenantContext 전파가 누락되지 않았는가"
  when: per_change
  on_violation: warn
}
