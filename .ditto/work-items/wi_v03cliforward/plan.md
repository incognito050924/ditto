# Plan

1. phase3-review P1 재현, citty가 `--help`를 처리하는 정확한 경로 확인(어디서 가로채는지), `--` 뒤 token이 어떻게 citty에 도달하는지 추적.
2. Design note: raw argv pre-processing 전략, wrapper argv vs provider argv 분리 위치(`cli/index.ts` 또는 `cli/util.ts`), tail 보관 방식(module-level state 또는 process.env 우회), 다른 command에 영향 없게 격리하는 방법.
3. CLI entry 또는 util 수정: `--` 기준 argv 분리. citty에는 wrapper argv만 전달. `extractDashDashTail`은 보관된 tail을 반환하도록 통합.
4. CLI 통합 회귀 fixture: 빌드된 `dist/ditto` 또는 entry function 직접 호출로 process.argv 경로를 끝까지 시뮬레이션. 3+ case (`-- --help`, `-- --version`, wrapper flag 이름 충돌).
5. P2 운영 규칙 적용: 본 work item에 대해 `ditto run with --verify "<sanity>"` 실행. work-item.json `runs`에 run id append.
6. DITTO self-validation, lint, build 통과 확인.
7. handoff + completion + work item close (changed_files에 self-artifacts 포함). project_v03_entry_point memory를 'v0.3 fully closed'로 정정.
