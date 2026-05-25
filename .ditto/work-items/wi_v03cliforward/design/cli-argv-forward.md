# CLI `--` Tail Forward Design

## Decision Summary

citty의 `runMain`이 `rawArgs.includes("--help")`로 flat scan하면서 `--` separator를 무시하는 게 P1의 단일 root cause. 수정은 `src/cli/index.ts` entry에서 `process.argv`의 `--` 위치를 미리 찾아 wrapper-side만 citty `rawArgs`로 전달하는 한 군데 변경.

## Root Cause

`node_modules/citty/dist/index.mjs:431-446`:

```js
async function runMain(cmd, opts = {}) {
  const rawArgs = opts.rawArgs || process.argv.slice(2);
  ...
  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    await showUsage(...await resolveSubCommand(cmd, rawArgs));
    process.exit(0);
  } else if (rawArgs.length === 1 && rawArgs[0] === "--version") {
    ...
  } else {
    await runCommand(cmd, { rawArgs });
  }
}
```

- `rawArgs.includes("--help")`는 argv 어디에 있든 모두 매칭. `-- --help`도 잡힘.
- `--version`은 `rawArgs.length === 1`이 추가 조건이라 `-- --version`은 영향 안 받지만, 일관성 위해 같은 방식으로 해결.
- citty의 `parseRawArgs`(line 107~)는 minimist 계열이라 `--` 이후를 `_`(positional)로 분리하지만, 위 help 인터셉트가 `runCommand` 호출 자체보다 먼저 일어나므로 minimist 단계가 실행되지 않는다.

## Fix Approach

`src/cli/index.ts`에서 `runMain` 호출 직전에 `process.argv`의 `--` 위치를 보고 wrapper-side(`runMain`에 줄 rawArgs)와 process.argv 자체를 분리한다.

```ts
const argv = process.argv;
const dashDashIdx = argv.indexOf('--', 2); // 2부터 시작: node/script 건너뜀
const wrapperRawArgs =
  dashDashIdx === -1 ? argv.slice(2) : argv.slice(2, dashDashIdx);
runMain(main, { rawArgs: wrapperRawArgs });
```

### 왜 이게 충분한가

- `runMain`의 includes 검사는 `opts.rawArgs`에서만 수행. wrapper-side에 `--help`가 없으면 인터셉트 안 됨.
- `process.argv` 자체는 무손상이므로 `extractDashDashTail()`은 기존 그대로 동작(`process.argv.indexOf('--')` → tail slice).
- citty의 subcommand resolution과 args parsing은 wrapper-side rawArgs만 보면 충분.

### `--`가 없을 때

`dashDashIdx === -1`이면 `wrapperRawArgs = argv.slice(2)`로 fall-back. citty 기존 동작과 100% 동일. 즉 `ditto run with --help`(separator 없음)는 여전히 wrapper help를 표시. 이게 사용자가 기대하는 동작.

## Other Commands Isolation

본 수정은 entry layer 한 곳만 변경한다. 다른 command(`run record`, `verify`, `doctor`, `bridge`, `context`, `work`)의 영향 분석:

| command | `--` 사용? | 영향 | 비고 |
|---|---|---|---|
| `ditto --help` | no | 변화 없음 | 기존 그대로 wrapper help |
| `ditto <sub> --help` | no | 변화 없음 | citty가 subcommand help 표시 |
| `ditto verify <wi> -- <cmd>` | yes | **incidental fix** | 같은 P1 latent bug 존재. 본 수정이 entry-level이라 같이 해결됨. 회귀 fixture는 `run with` 한정(wi_v03cliforward 범위), `verify` 통합 검증은 별도. |
| 다른 command | n/a | 변화 없음 | `--`를 사용하지 않음 |

## Test Surface

신규 fixture는 CLI integration level이어야 함(단위 `runWithProvider` 호출은 entry layer를 거치지 않음).

**Approach**: `Bun.spawnSync(['bun', 'run', 'src/cli/index.ts', ...])`로 실제 process spawn. dist/ditto 빌드 의존 없음. 테스트는 temp 디렉터리에 git init + 최소 work item 생성 후 실행.

**Coverage (3+ case)**:
1. `-- --help`: provider mock 자리에 짧은 sanity binary(예: 시스템에 항상 있는 `true` 같은 단순 명령)을 spawn하도록 mock 구성 어렵 → 실제로는 codex/claude binary가 없는 환경에서도 동작하도록 fixture 설계 필요. 해결: 환경에 codex/claude binary 없으면 spawn 실패하지만 manifest는 생성됨(failure taxonomy). 그 manifest 존재 여부를 검증. provider args가 실제 spawn 호출에서 어떻게 전달됐는지는 manifest의 cwd/profile/exit_code만 보고는 직접 확인 어려움.
   - 대안: fixture가 mock binary script(`tests/fixtures/echo-args.sh`)를 만들어 spawn하게 한다. 다만 adapter는 binary 이름이 'codex' / 'claude' 고정. 우회: PATH를 fixture가 prepend해서 mock 'codex' 실행 파일을 가리키게 한다.
   - 가장 깔끔: PATH override + mock 'codex' executable in temp dir. spawned mock이 자기 argv를 파일에 dump → test가 그 파일에서 `--help`가 들어왔는지 확인.
2. `-- --version`: 같은 방식.
3. wrapper flag 이름 충돌(`-- --output json`): mock이 받은 argv에 `--output json` 포함 확인.

**Negative control (sanity)**:
- `ditto run with --help`(separator 없음)는 여전히 wrapper help 표시 + exit 0 + manifest 생성 안 됨.

## Self-Application (P2 운영 규칙)

본 work item 마감 직전 `ditto run with --verify "<sanity>"`를 실제로 실행해서 `.ditto/runs/<id>/manifest.json`을 남기고 wi_v03cliforward `work-item.json`의 `runs`에 append. provider는 본 환경 기준 codex 사용 가능(smoke test가 통과해 왔으므로). verify command는 본 work item의 핵심 회귀 fixture만 좁게 — 예: `bun test tests/cli/run-with-cli-forward.test.ts`.

## Out Of Scope

- `verify` command의 동일 P1 latent bug 회귀 fixture — 본 work item에서는 incidental fix만, 통합 검증은 별도.
- citty 라이브러리 upstream PR.
- P3(networked profile network-explicit).
- 다른 v0.3 work item retrospective run manifest 보정.
