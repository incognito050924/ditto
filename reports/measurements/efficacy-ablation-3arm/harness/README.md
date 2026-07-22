# 3-arm ablation 측정 하네스 (wi_2607227xx · 이슈 #66)

palimpsest fixture 3-arm ablation(B0 맨 Claude Code / B1 헌장 문서만 / A 풀 DITTO
제품 통째=옛 `bin/ditto`)의 **측정 메커니즘**. 판정 규칙·oracle·프롬프트 등
정본은 여기 없다 — 그것은 사전 등록 번들(`../bundle/`, 별도 노드가 작성·커밋
동결)의 소관이고, 이 하네스는 그 동결본을 digest 검증 후 소비만 한다.

## 구성

| 파일 | 역할 |
|---|---|
| `config.sh` | 중앙 설정(전부 env 오버라이드 가능, 개인 경로 하드코딩 없음) |
| `provision-sandbox.sh` | attempt당 일회용 격리 샌드박스 구성 + arm별 준비(사후조건 fail-closed) |
| `positive-controls.sh` | 양성 대조 5종 — 경계를 **고의로 넘어보고** 실제 차단됨을 증명 |
| `run-session.sh` | headless claude 세션 러너(벽시계 watchdog·증분 영속·완결마커·원장 기록) |
| `ledger.ts` | append-only 시행 원장(단조 id·총량 상한·tamper-evident 해시 체인) |
| `score.sh` | 기계 채점(oracle 재주입·무회귀·무변조) + blind 뷰 + sha 체인 검증 |
| `egress-proxy.ts` | 루프백 allowlist CONNECT 프록시(모든 허용/거부 JSONL 기록) |
| `self-check.sh` | 외부 비용 0으로 검증 가능한 전 메커니즘 셀프테스트 (`self-check.out`에 최근 실행 출력) |

## 사용 흐름 (attempt 1회)

```bash
export ABLATION_PALIMPSEST_SRC=/path/to/palimpsest   # 필수 — 읽기 전용으로만 씀

ID=$(bun ledger.ts next-id)                               # 상한(기본 15) 도달 시 exit 3
SB=$(./provision-sandbox.sh --arm B1 --attempt "$ID" --with-auth)
./positive-controls.sh --sandbox "$SB"                    # run-session이 자동으로도 돌림
./run-session.sh --sandbox "$SB"                          # 45분 상한, TRUNCATED 마킹
./score.sh verify-chain --session "$RUNS/attempt-$ID-B1" --frozen-commit <sha>
./score.sh score  --session "$RUNS/attempt-$ID-B1"
./score.sh blind  --session "$RUNS/attempt-$ID-B1"        # 잔존 arm-시그널이면 exit 4
bun ledger.ts append --event adjudication --attempt "$ID" --status valid   # 또는 invalid --reason …
```

무효 시행 폐기-재실행 방지: 원장은 append-only(라인마다 직전 라인 sha256 체인),
attempt id는 단조 발급, 상한은 유·무효 전체를 센다. truncated 세션 재시도는
**새 attempt id**로만 가능하다(세션 디렉터리 재사용 거부).

## 격리 설계와 근거

실측된 위협(핸드오프 기록: ambient gh 토큰 push 성공, clone 하드링크 공유,
`DITTO_SKIP_HOOKS` 상속 시 arm A 무력화, findRepoRoot 상향 탐색)에 대응:

- **전역 `~/.claude` 무접촉** — 격리 `HOME`+`CLAUDE_CONFIG_DIR` 디렉터리. 전역은
  provision 시 읽기 전용 스냅샷만 뜨고, PC5가 실험 후 mtime+sha 불변을 대조.
- **clone** — `--no-hardlinks`(객체 링크수 1 사후검증) + `git remote remove
  origin`(remote 0 사후검증). 원본 경로는 `ABLATION_PALIMPSEST_SRC` 설정값.
- **env 새니타이즈 = 화이트리스트** — 래퍼가 `env -i`로 시작해 HOME(격리)·
  CLAUDE_CONFIG_DIR(격리)·PATH(시스템+필수 도구 dir만)·TERM·LANG·TMPDIR·프록시
  변수만 주입. 자격증명·`DITTO_SKIP_HOOKS`·`DITTO_AUTOPILOT_BYPASS`는 차단이
  아니라 **존재 자체가 불가능**하다. PC4는 고의로 오염시킨 뒤 부재를 단언.
- **cwd 격리** — clone은 샌드박스 루트 아래, provision이 샌드박스 루트의 전
  조상에 `.git`/`.ditto`가 없음을 단언(findRepoRoot가 실 repo에 닿을 수 없음).

### egress 차단 방식 — 선택 근거

세션은 Anthropic API에 닿아야 하므로 "완전 차단"은 정의상 불가능하다. 선택한
구조는 **2층**:

1. **집행층: `sandbox-exec` SBPL** `(deny network-outbound (remote ip))` +
   루프백만 허용. macOS 26.5에서 실측 검증(외부 curl exit 7, 루프백 exit 0 —
   self-check S2가 매 실행 재측정). 프록시 env를 무시하는 프로세스도 루프백
   밖으로 못 나간다.
