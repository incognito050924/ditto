import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { defineCommand } from 'citty';
import { type AgentVariant, writeAgentVariants } from '~/core/agent-variants';
import { seedGithubConfigIfAbsent } from '~/core/ditto-config';
import { resolveRepoRootForCreate } from '~/core/fs';
import { claudeCodeHostAdapter } from '~/core/hosts/claude-code';
import { codexHostAdapter } from '~/core/hosts/codex';
import { fileExists } from '~/core/hosts/shared';
import { detectLspLanguages } from '~/core/provision/lsp-detect';
import {
  type MemorySeparateMode,
  type MemorySeparateResult,
  defaultMemorySeparateDeps,
  separateMemoryRepo,
} from '~/core/provision/memory-separate';
import { type ProvisionerRegistry, defaultRegistry } from '~/core/provision/provisioner';
import { loadResolvedRecipe } from '~/core/recipe/load';
import { type ResourceOutcome, type SetupHost, type SetupResult, setup } from '~/core/setup';
import type { DittoConfigGithub } from '~/schemas/ditto-config';
import type { Recipe } from '~/schemas/recipe';
import { resolveResourcesDir } from '../resources';
import { RUNTIME_ERROR_EXIT, writeError, writeHuman } from '../util';
import { runAgentLinkStep } from '../wizard/agent-link-step';
import type { PromptIO } from '../wizard/prompt';
import { createStdioPromptIO } from '../wizard/prompt-io';
import {
  type ProvisionAction,
  type ProvisionOutcome,
  runProvisionStep,
} from '../wizard/provision-step';
import { runSetupWizard } from '../wizard/setup-wizard';

/** 비대화 도구 provisioning: 강제 non-TTY io로 추론된 빠진 도구를 프롬프트 없이 설치. */
async function provisionToolsNonInteractive(projectRoot: string): Promise<void> {
  const io: PromptIO = {
    isTTY: false,
    ask: async () => '',
    write: (t) => {
      process.stdout.write(t);
    },
  };
  const summary = await runProvisionStep(io, defaultRegistry(), projectRoot, {
    detect: detectLspLanguages,
  });
  writeHuman('tools:');
  for (const o of summary.outcomes) writeHuman(`  ${o.action}\t${o.message}`);
  if (summary.unservicedLanguages.length > 0) {
    writeHuman(`  감지됐으나 서버 미등록: ${summary.unservicedLanguages.join(', ')}`);
  }
}

/**
 * Headless tools stage (ac-3). Drive provisioning from the recipe's EXPLICIT tool
 * ids — resolve each id against the registry (single-instance tools first, then
 * LSP servers), install absent ones — bypassing the wizard's detect+multiSelect.
 * Reuses the Provisioner building blocks (resolveExisting/install); fail-soft.
 */
async function provisionRecipeTools(
  registry: ProvisionerRegistry,
  toolIds: string[],
): Promise<ProvisionOutcome[]> {
  const outcomes: ProvisionOutcome[] = [];
  for (const id of toolIds) {
    const p = registry.tools.get(id) ?? registry.lsp.get(id);
    if (!p) {
      outcomes.push({ id, action: 'skipped', message: `${id}: 등록된 provisioner 없음 — 건너뜀` });
      continue;
    }
    if ((await p.resolveExisting()) !== null) {
      outcomes.push({ id, action: 'already-present', message: `${p.label}: 이미 설치됨` });
      continue;
    }
    const r = await p.install();
    const action: ProvisionAction =
      r.status === 'installed'
        ? 'installed'
        : r.status === 'already-present'
          ? 'already-present'
          : 'failed';
    outcomes.push({
      id,
      action,
      message: `${p.label}: ${r.message}`,
      ...(r.manual ? { manual: r.manual } : {}),
    });
  }
  return outcomes;
}

/** Injected building blocks for the headless recipe drive (test-seam). */
export interface RecipeSetupDeps {
  setup: (host: SetupHost) => Promise<SetupResult>;
  provisionTools: (toolIds: string[]) => Promise<ProvisionOutcome[]>;
  writeVariants: (variants: AgentVariant[]) => Promise<{ written: string[]; skipped: string[] }>;
  separateMemory: (mode: MemorySeparateMode) => Promise<MemorySeparateResult>;
  seedGithubConfig: (
    github: DittoConfigGithub,
  ) => Promise<{ seeded: boolean; reason: 'absent' | 'existing' | 'malformed' }>;
}

