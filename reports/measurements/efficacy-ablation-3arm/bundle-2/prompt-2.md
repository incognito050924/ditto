# 작업: CLI 오류 보고 개선

이 저장소에는 `palimpsest`라는 CLI가 있다 (`.venv/bin/python -m palimpsest ...`;
하위명령: ingest / backfill / query / load / curate / reconcile / churn /
cochange / test-impact).

## 증상

사용자가 잘못된 입력을 주면 CLI가 파이썬 내부 traceback을 그대로 쏟아낸다.
예를 들어 `load`에 존재하지 않는 payload 경로를 주거나 JSON이 아닌 파일을
주면 스택 트레이스가 출력된다. 반면 어떤 하위명령은 사람이 읽을 수 있는
오류 한 줄과 0이 아닌 종료 코드로 끝난다. 오류 보고가 일관성이 없고 도구를
쓰는 입장에서 불편하다 — 개선하라.

## 완료 기준 (관찰 가능)

1. 잘못된 입력 — 최소한 위의 두 사례(존재하지 않는 payload 경로, JSON이
   아닌 payload 파일) — 에 대해: 파이썬 traceback이 아니라 사람이 읽을 수
   있는 오류 메시지가 나오고, 그 메시지에 어떤 입력이 문제였는지 드러나며,
   종료 코드는 0이 아니어야 한다.
2. 동작 보존: 정상 입력의 기존 동작은 그대로 유지된다. 기존 테스트가 전부
   통과한다 (무회귀). 기존 테스트 파일의 수정·삭제·skip은 금지.
3. 개선을 **새 테스트 파일**로 증명한다.

## 환경

- 저장소 루트에 준비된 venv가 있다: `.venv/bin/python`
- 라이브 Neo4j 컨테이너가 필요한 테스트는 이 환경에서 실행할 수 없다
  (`testcontainers` 미설치·네트워크 차단). 무회귀 확인은 그 테스트들을 제외한
  다음 명령으로 한다:

```
.venv/bin/python -m pytest -q --ignore=tests/backfill/test_backfill.py --ignore=tests/e2e/test_cli_e2e.py --ignore=tests/e2e/test_reconcile_e2e.py --ignore=tests/kg/test_community_report.py --ignore=tests/kg/test_community_routing_regression.py --ignore=tests/kg/test_community.py --ignore=tests/kg/test_curate_integration.py --ignore=tests/kg/test_decision.py --ignore=tests/kg/test_ingest_modifies.py --ignore=tests/kg/test_ingest_routing.py --ignore=tests/kg/test_ingest.py --ignore=tests/kg/test_relation.py --ignore=tests/kg/test_risk.py --ignore=tests/kg/test_summary.py --ignore=tests/recall/test_endpoint_tier_scope.py --ignore=tests/recall/test_recall_churn.py --ignore=tests/recall/test_recall_community_report.py --ignore=tests/recall/test_recall_community.py --ignore=tests/recall/test_recall_decision.py --ignore=tests/recall/test_recall_design_risk.py --ignore=tests/recall/test_recall_risk.py --ignore=tests/recall/test_recall_routing_regression.py --ignore=tests/recall/test_recall_semantic.py --ignore=tests/recall/test_recall_summaries.py --ignore=tests/recall/test_recall_test_impact.py --ignore=tests/recall/test_recall.py --ignore=tests/recall/test_reconcile.py --ignore=tests/recall/test_resolve_determinism.py --ignore=tests/recall/test_routing_queries.py --ignore=tests/recall/test_traversal_bound.py --ignore=tests/reconcile/test_branch_gc.py --ignore=tests/reconcile/test_capture.py --ignore=tests/reconcile/test_ingest_branch_property.py
```
