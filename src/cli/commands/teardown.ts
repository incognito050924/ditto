import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { defineCommand } from 'citty';
import { resolveRepoRootForCreate } from '~/core/fs';
import { teardown } from '~/core/teardown';
import { resolveResourcesDir } from '../resources';
import { RUNTIME_ERROR_EXIT, writeError, writeHuman } from '../util';
import { confirm } from '../wizard/prompt';
import { createStdioPromptIO } from '../wizard/prompt-io';

/**
 * 삭제 표면의 유일한 질문: `.ditto/`(work-item 이력·메모리 SoT)까지 지울까. 기본은 보존.
 * 비가역이므로 명시적으로만 — TTY면 confirm(기본 아니오), 비TTY는 --purge 플래그로만.
 */
async function shouldPurge(flagPurge: boolean): Promise<boolean> {
  if (flagPurge) return true;
  if (!process.stdin.isTTY) return false;
  const io = createStdioPromptIO();
  try {
    return await confirm(io, '.ditto/ 데이터(work-item 이력·메모리)까지 영구 삭제할까?', false);
  } finally {
    io.close();
  }
}

export const teardownCommand = defineCommand({
  meta: {
    name: 'uninstall',
    description:
      'Undo ditto setup: strip managed blocks (preserving user content), remove the allow rule; keeps .ditto/ (alias: teardown)',
  },
  args: {
    dir: {
      type: 'string',
      required: false,
      description: 'Target project directory; defaults to the nearest .ditto/.git root or cwd',
    },
    purge: {
      type: 'boolean',
      required: false,
      default: false,
      description:
        'Also delete .ditto/ (work-item history + memory) — irreversible; default keeps it',
    },
  },
  run: async ({ args }) => {
    try {
      const projectRoot = args.dir ? resolve(args.dir) : await resolveRepoRootForCreate();
      const resourcesDir = resolveResourcesDir();

      // Self-host no-op: the ditto repo must not manage itself. Mirrors setup's
      // guard (resourcesDir's plugin root == projectRoot).
      const pluginRoot = resolve(resourcesDir, '..', '..');
      if (pluginRoot === projectRoot) {
        writeHuman(`uninstall: skipped (self-host — target IS the ditto repo at ${projectRoot})`);
        return;
      }

      const result = await teardown({ resourcesDir, projectRoot, homeDir: homedir() });

      // No discovered resources means nothing was actually stripped — saying
      // "reverted" here would be a false green (the pre-fix symptom).
      if (result.files.length === 0) {
        writeError(`uninstall failed: no managed resources found at ${resourcesDir}`);
        process.exit(RUNTIME_ERROR_EXIT);
      }

      writeHuman(`uninstall: reverted ${projectRoot}`);
      for (const f of result.files) {
        writeHuman(`  ${f.filename} [${f.scope}] ${f.action} → ${f.destPath}`);
      }
      if (result.pushGateHook.status !== 'left-untouched') {
        writeHuman(
          `  pre-push hook ${result.pushGateHook.status} → ${result.pushGateHook.hookPath}`,
        );
      }

      const purge = await shouldPurge(Boolean(args.purge));
      if (purge) {
        const dittoDir = join(projectRoot, '.ditto');
        await rm(dittoDir, { recursive: true, force: true });
        writeHuman(
          `allowlist: removed Bash(ditto:*) from ${result.allowlistPath} · .ditto/ PURGED (${dittoDir})`,
        );
      } else {
        writeHuman(`allowlist: removed Bash(ditto:*) from ${result.allowlistPath} · .ditto/ kept`);
      }
    } catch (err) {
      writeError(`uninstall failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});