export interface RecipeSetupSummary {
  host: SetupHost;
  setup: SetupResult;
  tools: ProvisionOutcome[];
  agents: { written: string[]; skipped: string[] };
  memory: { mode: MemorySeparateMode | 'in-project'; result: MemorySeparateResult | null };
  // recipe.backlog → personal github config bootstrap-once seed (wi_260629vnt). reason
  // discloses why (no silent seed): seeded | kept-existing | malformed-skipped | no-backlog.
  // `reason` is absent on a caught write/IO failure (graceful degradation, ADR-0018).
  githubSeed: { seeded: boolean; reason?: 'absent' | 'existing' | 'malformed' | 'no-backlog' };
}

/**
 * A recipe is "present" when an explicit `--recipe` path was given OR a discovered
 * recipe resolved to at least one set field (ac-3). An empty resolved recipe (no
 * source set anything) is ABSENT, so setup falls through to the legacy paths
 * unchanged (ac-6).
 */
export function isRecipePresent(cliPath: string | undefined, resolved: Recipe): boolean {
  return cliPath !== undefined || Object.keys(resolved).length > 0;
}

/**
 * Drive all four `ditto setup` stages headlessly from a resolved recipe (ac-3):
 * host(setup) + tools(provision) + agent-link(writeVariants) + memory(separate) —
 * no prompts, driven by recipe values. The interactive multiselect is bypassed:
 * the recipe's `agents[]` ARE the chosen links and `tools[]` ARE the chosen tools.
 *
 * minimal-increment (ac-3): `memory: submodule` only prints manual instructions
 * (it cannot be automated without a pre-existing remote), so a headless recipe
 * MUST reject it rather than report a false success. Only the fully-automatable
 * `gitignore` mode runs headless. The guard fails closed BEFORE any side effect.
 */
export async function runRecipeSetup(
  recipe: Recipe,
  host: SetupHost,
  deps: RecipeSetupDeps,
): Promise<RecipeSetupSummary> {
  if (recipe.memory === 'submodule') {
    throw new Error(
      'headless recipe는 memory: submodule를 자동화할 수 없다(원격 선행 필요) — memory: gitignore를 쓰거나 대화형 setup으로 분리하라',
    );
  }

  const setupResult = await deps.setup(host);

  const tools =
    recipe.tools && recipe.tools.length > 0 ? await deps.provisionTools(recipe.tools) : [];

  const variants: AgentVariant[] = (recipe.agents ?? []).map((a) => ({
    name: a.name,
    role: a.role,
    description: '',
    match: [],
  }));
  const agents =
    variants.length > 0 ? await deps.writeVariants(variants) : { written: [], skipped: [] };

  let memory: RecipeSetupSummary['memory'] = { mode: 'in-project', result: null };
  if (recipe.memory === 'gitignore') {
    memory = { mode: 'gitignore', result: await deps.separateMemory('gitignore') };
  }

  // GitHub backlog seed — bootstrap-once, AFTER deps.setup so the `.ditto/.gitignore`
  // (ignoring local/) already exists and the personal coordinate config never leaks as
  // git-addable (C3). A seed write failure (EACCES/ENOSPC) must NOT break setup — the
  // seed is a convenience, not a gate (C2, ADR-0018 우아한 강등): catch, disclose, continue.
  let githubSeed: RecipeSetupSummary['githubSeed'] = { seeded: false, reason: 'no-backlog' };
  if (recipe.backlog) {
    try {
      githubSeed = await deps.seedGithubConfig(recipe.backlog);
    } catch {
      githubSeed = { seeded: false };
    }
  }

  return { host, setup: setupResult, tools, agents, memory, githubSeed };
}

/**
 * "couldn't refresh" notice lines for any AGENTS.md whose ditto-charter region was
 * user-edited (status `unrecognized`) — setup left it untouched rather than clobber
 * the edit. The already-current no-op (`up-to-date`) produces NO notice. Surfaced in
 * every setup print path (recipe / non-interactive / wizard).
 */