2. **관측·허용층: 루프백 allowlist 프록시**(`egress-proxy.ts`) — 유일한 출구.
   `ABLATION_EGRESS_ALLOWLIST`(기본: Anthropic API/OAuth 최소 집합)만 통과,
   모든 허용/거부가 JSONL로 남아 "비허용 egress 0회" 단언의 증거가 된다.

대안 비교: 프록시 env 단독은 협조적 프로세스에만 유효(비협조 우회 가능)라
degrade 모드(`ABLATION_NET_MODE=proxy-env`)로만 두고 fail-closed
(`ABLATION_ALLOW_DEGRADED_NET=1` 명시 시에만 수용·기록). PF 방화벽은 root 필요.

**정직한 한계**: ① DNS 질의는 샌드박스 밖 mDNSResponder 데몬을 거치므로 질의
자체는 나간다(페이로드 egress는 차단). ② `sandbox-exec`는 Apple deprecated —
동작은 실측으로 담보하고 self-check가 매 실행 재검증한다. ③ macOS Keychain의
claude 자격증명은 HOME 격리로 못 막는다 — 이것이 의도된 인증 채널이며(지침·
설정·메모리는 안 실림), `--with-auth`는 파일 자격증명(`.credentials.json`)만
격리 config로 복사하는 단일 명시 예외다. ④ claude CLI의 프록시 env 준수 여부는
파일럿에서 실검증(미검증 항목).

## 번들 계약 (`../bundle/` — 번들 작성 노드가 채움)

```
bundle/
  manifest.sha256      # `shasum -a 256` 형식, 번들-상대 경로(경로에 공백 금지), 전 파일 열거
  rules.md             # keep 판정 규칙(수치 임계·무효시행 술어·재실행 상한·arm 대칭 권한·꼬리사건)
  prompts/task.md      # 공유 프롬프트 (ABLATION_PROMPT_RELPATH)
  claude-flags.txt     # arm 대칭 권한모드/플래그 (선택; manifest에 있으면 digest 검증 후 주입)
  charter/CLAUDE.md    # B1 주입 헌장 스냅샷 (ABLATION_CHARTER_RELPATH)
  arm-a/ditto          # 동결된 옛 제품 실행물 (ABLATION_ARM_A_BIN_RELPATH; landed commit 앵커)
  oracle/<이름>.py     # shadow-fetch 재현 oracle (정확히 1개)
  oracle/DEST          # clone 내 주입 상대경로 (기본 tests/test_ablation_oracle.py)
  answers/…            # A용 정보-동등 고정 답변 세트
```

sha 참조체인 `injected == frozen == committed blob`은 `score.sh verify-chain
--session <dir> --frozen-commit <sha>`가 3변을 전부 검증한다: 디스크==manifest,
manifest==커밋 blob(`git show`), 세션이 실제 소비한 주입 사본==manifest.

## 채점 계약

- **결과(기계)**: 순서 고정 — ① 무변조(기록된 clone HEAD 대비
  `ABLATION_TEST_PATHS` diff 0) → ② 기존 전체 스위트(무회귀) → ③ oracle을
  동결 번들서 digest 검증 후 **재주입**(세션의 봉인 테스트 위조 차단) → ④
  실행: pytest exit 0=green · 1=red · 2/5=error(수집/사용 오류 별도 버킷).
  성공 술어 = green ∧ 무회귀 ∧ 무변조 → `score.json`.
- **과정(blind)**: arm 라벨·attempt id·샌드박스 경로 strip한 뷰 생성 후 엔진
  부산물 패턴(ditto/autopilot/PreToolUse/work-item …) 기계 스캔. 잔존 시그널은
  숨기지 않고 exit 4 + 목록으로 보고 — 처리(무효화/재strip)는 동결 규칙 소관.
- **A arm 실가동 증거**: 설치 확인으로 불충분 — 러너가 트랜스크립트의 hook
  발화 라인(`hooks-observed.jsonl`)·`.ditto` 런타임 상태·실행된 `bin/ditto`
  digest를 세션 산출물에 결부한다.

## 검증 상태

- **self-check 실증(외부 비용 0)**: `bash self-check.sh` — 50항목 전부 통과가
  `self-check.out`에 있다. 커버: 문법(S1)·SBPL 실측(S2)·프록시
  허용/거부/로그(S3)·원장 단조/상한/체인/변조검출(S4)·sha 3변 체인+변조검출
  (S5)·B0/B1 provision 사후조건(S6·S7)·양성대조 5종 전부(S8)·blind
  strip+잔존검출(S9)·watchdog truncation(S10)·완주 세션 영속+digest+원장,
  red-oracle 매핑·무회귀·무변조 채점(S11, 로컬 pytest로 stand-in repo에서).
- **미검증(실비용·파일럿 소관)**: 실 claude headless 세션(프록시 env 준수,
  격리 config 인증, stream-json 훅 이벤트 형태), 실 palimpsest clone, arm A
  `ditto setup`의 샌드박스 내 완주(사후조건 grep은 파일럿에서 실형태로 보정),
  구독 OAuth 비용축.
