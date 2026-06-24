import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { defineCommand } from 'citty';
import { writeAgentVariants } from '~/core/agent-variants';
import { resolveRepoRootForCreate } from '~/core/fs';
import { claudeCodeHostAdapter } from '~/core/hosts/claude-code';
import { codexHostAdapter } from '~/core/hosts/codex';
import { fileExists } from '~/core/hosts/shared';
import { detectLspLanguages } from '~/core/provision/lsp-detect';
import { defaultMemorySeparateDeps, separateMemoryRepo } from '~/core/provision/memory-separate';
import { defaultRegistry } from '~/core/provision/provisioner';
import { type SetupHost, setup } from '~/core/setup';
import { resolveResourcesDir } from '../resources';
import { RUNTIME_ERROR_EXIT, writeError, writeHuman } from '../util';
import { runAgentLinkStep } from '../wizard/agent-link-step';
import type { PromptIO } from '../wizard/prompt';
import { createStdioPromptIO } from '../wizard/prompt-io';
import { runProvisionStep } from '../wizard/provision-step';
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
  },
  run: async ({ args }) => {
    try {
      const host = parseSetupHost(args.host);
      const targetDir = typeof args.dir === 'string' ? args.dir : args.target;
      const projectRoot = targetDir ? resolve(targetDir) : await resolveRepoRootForCreate();
      const resourcesDir = resolveResourcesDir();

      // Self-host no-op for Claude project management: the ditto repo must not
      // be its own managed Claude target. Codex dogfood still needs setup to
      // stage the built plugin under .agents/plugins/ditto so `codex plugin add`
      // installs the artifact, not the whole source repo.
      const pluginRoot = resolve(resourcesDir, '..', '..');
      const selfHost = pluginRoot === projectRoot;
      const setupHost: SetupHost = selfHost && includesCodex(host) ? 'codex' : host;
      if (selfHost && !includesCodex(host)) {
        writeHuman(`setup: skipped (self-host — target IS the ditto repo at ${projectRoot})`);
        return;
      }

      // 사람이 터미널에서 직접 돌릴 때만 대화형 wizard. 비TTY(에이전트/CI)나 --yes면
      // 기존 비대화 경로(install-plugin.mjs·테스트가 의존)로 진행한다.
      if (!selfHost && process.stdin.isTTY && !args.yes) {
        await runWizard(resourcesDir, projectRoot);
        return;
      }

      const result = await setup({
        resourcesDir,
        projectRoot,
        homeDir: homedir(),
        ...(process.env.CODEX_HOME ? { codexHome: process.env.CODEX_HOME } : {}),
        now: new Date(),
        host: setupHost,
        ...(includesCodex(setupHost)
          ? { pluginRoot: await resolveCodexPluginRoot(resourcesDir, projectRoot) }
          : {}),
      });

      writeHuman(`setup: installed into ${projectRoot} (host=${setupHost})`);
      for (const r of result.resources) {
        const tag =
          r.status === 'corrupted'
            ? 'SKIPPED (corrupted markers)'
            : r.status === 'kept'
              ? `→ ${r.destPath} (kept existing source)`
              : `→ ${r.destPath}`;
        const bak = r.backupPath ? ` (backup ${r.backupPath})` : '';
        writeHuman(`  ${r.filename} [${r.host}/${r.scope}] ${tag}${bak}`);
      }
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