export function charterRefreshNotices(resources: ResourceOutcome[]): string[] {
  return resources
    .filter((r) => r.status === 'unrecognized')
    .map(
      (r) =>
        `charter refresh: ${r.destPath}의 ditto 차터 영역이 수정되어 있어 새로고침을 건너뜀 — 파일은 그대로 두었습니다. 최신 차터를 직접 반영하거나 원본 차터로 되돌린 뒤 다시 setup을 실행하세요.`,
    );
}

function parseSetupHost(value: unknown): SetupHost {
  if (value === undefined || value === null || value === '') return 'claude-code';
  if (value === 'claude-code' || value === 'codex' || value === 'both') return value;
  throw new Error(`invalid --host ${String(value)} (expected claude-code|codex|both)`);
}

function includesCodex(host: SetupHost): boolean {
  return host === 'codex' || host === 'both';
}

export async function resolveCodexPluginRoot(
  resourcesDir: string,
  projectRoot: string,
): Promise<string> {
  const currentPluginRoot = resolve(resourcesDir, '..', '..');

  const sibling = join(dirname(currentPluginRoot), 'codex-plugin');
  if (await fileExists(join(sibling, '.codex-plugin', 'plugin.json'))) return sibling;

  const currentDist = join(currentPluginRoot, 'dist', 'codex-plugin');
  if (await fileExists(join(currentDist, '.codex-plugin', 'plugin.json'))) return currentDist;

  const projectDist = join(projectRoot, 'dist', 'codex-plugin');
  if (await fileExists(join(projectDist, '.codex-plugin', 'plugin.json'))) return projectDist;

  if (await fileExists(join(currentPluginRoot, '.codex', 'agents'))) return currentPluginRoot;

  return currentPluginRoot;
}

/**
 * 프로젝트 `.claude/agents`에서 agent를 발견한다(claude-code 호스트, agent only).
 * description은 파일 frontmatter의 `description:` 한 줄을 best-effort로 읽는다 — heuristic은
 * name만으로도 동작하므로 없으면 빈 문자열.
 */
async function discoverClaudeAgents(
  projectRoot: string,
): Promise<{ name: string; description: string }[]> {
  const inventory = await claudeCodeHostAdapter.loadSurfaceInventory(projectRoot);
  const agents = inventory.localSurfaces.filter((s) => s.kind === 'agent');
  const out: { name: string; description: string }[] = [];
  for (const a of agents) {
    let description = '';
    try {
      const text = await Bun.file(a.path).text();
      const m = /^description:\s*(.+)$/m.exec(text);
      if (m) description = (m[1] ?? '').trim();
    } catch {
      // 디렉터리형 agent 등 파일 읽기 실패는 무시 — name만으로 추천.
    }
    out.push({ name: a.id, description });
  }
  return out;
}

/**
 * 프로젝트 `.codex/agents`에서 사용자 커스텀 codex agent를 발견한다(codex 호스트, agent only).
 * claude와 달리 codex는 ditto 자체 agent를 프로젝트 `.codex/agents`에 직접 복사하므로
 * (installCodexAgents), provenance 헤더(`ditto agent-projection`)가 있는 번들 agent는 제외해
 * 사용자가 직접 쓴 agent만 surface한다. description은 TOML `description = "..."` 한 줄을
 * best-effort로 읽는다(heuristic은 name만으로도 동작) — 멀티라인/이스케이프는 미파싱, 빈 문자열.
 */
export async function discoverCodexAgents(
  projectRoot: string,
): Promise<{ name: string; description: string }[]> {
  const inventory = await codexHostAdapter.loadSurfaceInventory(projectRoot);
  const agents = inventory.localSurfaces.filter((s) => s.kind === 'agent');
  const out: { name: string; description: string }[] = [];
  for (const a of agents) {
    let text = '';
    try {
      text = await Bun.file(a.path).text();
    } catch {
      // 파일 읽기 실패는 무시 — name만으로 추천.
    }
    if (/ditto agent-projection/.test(text)) continue; // ditto 자체 번들 agent 제외
    let description = '';
    const m = /^description\s*=\s*"([^"]*)"\s*$/m.exec(text);
    if (m) description = (m[1] ?? '').trim();
    out.push({ name: a.id, description });
  }
  return out;
}

/**
 * 설치 대상 host에 맞는 프로젝트 agent를 발견한다 — claude-code는 `.claude/agents`, codex는
 * `.codex/agents`, both는 둘을 합치되 이름 충돌은 claude 우선(먼저 발견)으로 dedupe한다.
 */
