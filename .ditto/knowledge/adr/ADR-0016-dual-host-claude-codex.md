# ADR-0016: Dual-host 아키텍처 — DITTO는 Claude Code와 Codex 두 호스트에서 동작한다

- 상태: superseded by ADR-20260722-claude-code-only-host
- 결정 일자: 2026-06-13
- 결정자: hskim, claude
- 관련: ADR-0008(HostAdapter 교체축 정립 — 이 ADR이 그 실현), ADR-0011(배포 횡단축), ADR-0012(3계층 격리·dist/plugin 조립), `src/core/hosts/types.ts`(HostAdapter), `src/core/hosts/codex.ts`·`claude-code.ts`, `src/hooks/io.ts`, `src/hooks/envelope.ts`, `scripts/build-codex-plugin.mjs`·`build-plugin.mjs`, `reports/design/dual-host-surface-adapter-plan.md`(§9 진행상태), `reports/design/dual-host-codex-fact-verification.md`, `reports/design/dual-host-test-methods.md`, wi_260613f9d·wi_260613ob2·wi_2606139rs

## 컨텍스트

DITTO는 이제 단일 호스트(Claude Code)가 아니라 **Claude Code와 Codex 두 호스트**에서 동작하는 제품이다. ADR-0008이 `HostAdapter`로 "에이전트 호스트 축"을 추상화하고 추가 호스트-추상 기계는 보류했는데, 이 ADR은 그 축 위에 Codex를 실제 두 번째 호스트로 올린 결과를 구조 결정으로 고정한다. 앞으로 hook·surface·호스트를 건드리는 모든 개발은 이 구조를 전제로 한다.

## 결정 — 개발 시 지켜야 할 구조

### D1 — 공통 코어 + per-host 어댑터

호스트-무관 코어(거버넌스·게이트·오케스트레이션) 위에 `HostAdapter`(`src/core/hosts/types.ts`)가 host별 차이를 흡수한다. host는 `'claude-code' | 'codex'` 두 값. **새 코드는 host를 하드코딩하지 않는다** — `input.host`로 분기하고, 미지정 시 `'claude-code'`로 안전 default하되 그 사실을 주석/계약으로 남긴다.

### D2 — host divergence는 정확히 두 지점

1. **repoRoot 출처** (`src/hooks/io.ts`): Claude는 `CLAUDE_PROJECT_DIR`, Codex는 이벤트 `cwd`. host별 `resolveRepoRoot`로만 해석한다.
2. **파일 편집 도구 의미**: Claude는 `Write|Edit|MultiEdit` + `tool_input.file_path`. Codex는 `tool_name="apply_patch"` + `tool_input.command`(패치 본문). Codex 편집의 경로는 `envelope.parseApplyPatchPaths`가 `*** Add/Update/Delete File:`·`*** Move to:` 헤더에서 추출하고, **같은** secret/scope-out/forbidden_scope/lease 게이트와 edit-evidence를 모든 mutated path에 적용한다(`pre-tool-use.ts` apply_patch 분기, `post-tool-use.ts`). hook stdin/stdout shape와 prompt/Bash/session_id 필드는 두 호스트가 동일.

### D3 — 빌드·배포는 host별로 분리, 절대 교차 금지

- `scripts/build-plugin.mjs` → `dist/plugin/`(Claude), `scripts/build-codex-plugin.mjs` → `dist/codex-plugin/`(Codex). 두 빌드는 서로의 출력 디렉터리를 건드리지 않는다.
- **배포 seam(OBJ-1)**: repo `hooks/hooks.json`(Claude 소스)은 `--host` 없이 둔다. Codex 빌드가 **복사본** hooks.json의 각 `ditto hook` 명령에 `--host codex`를 부착(`injectCodexHost`)해, 실 Codex 런타임에서 host가 `claude-code`로 default되어 apply_patch 안전게이트가 미발화(false-green)되는 일을 막는다. Claude 소스는 byte-identical 유지.

### D4 — surface projection은 단방향·결정론

`agents/*.md`(Claude 정의) → `dist/codex-plugin/.codex/agents/<name>.toml`(Codex custom-agent)로 build가 단방향 투영한다(`agent-projection.ts`). read-only agent는 `sandbox_mode="read-only"`로 매핑(per-tool 충실도는 보존 안 됨 — TOML 주석에 `unverified` 명시). 같은 projected name 충돌은 build error(silent overwrite 금지).

### D5 — Codex 공식 발견 경로

plugin manifest = `.codex-plugin/plugin.json`(root에 skills/·hooks/·.mcp.json). marketplace = `$REPO/.agents/plugins/marketplace.json`(+ `~/.agents/plugins/` + legacy `$REPO/.claude-plugin/marketplace.json`). **비공식 `.codex/plugins`는 발견 경로가 아니다** — surface 인벤토리에서 스캔하지 않는다(OBJ-5).

### D6 — 개발 규칙 (체크리스트)

hook·surface·host-touching 코드를 추가/수정할 때:
- host를 하드코딩하지 말 것(특히 `'claude-code'` 문자열). `input.host` 사용.
- Codex 경로(apply_patch·cwd repoRoot)를 함께 처리하거나, 못 하면 명시적으로 default + 사유 기록.
- 두 host fixture를 모두 통과시킬 것(`tests/host/claude/*`·`tests/host/codex/*`). handler 단위뿐 아니라 **배포 seam**(빌드된 매니페스트 명령으로 구동)도 검증.
- 테스트는 `DITTO_SKIP_HOOKS`를 spawn env에서 제거해 격리(kill-switch 누출로 hook bypass 방지).

## 검증 상태 (정직)

- **검증됨**: 두 host의 surface 인벤토리·hook handler 단위·apply_patch 게이트·배포 seam·projection은 fixture로 green(1912 pass). Claude는 실 호스트에서 라이브 동작.
- **미검증(층위③, Codex 트랙)**: 실 `codex` 바이너리가 plugin·hook·agent를 실제 로드·발화하는지, M5 setup의 Codex 설치 분기, `${CLAUDE_PLUGIN_ROOT}` 치환의 실 Codex 동작. 재현법은 `dual-host-test-methods.md`, 잔여는 plan §9.

## 대안 (기각)

- 추가 host-추상 기계 — ADR-0008이 보류(provider 슬롯이 이미 stack-agnostic); 이 ADR도 `HostAdapter` 두 지점 분기로 충분하다고 본다.
- Claude installer를 Codex까지 parameterize — host별 빌드/문서 분리가 더 단순(D3).
- 단일 hooks.json에 host 자동감지 — 배포 seam은 build가 복사본을 재작성하는 쪽이 repo 소스 불변·결정론적(D3).

## 철회/재검토 조건

- Codex 공식 plugin/hook/agent 계약이 바뀌면 → D2/D5 재검토(`dual-host-codex-fact-verification.md` 재검증).
- 세 번째 host가 생기면 → D1 어댑터 인터페이스가 2-host 가정에 새는지 점검(현재 `host` enum 2값 전제).
- 층위③ 라이브 검증에서 fixture-green과 실 동작이 갈리면 → 해당 D 항목을 실측 기준으로 개정.
