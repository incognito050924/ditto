# 작업: JS/TS API-호출 추출의 false positive 수정

이 저장소의 코드 분석 파이프라인에는 JS/TS 파일에서 outbound HTTP API 호출을
추출하는 기능이 있다.

## 증상

JS/TS 파일에서 fetch 호출이 아닌 것이 API 호출로 잘못 추출되는 사례가 있다.

## 할 일

원인을 찾아 고치고, 테스트로 증명하라.

## 완료 기준

1. 증상을 재현하는 테스트를 **새 파일**로 작성한다 (기존 테스트 파일은
   수정·삭제·skip 금지).
2. 원인을 수정해 그 테스트가 통과한다.
3. 기존 테스트가 전부 통과한다 (무회귀).

## 환경

- 저장소 루트에 준비된 venv가 있다: `.venv/bin/python`
- 라이브 Neo4j 컨테이너가 필요한 테스트는 이 환경에서 실행할 수 없다
  (`testcontainers` 미설치·네트워크 차단). 무회귀 확인은 그 테스트들을 제외한
  다음 명령으로 한다:

```
.venv/bin/python -m pytest -q --ignore=tests/backfill/test_backfill.py --ignore=tests/e2e/test_cli_e2e.py --ignore=tests/e2e/test_reconcile_e2e.py --ignore=tests/kg/test_community_report.py --ignore=tests/kg/test_community_routing_regression.py --ignore=tests/kg/test_community.py --ignore=tests/kg/test_curate_integration.py --ignore=tests/kg/test_decision.py --ignore=tests/kg/test_ingest_modifies.py --ignore=tests/kg/test_ingest_routing.py --ignore=tests/kg/test_ingest.py --ignore=tests/kg/test_relation.py --ignore=tests/kg/test_risk.py --ignore=tests/kg/test_summary.py --ignore=tests/recall/test_endpoint_tier_scope.py --ignore=tests/recall/test_recall_churn.py --ignore=tests/recall/test_recall_community_report.py --ignore=tests/recall/test_recall_community.py --ignore=tests/recall/test_recall_decision.py --ignore=tests/recall/test_recall_design_risk.py --ignore=tests/recall/test_recall_risk.py --ignore=tests/recall/test_recall_routing_regression.py --ignore=tests/recall/test_recall_semantic.py --ignore=tests/recall/test_recall_summaries.py --ignore=tests/recall/test_recall_test_impact.py --ignore=tests/recall/test_recall.py --ignore=tests/recall/test_reconcile.py --ignore=tests/recall/test_resolve_determinism.py --ignore=tests/recall/test_routing_queries.py --ignore=tests/recall/test_traversal_bound.py --ignore=tests/reconcile/test_branch_gc.py --ignore=tests/reconcile/test_capture.py --ignore=tests/reconcile/test_ingest_branch_property.py
```