export async function discoverProjectAgents(
  projectRoot: string,
  host: SetupHost,
): Promise<{ name: string; description: string }[]> {
  const claude =
    host === 'claude-code' || host === 'both' ? await discoverClaudeAgents(projectRoot) : [];
  const codex = host === 'codex' || host === 'both' ? await discoverCodexAgents(projectRoot) : [];
  const seen = new Set(claude.map((a) => a.name));
  return [...claude, ...codex.filter((a) => !seen.has(a.name))];
}

/** 대화형 wizard 흐름: 의존을 실제 구현으로 묶어 runSetupWizard를 돌리고 요약을 출력한다. */
async function runWizard(resourcesDir: string, projectRoot: string): Promise<void> {
  const io = createStdioPromptIO();
  try {
    const result = await runSetupWizard(io, {
      projectRoot,
      sourceRoot: projectRoot,
      setup: async (host) =>
        setup({
          resourcesDir,
          projectRoot,
          homeDir: homedir(),
          ...(process.env.CODEX_HOME ? { codexHome: process.env.CODEX_HOME } : {}),
          now: new Date(),
          host,
          ...(includesCodex(host)
            ? { pluginRoot: await resolveCodexPluginRoot(resourcesDir, projectRoot) }
            : {}),
        }),
      runProvision: (promptIo) =>
        runProvisionStep(promptIo, defaultRegistry(), projectRoot, { detect: detectLspLanguages }),
      separateMemory: (mode) => separateMemoryRepo(defaultMemorySeparateDeps(projectRoot), mode),
      runAgentLink: (promptIo, host) =>
        runAgentLinkStep(promptIo, {
          loadAgents: () => discoverProjectAgents(projectRoot, host),
          writeVariants: (variants) => writeAgentVariants(projectRoot, variants),
        }),
    });

    writeHuman(`setup: installed into ${projectRoot} (host=${result.host})`);
    writeHuman(
      `.ditto/: ${result.setup.scaffold.alreadyInitialized ? 'already initialized' : 'created'} · allowlist: ${
        result.setup.allowlistApplied ? result.setup.allowlistPath : 'skipped'
      }`,
    );
    for (const line of charterRefreshNotices(result.setup.resources)) writeHuman(line);
    writeHuman('tools:');
    for (const o of result.provision.outcomes) writeHuman(`  ${o.action}\t${o.message}`);
    if (result.provision.unservicedLanguages.length > 0) {
      writeHuman(`  감지됐으나 서버 미등록: ${result.provision.unservicedLanguages.join(', ')}`);
    }
    if (result.agents.discovered.length > 0) {
      writeHuman('project agents:');
      for (const a of result.agents.discovered) writeHuman(`  ${a.name} → ${a.role}`);
      writeHuman(
        `  linked: ${result.agents.written.length ? result.agents.written.join(', ') : '(none)'}${
          result.agents.skipped.length
            ? ` · skipped(existing): ${result.agents.skipped.join(', ')}`
            : ''
        }`,
      );
    }
    if (result.memory.result) {
      writeHuman(`memory: ${result.memory.mode} — ${result.memory.result.message}`);
      for (const line of result.memory.result.manual ?? []) writeHuman(`  ${line}`);
    } else {
      writeHuman('memory: 프로젝트 git에 포함(기본)');
    }
    // 안전 훅은 토글이 아니라 플러그인 전역으로 항상 활성(hooks/hooks.json, default ALLOW).
    // per-project on/off 설정이 없으므로 질문 대신 활성 사실 + 우회법만 고지한다.
    writeHuman(
      'safety hook: PreToolUse 활성(플러그인 전역) — 정상 명령 오탐 시 DITTO_SKIP_HOOKS=1 prefix',
    );
  } finally {
    io.close();
  }
}

