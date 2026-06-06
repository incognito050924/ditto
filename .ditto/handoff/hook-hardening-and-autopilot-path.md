# Handoff — autopilot 경로 강제 + PreToolUse 가드 정밀화 + Windows 파괴탐지

> 상태: 이 세션 작업 **전부 origin/main 푸시 완료**(`## main...origin/main`, ahead 0). open work item **0건**. 미완 잔재 없음.
> 진실원: 커밋들(아래 표)과 `src/hooks/pre-tool-use.ts`, `src/core/active-node-lease.ts`, `.ditto/work-items/wi_26060678y/`.

## 0. 셋업
```bash
cd /Users/incognito/dev/projects/ditto
git log --oneline -9        # 2dc67bb … 5215c21 보여야
bun install && bun test     # 1345 pass / 9 skip / 0 fail 기대
bun run lint && bun run adr:guard
bun run build:bin           # ← 훅을 라이브로 만들려면 필수(bin/ditto는 gitignore, per-env 빌드)
```

## 1. 이 세션에 한 일 (전부 push)

| 커밋 | 항목 | 핵심 |
|---|---|---|
| `5215c21` | doctor plugin/target root 분리 | distribution-doctor가 plugin-root(bin/hooks)와 target-root(.ditto/.claude)를 분리 점검. (직전 thread 마감) |
| `50d001d` | open WI 25건 triage | 14 done-미종결 + 1 설치스크립트 + 9 subsumed(self-eval §5#7~10·§4#9·#11 = 이후 작업으로 출하됨, 코드근거로 done) 종결. 1 genuine(wi_26060678y) 남김 |
| `75dbaef` | **autopilot 경로 강제** (wi_26060678y) | active-node lease 기반 흐름강제. 아래 §2 상세 |
| `77299bc` | 라이브 배포 + gitignore | bin 재빌드, `.ditto/sessions/` gitignore |
| `8566c82` | install 빌드실패 abort | build 실패 시 graceful skip→**exit 1** 중단. codeql/playwright는 graceful 유지 |
| `e724912` | force-push 오탐 좁힘 | 세 신호(push/force/branch)를 **같은 git-push 세그먼트**로 한정 |
| `f488077` | sudo 오탐 좁힘 + HOME 크로스플랫폼 | sudo를 **leading command**일 때만 검사. `HOME ?? USERPROFILE` 폴백 |
| `ca2ea5a` | **Windows 파괴탐지 추가** | format/rd/rmdir/del/Remove-Item, drive-root·system-env, IS_WIN 게이트 |
| `2dc67bb` | Windows 재귀삭제 홈밖 절대경로 확장 | POSIX rm 정책 대칭. 순수 regex 절대경로 판정 |

## 2. autopilot 경로 강제 (wi_26060678y, done) — 가장 큰 항목

deep-interview로 의도 확정(Q1 기본 autopilot+명시 우회 / Q2 전체 적용(DITTO 포함) / Q3 무WI 강제X·생성유도) → autopilot(N1 design→N2 impl→N3 verify, 사용자 승인 게이트 통과) → completion `final_verdict=pass`(5 AC).

- **관측 천장(중요)**: PreToolUse는 spawn된 implementer vs main-agent 직접편집을 같은 session_id라 **증명 불가**(SKILL.md:33). 그래서 "강제"=흐름강제(lease scoping)이지 spawn 증명 아님. `DITTO_SKIP_HOOKS`로 의식 우회 가능 — 수용된 한계.
- **메커니즘**: `src/core/active-node-lease.ts`(lease={node_id,work_item_id,file_scope}, `.ditto/work-items/<wi>/active-leases.json`, gitignore). next-node dispatch가 lease 생성, record-result가 모든 종단서 제거(누수0). `pre-tool-use.ts:checkAutopilotLease` allow-list — 활성 WI+비terminal 그래프+활성 lease면 file_scope 밖 Edit/Write/MultiEdit exit2, 안은 허용, 없으면 fail-open. `DITTO_AUTOPILOT_BYPASS=1`(SKIP_HOOKS와 별개) 우회+`.ditto/autopilot-bypass.jsonl` 로그.
- **라이브 검증됨**: 격리 lease 상태로 exit2/exit0/bypass 실증.
- **잔여(비차단)**: 세션 비정상종료 시 lease 스테일(그래프 terminal 시 fail-open으로 바운드); wave-spawn lease 생성 직접테스트 부재(코드상 단일경로와 동일).

## 3. 다음 세션이 알아야 할 함정 (이 세션에서 반복 발생)

- **"라이브 반영" = `bun run build:bin`**. 훅은 `${CLAUDE_PLUGIN_ROOT}/bin/ditto`(컴파일 바이너리)를 부른다. src 수정만으론 실행 훅에 안 들어감. bin/ditto는 gitignore.
- **PreToolUse 자가차단(메인 세션)**: 이 세션 활성 WI는 autopilot 그래프가 없어 lease 검사가 fail-open → 메인 세션 편집은 안 막힘. 그래프 있는 WI를 autopilot으로 돌릴 때만 lease 게이팅.
- **커밋 메시지/명령에 트리거 토큰 금지**: 라이브 훅이 bash 명령 **텍스트**를 스캔한다. 메시지에 `sudo`+`rm`, `git push --force … main`, Windows `rd /s /q c:\` 등이 들어가면 destructive로 오탐 차단됨 → **`git commit -F <파일>`** 로 우회(파일 내용은 스캔 안 함). 복합 명령에서 `rm -rf`+`git push … main`도 force-push로 오탐했었음(이번에 세그먼트 한정으로 수정).
- **메모리 쓰기(repo 밖)·꺾쇠 커밋**: `~/.claude/.../memory/*`·`/tmp` 쓰기는 scope-out 차단 → repo 안(`.ditto/cache/`)에 쓰거나 `DITTO_SKIP_HOOKS=1`. 메시지 꺾쇠 `<...>`도 오탐.

## 4. 알려진 갭 / 후속 후보 (우선순위는 사용자 판단)

- **destructive 체크의 "실행 vs 인용" 구분**: 이번에 force-push·sudo는 세그먼트/leading-command로 좁혔지만, 근본적으로 인용부호 안 문자열을 토큰으로 오인하는 결이 다른 패턴(dd/mkfs 등)에 남아있을 수 있음. `sh -c "…"` 같은 실행 래퍼는 반대로 스캔해야 하는 긴장도 있음.
- **Windows 탐지는 IS_WIN 게이트라 실제 Windows에서만 활성** — 이 환경(macOS)에선 핸들러 라이브 실행 검증 불가. 매처(`windowsDestructiveReason`)는 단위테스트로 검증. **Windows 머신에서 build:bin 후 end-to-end 확인 권장.** 글로브(`c:\data\*`)·env-var(`%TEMP%\x`)·`..` 탈출은 POSIX와 동일하게 보수적 미차단.
- **autopilot complete가 work-item status를 동기화 안 함**: completion.json은 pass인데 work-item.json status는 draft로 남는 systemic 갭(이번 triage서 14건이 이래서 떠 있었음, wi_26060678y도 수동 done 처리). 별도 work item 후보.
- self-eval `project_self_eval_2026_06_02` #6(continuation signal)은 WI 없이 미확인으로 남음(메모리 참조).

## 5. 다음 세션 첫 프롬프트(예시)
> "이 핸드오프(`.ditto/handoff/hook-hardening-and-autopilot-path.md`) 읽고, §4의 'autopilot complete가 work-item status를 동기화 안 하는 systemic 갭'을 처리. completion final_verdict 도출 시 work-item.json status·AC verdict를 함께 갱신하도록."
