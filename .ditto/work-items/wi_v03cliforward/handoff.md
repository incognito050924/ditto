# wi_v03cliforward Handoff

## Outcome

phase3-review의 release-blocker P1을 닫음. 5 AC 모두 pass, final_verdict=pass.

`ditto run with --provider ... -- <provider args>`가 citty의 help parser에 가로채지지 않고 provider에게 투명 전달된다. 본 work item 자체가 `ditto run with --verify`로 capture된 run manifest(`run_260524d7d`)를 evidence로 남겨 P2 운영 규칙을 즉시 적용한다.

## Verification

- `bun test`: 175 pass / 0 fail (이전 171 → +4 CLI integration regression fixtures).
- `bun run lint`: pass.
- `bun run build`: pass.
- P1 reproducer 직접 재실행: `dist/ditto run with --provider codex --profile workspace-write --workItem <wi> --output json -- --help`가 provider help를 forward하고 `.ditto/runs/<id>/manifest.json` 생성 + exit 0.
- self-application run: `.ditto/runs/run_260524d7d/manifest.json` — provider exit 0, verifications=[{command:"bun test tests/cli/run-with-cli-forward.test.ts", exit_code:0, duration_ms:1480, output_path:".ditto/runs/run_260524d7d/verify.log"}].

## What Changed (high level)

- `src/cli/index.ts`: process.argv를 entry에서 pre-slice해서 `--` 앞 wrapper-side만 citty `runMain`에 rawArgs로 전달. `--` 없으면 fall-back으로 기존 동작 유지. process.argv 자체는 무손상이라 `extractDashDashTail()`은 그대로 동작.
- `tests/cli/run-with-cli-forward.test.ts`: 빌드 의존 없이 `bun src/cli/index.ts`로 CLI를 실제 spawn하고 PATH-overridden mock 'codex'가 자기 argv를 파일에 dump하는 4-case 회귀 fixture (--help, --version, wrapper/provider flag collision, separator-absent sanity).
- 자기 적용: 본 work item에 대해 `ditto run with --verify "bun test tests/cli/run-with-cli-forward.test.ts" -- --help` 실행 → `.ditto/runs/run_260524d7d/`에 manifest + verify.log + stdout/stderr/diff 저장, work-item.json `runs`에 run id append.

## Notes / Caveats

- `verify` command도 같은 P1 latent bug가 있었는데 entry-level fix가 자동으로 해결한다. 다만 본 work item은 `run with` 한정 회귀 fixture만 가지므로, verify CLI 통합 검증은 별도 work item으로 미룬다(incidental fix).
- `.ditto/runs/` 디렉터리는 기본 gitignore 대상이지만, 본 work item의 자기 적용 evidence(run_260524d7d)는 `git add -f`로 명시 commit한다. 향후 dogfood/self-application은 같은 패턴.

## Next

`wi_v03cliforward` done과 동시에 project_v03_entry_point memory를 **'v0.3 fully closed'**로 다시 정정한다. 이후 default 진입점은 application plan Phase 4 workflow loop / completion gate 또는 plan version 순서대로 v0.4 Evaluator and E2E lane (사용자 redirect).

## Deferred (post-this work item)

- P3 (networked profile network-explicit enablement) — 별도 work item.
- `verify` command의 동일 P1 latent bug 회귀 fixture (entry-level fix가 동작은 시키지만 explicit regression coverage 없음).
- 기존 v0.3 세 work item retrospective run manifest 보정 — 의도적으로 안 함.

## Pointers

- Design note: `.ditto/work-items/wi_v03cliforward/design/cli-argv-forward.md`
- Completion: `.ditto/work-items/wi_v03cliforward/completion.json`
- Self-application run: `.ditto/runs/run_260524d7d/manifest.json`
- Base: `a32d3c2` (seed), branch tip은 이 close commit.
- Phase 3 review: `reports/harnesses/ditto-phase3-review.md`.