export const setupCommand = defineCommand({
  meta: {
    name: 'setup',
    description:
      'Install ditto managed resources, scaffold .ditto/, and allowlist the target project',
  },
  args: {
    dir: {
      type: 'string',
      required: false,
      description: 'Target project directory; defaults to the nearest .ditto/.git root or cwd',
    },
    target: {
      type: 'positional',
      required: false,
      description: 'Target project directory; same as --dir',
    },
    host: {
      type: 'string',
      required: false,
      description: 'Host surface to install: claude-code|codex|both (default: claude-code)',
    },
    yes: {
      type: 'boolean',
      required: false,
      default: false,
      description: 'Non-interactive: skip the wizard, use defaults/flags (CI/agent)',
    },
    tools: {
      type: 'boolean',
      required: false,
      default: false,
      description: 'Non-interactive only: also provision detected tools (codeql/playwright/LSP)',
    },
    recipe: {
      type: 'string',
      required: false,
      description:
        'Path to a recipe.yaml that drives all 4 setup stages headlessly (overrides discovery)',
    },
  },
  run: async ({ args }) => {
    try {
      const host = parseSetupHost(args.host);
      const targetDir = typeof args.dir === 'string' ? args.dir : args.target;
      const projectRoot = targetDir ? resolve(targetDir) : await resolveRepoRootForCreate();
      const resourcesDir = resolveResourcesDir();

      // Self-host no-op: the ditto repo must not manage itself. Detect by the
      // bundled resources dir resolving inside the target (resourcesDir's plugin
      // root == projectRoot), mirroring install-plugin.mjs's `target === repo`.
      const pluginRoot = resolve(resourcesDir, '..', '..');
      if (pluginRoot === projectRoot) {
        writeHuman(`setup: skipped (self-host — target IS the ditto repo at ${projectRoot})`);
        return;
      }

      // Recipe resolution at command ENTRY, BEFORE the TTY/--yes branch (ac-3): a
      // present recipe (explicit --recipe, or a discovered non-empty recipe.yaml)
      // drives the FULL 4-stage headless path regardless of isTTY/--yes — it must
      // NOT fall through to the legacy host+scaffold-only path. Explicit --recipe
      // malformed/missing throws (ac-5, caught below); a discovered malformed file
      // warns and is ignored, naming which file (ac-5).
      const cliRecipePath = typeof args.recipe === 'string' ? args.recipe : undefined;
      const resolvedRecipe = await loadResolvedRecipe(projectRoot, cliRecipePath, (origin, msg) =>
        writeError(`recipe ignored (${origin} recipe.yaml malformed): ${msg}`),
      );
      if (isRecipePresent(cliRecipePath, resolvedRecipe)) {
        // recipe.host wins over the --host flag (the recipe is the authoritative
        // headless declaration); --host/default fills in when the recipe omits it.
        const recipeHost = resolvedRecipe.host ?? host;
        const summary = await runRecipeSetup(resolvedRecipe, recipeHost, {
          setup: async (h) =>
            setup({
              resourcesDir,
              projectRoot,
              homeDir: homedir(),
              ...(process.env.CODEX_HOME ? { codexHome: process.env.CODEX_HOME } : {}),
              now: new Date(),
              host: h,
              // Install the pre-push gate hook when the recipe declares a push_gate
              // for the ROOT repo (ac-5). resolvePushGate(recipe, '') === recipe.push_gate.
              ...(resolvedRecipe.push_gate ? { pushGate: resolvedRecipe.push_gate } : {}),
              ...(includesCodex(h)
                ? { pluginRoot: await resolveCodexPluginRoot(resourcesDir, projectRoot) }
                : {}),
            }),
          provisionTools: (ids) => provisionRecipeTools(defaultRegistry(), ids),
          writeVariants: (variants) => writeAgentVariants(projectRoot, variants),
          separateMemory: (mode) =>
            separateMemoryRepo(defaultMemorySeparateDeps(projectRoot), mode),
          seedGithubConfig: (github) =>
            seedGithubConfigIfAbsent(projectRoot, github, () =>
              writeError(
                'github backlog seed skipped: 개인 .ditto/local/config.json malformed/invalid — 무시(fail-closed)',
              ),
            ),
        });

        writeHuman(`setup: installed into ${projectRoot} (host=${summary.host}, recipe-driven)`);
        writeHuman(
          `.ditto/: ${summary.setup.scaffold.alreadyInitialized ? 'already initialized' : 'created'} · allowlist: ${
            summary.setup.allowlistApplied ? summary.setup.allowlistPath : 'skipped'
          }`,
        );
        for (const line of charterRefreshNotices(summary.setup.resources)) writeHuman(line);
        if (summary.tools.length > 0) {
          writeHuman('tools:');
          for (const o of summary.tools) writeHuman(`  ${o.action}\t${o.message}`);
        }
        if (summary.agents.written.length > 0 || summary.agents.skipped.length > 0) {
          writeHuman(
            `agents linked: ${summary.agents.written.length ? summary.agents.written.join(', ') : '(none)'}${
              summary.agents.skipped.length
                ? ` · skipped(existing): ${summary.agents.skipped.join(', ')}`
                : ''
            }`,
          );
        }
        if (summary.memory.result) {
          writeHuman(`memory: ${summary.memory.mode} — ${summary.memory.result.message}`);
        } else {
          writeHuman('memory: 프로젝트 git에 포함(기본)');
        }
        const hook = summary.setup.pushGateHook;
        if (hook) {
          writeHuman(`push-gate hook: ${hook.status} → ${hook.hookPath || '(not installed)'}`);
          if (hook.message) writeHuman(`  ${hook.message}`);
        }
        // C4 disclosure — never seed silently. Only surfaced when the recipe declared a
        // backlog (reason !== 'no-backlog'); otherwise there is nothing to report.
        if (summary.githubSeed.reason !== 'no-backlog') {
          const s = summary.githubSeed;
          writeHuman(
            `github backlog: ${
              s.seeded ? 'seeded personal github config' : `skipped (${s.reason ?? 'write failed'})`
            }`,
          );
        }
        return;
      }

      // 사람이 터미널에서 직접 돌릴 때만 대화형 wizard. 비TTY(에이전트/CI)나 --yes면
      // 기존 비대화 경로(install-plugin.mjs·테스트가 의존)로 진행한다.
      if (process.stdin.isTTY && !args.yes) {
        await runWizard(resourcesDir, projectRoot);
        return;
      }

      const result = await setup({
        resourcesDir,
        projectRoot,
        homeDir: homedir(),
        ...(process.env.CODEX_HOME ? { codexHome: process.env.CODEX_HOME } : {}),
        now: new Date(),
        host,
        ...(includesCodex(host)
          ? { pluginRoot: await resolveCodexPluginRoot(resourcesDir, projectRoot) }
          : {}),
      });

      writeHuman(`setup: installed into ${projectRoot} (host=${host})`);
      for (const r of result.resources) {
        const tag =
          r.status === 'corrupted'
            ? 'SKIPPED (corrupted markers)'
            : r.status === 'kept'
              ? `→ ${r.destPath} (kept existing source)`
              : r.status === 'refreshed'
                ? `→ ${r.destPath} (charter refreshed)`
                : r.status === 'up-to-date'
                  ? `→ ${r.destPath} (charter up to date)`
                  : r.status === 'unrecognized'
                    ? `→ ${r.destPath} (charter kept — unrecognized, see notice)`
                    : `→ ${r.destPath}`;
        const bak = r.backupPath ? ` (backup ${r.backupPath})` : '';
        writeHuman(`  ${r.filename} [${r.host}/${r.scope}] ${tag}${bak}`);
      }
      for (const line of charterRefreshNotices(result.resources)) writeHuman(line);
      if (result.codex) {
        writeHuman(`  codex marketplace → ${result.codex.marketplacePath}`);
        writeHuman(`  codex plugin copy → ${result.codex.installedPluginDir}`);
        writeHuman(`  codex surface catalog → ${result.codex.surfaceCatalogPath}`);
        writeHuman(`  codex agents → ${result.codex.agentsDir} (${result.codex.agentsInstalled})`);
        writeHuman(`  codex plugin status → ${result.codex.pluginLoadStatus}`);
        writeHuman('  codex enable commands:');
        for (const command of result.codex.enableCommands) writeHuman(`    ${command}`);
      }
      writeHuman(
        `.ditto/: ${result.scaffold.alreadyInitialized ? 'already initialized' : 'created'} · allowlist: ${
          result.allowlistApplied ? result.allowlistPath : 'skipped'
        }`,
      );

      // 비대화에서 --tools 명시 시에만 도구 설치(install.sh가 이 경로로 위임).
      // 기본은 안전 — 무거운 다운로드를 묻지 않고 자동 실행하지 않는다.
      if (args.tools) await provisionToolsNonInteractive(projectRoot);
    } catch (err) {
      writeError(`setup failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});
