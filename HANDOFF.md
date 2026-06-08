# HANDOFF — ditto 배포 + 환경 초기화 (2026-06-08)

다른 PC에서 이어받기용. **이어받은 뒤 삭제해도 됨**(세션 핸드오프, 영구 문서 아님).

## 이번 세션에 한 일 (둘 다 완료·배포됨)

### 1) github-소스 배포 재설계 (work item wi_260608j2p)
`/doctor`의 `⚠ 1 setup issue: plugins` 추적 → 원인은 directory-소스 마켓플레이스의 startup `file://` 갱신 버그. 배포 모델을 github 소스로 전환.
- 54MB `bun --compile` 바이너리 → ~984KB **bun 번들**(`scripts/build-bin.mjs` 공유 헬퍼; `build`·`build:bin` 둘 다 번들, `build:bin:win` 제거). **런타임=bun 전용**(CLI가 `Bun.*` 전역 다수 사용 → `--target=node` 불가).
- **Layout A**: repo 루트 = 플러그인 루트, marketplace `source:"./"`, `bin/ditto`(번들) 커밋(`.gitignore`에서 un-ignore).
- `install-plugin.mjs`의 `file://` 마켓플레이스 등록 제거. `distribution-doctor`는 `plugin_enabled`→`plugin_surface_present`로 회귀 수정.
- skills/agents 실행 호출부 13개: bare `ditto` → `"${CLAUDE_PLUGIN_ROOT}/bin/ditto"` (Claude가 plugin bin을 PATH **끝**에 append → macOS `/usr/bin/ditto`(OS 유틸) shadow 회피. `${CLAUDE_PLUGIN_ROOT}`는 skill/agent 본문 **inline 치환**, 셸 env 아님).

### 2) `ditto setup`/`teardown` 환경 초기화 (work item wi_260608pcw, final_verdict=pass)
ditto 로드된 임의 프로젝트에서 헌장·.ditto를 재현하되 사용자 편집 보존.
- `src/core/managed-resource.ts`: `<!-- ditto:managed -->` 블록 strip/재발행 + `*.ditto_bak` 백업(최초 원본) + corruption guard(무손실).
- `src/core/resource-routing.ts`: `GLOBAL_` 접두→`~/.claude` / 아니면 프로젝트 루트(데이터 주도).
- `src/core/settings-allowlist.ts`: `Bash(ditto:*)` add/remove.
- `src/core/{setup,teardown}.ts` + CLI: setup=discover→route→merge+백업+`.ditto`스캐폴드+allowlist(멱등, self-host no-op); teardown=블록 strip(증분 보존)+백업 폴백+allowlist 제거(`.ditto` 보존).
- `resources/managed/{CLAUDE,AGENTS}.md`: 설치 페이로드. **build가 canonical 루트 `AGENTS.md`에서 동기화**(drift 방지) — 커밋 전 rebuild 필요(`bin/ditto`와 동일 규율).

## 배포 상태 (검증됨)
- github 마켓플레이스 라이브: `claude plugin marketplace add incognito050924/ditto` (source=github), `claude plugin install ditto@ditto-local` → enabled, 번들 동작.
- 커밋 push 완료: `fdb98c3`(마켓플레이스 description) · `ad554da`(배포 재설계) · `5616f46`(setup/teardown) → `origin/main`.

## 새 PC 셋업 (이어받을 때)
```bash
git pull                                   # 코드 + 이 핸드오프
bun install                                # deps
bun run build:bin && bun run build && bun link   # 터미널 `ditto`를 현재 빌드로 (setup/teardown 포함)
# 확인: ditto --help 에 init|setup|teardown 보이면 OK
```
- macOS 주의: 터미널 bare `ditto`는 `/usr/bin/ditto`(OS 유틸)와 충돌 가능 → `bun link`로 깐 `~/.bun/bin/ditto`(PATH 앞)가 이겨야 함. (skills/agents는 `${CLAUDE_PLUGIN_ROOT}`로 이미 무관.)
- ditto를 임의 프로젝트에 쓰려면: plain `claude`(github 설치본 자동 로드) 또는 로컬 dev는 `claude --plugin-dir <repo>` (이전 alias `ditto-cc`) → 그 프로젝트에서 **`ditto setup` 1회**로 헌장·`.ditto`·allowlist 세팅. ditto repo 자신은 setup self-skip.

## 핵심 사실
- 플러그인 로드 ≠ 컨텍스트 복사. 컨텍스트 복사는 명시적 `ditto setup`(deep-interview 결정: 훅 자동 아님). 로드만 해도 UserPromptSubmit 훅은 prime directive 주입.
- 사용자 컨텍스트 보존 = in-file 마커(별도 USER 파일 없음). git 비의존 복구는 `*.ditto_bak`.
- teardown 의미 A: 블록만 strip(증분 보존), 백업은 corruption 폴백.

## 남은 follow-up (비블로커)
- (선택) `GLOBAL_CLAUDE.md`/`GLOBAL_AGENTS.md` 실제 콘텐츠 작성(라우팅 규칙은 이미 구현).
- (선택) `claude plugin uninstall`과 `ditto teardown` 연동(자동 복구).
- 두 work item 모두 완료(`final_verdict=pass`). 추가 작업은 새 요구가 있을 때.
