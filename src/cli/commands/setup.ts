import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { defineCommand } from 'citty';
import { resolveRepoRootForCreate } from '~/core/fs';
import { fileExists } from '~/core/hosts/shared';
import { detectLspLanguages } from '~/core/provision/lsp-detect';
import { defaultMemorySeparateDeps, separateMemoryRepo } from '~/core/provision/memory-separate';
import { defaultRegistry } from '~/core/provision/provisioner';
import { type SetupHost, setup } from '~/core/setup';
import { resolveResourcesDir } from '../resources';
import { RUNTIME_ERROR_EXIT, writeError, writeHuman } from '../util';
import { createStdioPromptIO } from '../wizard/prompt-io';
import { runProvisionStep } from '../wizard/provision-step';
import { runSetupWizard } from '../wizard/setup-wizard';

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
          now: new Date(),
          host,
          ...(includesCodex(host)
            ? { pluginRoot: await resolveCodexPluginRoot(resourcesDir, projectRoot) }
            : {}),
        }),
      runProvision: (promptIo) =>
        runProvisionStep(promptIo, defaultRegistry(), projectRoot, { detect: detectLspLanguages }),
      separateMemory: (mode) => separateMemoryRepo(defaultMemorySeparateDeps(projectRoot), mode),
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
    if (result.memory.result) {
      writeHuman(`memory: ${result.memory.mode} — ${result.memory.result.message}`);
      for (const line of result.memory.result.manual ?? []) writeHuman(`  ${line}`);
    } else {
      writeHuman('memory: 프로젝트 git에 포함(기본)');
    }
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
        now: new Date(),
        host,
        ...(includesCodex(host)
          ? { pluginRoot: await resolveCodexPluginRoot(resourcesDir, projectRoot) }
          : {}),
      });

      writeHuman(`setup: installed into ${projectRoot} (host=${host})`);
      for (const r of result.resources) {
        const tag = r.status === 'corrupted' ? 'SKIPPED (corrupted markers)' : `→ ${r.destPath}`;
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
    } catch (err) {
      writeError(`setup failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});
