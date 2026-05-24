# Rollback

- Seed 단계 교체 시: `.ditto/work-items/wi_v03cliforward/` 디렉터리 제거.
- Implementation 단계에서 CLI raw argv pre-processing이 다른 command(run record, verify, doctor 등)의 help/usage 동작을 깨면, 변경을 `run with` 한정으로 좁히거나 전체 revert. citty 기반 다른 command는 본 work item에서 손대지 않으므로 revert 범위가 좁다.
- P2 자기 적용 evidence(.ditto/runs/<id>)는 실제 run의 산출물이므로 회로상 revert가 어렵다. 본 work item을 revert해야 하는 상황이면 그 run id를 work-item.json `runs`에서 제거하고 `.ditto/runs/<id>` 디렉터리는 evidence로 남기는 옵션이 있다.
- 회귀 fixture(빌드된 dist/ditto 의존)가 CI 환경에서 깨지면 fixture만 분리해서 src 기반 entry 호출로 전환. CLI fix 본체는 보존.
