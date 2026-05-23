# ADR-0003: Codex 설정용 TOML 파서

- 상태: accepted
- 결정 일자: 2026-05-24
- 결정자: hskim, claude (claude-opus-4-7)
- 관련: ADR-0001 (런타임 스택), wi_v02doctor (자체 파서 도입), wi_v02harden (실제 환경 정확도)

## 컨텍스트

DITTO doctor는 codex 호스트의 두 설정 파일을 읽어 위험 표면과 MCP inventory를 보고한다.

- `.codex/config.toml` (repo-local): `sandbox_mode`, `approval_policy`, `network_access`, `[sandbox_workspace_write]` 같은 권한/sandbox 설정.
- `~/.codex/config.toml` (user): `[mcp_servers.<name>]` 섹션과 그 안의 `command`, `args`, `env` 같은 MCP 서버 정의.

wi_v02doctor에서는 의존성을 최소화하려고 `src/core/hosts/shared.ts`에 자체 `parseTomlSubset` (한 줄 단위 `key = value` 평탄 파싱) 을 두고 사용했다. wi_v02harden 리뷰(2026-05-24)에서 이 파서가 다음을 못 본다는 점이 드러났다.

1. nested section: `[sandbox_workspace_write].network_access = true` 가 root section에 안 들어가서 `inv.raw.network_access`로 안 잡힘 → doctor가 "안전"으로 잘못 보고 (false safety).
2. inline table: `env = { TOKEN = "x", REGION = "kr" }` 가 string으로 들어가서 `env_keys`가 비어 보임 → MCP inventory가 누락.

doctor는 v0.3 provider wrapper preflight의 신뢰 기반이므로, false safety는 다음 단계 결정 전체를 흔든다.

## 결정

- TOML 파서로 [`smol-toml`](https://github.com/squirrelchat/smol-toml) v1.6.1을 runtime dependency로 도입.
- 자체 `parseTomlSubset`은 제거. 대신 `src/core/hosts/shared.ts`에 `parseToml(text): Record<string, unknown>` wrapper 한 함수만 유지.
- 사용 지점은 두 곳: `src/core/hosts/codex.ts`의 `loadPermissions`와 `mcpServersFromToml`. `permission-inventory.ts`의 codex 분기는 wrapper를 통해 nested section을 직접 traverse.

## 근거

- **TOML 1.0 spec 완전 지원**: nested section, inline table, table arrays, datetime 등 codex가 쓸 수 있는 모든 표면을 처리. 자체 파서를 한 번 더 확장하면 다시 "반쪽 파서"가 됨.
- **Dependency-free**: smol-toml 자체가 transitive dep 0. Bun `bun build --compile` single binary에 포함될 때 부담 없음.
- **ESM 친화**: Bun + TypeScript 환경에서 별도 wrapper 없이 `import { parse }`로 사용 가능.
- **가벼움**: minified ~10KB. ADR-0001의 "빠른 startup" 제약과 충돌 없음.
- **활발한 유지보수**: 2024–2025 기간 정기 release. TOML spec 호환성 회귀 보고가 거의 없음.

## 결과

긍정적
- doctor permissions의 nested section 정확도 회복. `[sandbox_workspace_write].network_access=true` 같은 위험 설정을 정확히 finding으로 보고.
- doctor mcp의 inline table 정확도 회복. `env = { ... }` 의 키를 `env_keys`로 정렬해 노출.
- `parseTomlSubset` 약 40줄 제거 → core 코드량 감소.

부정적
- runtime dependency 1개 증가 (이전 0개 → 1개). 다만 `package.json` 직접 의존성은 여전히 작음(citty, zod, smol-toml).
- Bun 단일 binary 빌드 시 smol-toml 코드가 함께 포함되어 binary 크기가 약간 증가 (체감 무시 가능 수준).

## 대안과 폐기 사유

- **자체 `parseTomlSubset` 확장**: inline table과 nested section 처리를 직접 추가. TOML 1.0 spec 전체 호환을 보장하기 어렵고, 다음 codex 버전이 새 문법을 쓰면 또 회귀. 유지보수 비용이 lib보다 큼.
- **`@iarna/toml`**: 오래된 표준 lib이나 유지보수가 거의 정지. ESM 호환성도 약함.
- **`@ltd/j-toml`**: 성능이 우수하지만 CommonJS 중심이고 API 표면이 커서 Bun ESM 환경에 부담.

## 되돌리기 비용

- smol-toml → 다른 lib: 작음. 사용 지점이 `src/core/hosts/shared.ts:parseToml` 한 함수와 `codex.ts`의 두 호출자뿐. wrapper만 교체하면 됨.
- smol-toml → 자체 파서로 복귀: 매우 큼. 위에 적은 false safety가 회귀.

## 검증

- `bun add smol-toml` 후 `package.json` dependencies에 등재됨.
- `bun test tests/doctor/permissions.test.ts tests/doctor/mcp.test.ts` 통과. 특히 nested + inline 회귀 케이스 2건이 신규 추가됨.
- `bun test` 전체 109 pass(이전 107 + 신규 2).
