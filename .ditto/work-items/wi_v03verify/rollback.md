# Rollback

- Seed 단계 교체 시: `.ditto/work-items/wi_v03verify/` 디렉터리를 제거한다.
- Implementation 단계에서 `--verify` flag나 wrapper 추가 부분이 회귀를 일으키면 그 부분만 revert한다. `RunStore`와 `runManifest` schema는 본 work item에서 손대지 않으므로 revert 범위가 좁다.
- `RunStore.pathFor`에 `'verify.log'` 키를 추가했다면 그 변경도 같이 revert. 기존 artifact 키 5종(prompt.md/stdout.log/stderr.log/diff.patch/result.md)은 wi_260524qi9에서 도입된 것이므로 보존한다.
- 회귀 fixture(verify pass/fail/spawn-fail)가 v0.3 후 다른 work item에서 의미가 있으면 fixture 코드는 보존하고 wrapper 변경만 후퇴한다.
