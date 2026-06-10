import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveResourcesDir } from '~/cli/resources';

describe('resolveResourcesDir', () => {
  let root: string;
  let savedPluginRoot: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ditto-resources-'));
    savedPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
    // biome-ignore lint/performance/noDelete: env unset.
    delete process.env.CLAUDE_PLUGIN_ROOT;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (savedPluginRoot === undefined) {
      // biome-ignore lint/performance/noDelete: env unset (restore to unset, not "undefined").
      delete process.env.CLAUDE_PLUGIN_ROOT;
    } else {
      process.env.CLAUDE_PLUGIN_ROOT = savedPluginRoot;
    }
  });

  test('CLAUDE_PLUGIN_ROOT가 있으면 그 아래 resources/managed를 쓴다', () => {
    process.env.CLAUDE_PLUGIN_ROOT = join(root, 'plugin');
    expect(resolveResourcesDir(join(root, 'elsewhere'))).toBe(
      join(root, 'plugin', 'resources', 'managed'),
    );
  });

  // wi_2606109iv 회귀: 설치 캐시 레이아웃(~/.claude/plugins/cache/<mp>/<plugin>/<ver>/bin)
  // 에서 고정 `../../..` 추측은 <mp>를 가리켜 resources/managed를 놓쳤다(teardown이
  // 파일 0개를 처리하고도 "reverted"를 보고하는 false green). walk-up은 깊이와 무관하게
  // 첫 조상에서 찾아야 한다.
  test('설치 캐시 레이아웃: bin에서 walk-up으로 형제 resources/managed를 찾는다', () => {
    const version = join(root, 'cache', 'ditto-local', 'ditto', '0.0.0');
    mkdirSync(join(version, 'bin'), { recursive: true });
    mkdirSync(join(version, 'resources', 'managed'), { recursive: true });
    writeFileSync(join(version, 'resources', 'managed', 'CLAUDE.md'), 'x');

    expect(resolveResourcesDir(join(version, 'bin'))).toBe(join(version, 'resources', 'managed'));
  });

  test('repo 레이아웃: src/cli에서 walk-up으로 repo 루트의 resources/managed를 찾는다', () => {
    mkdirSync(join(root, 'src', 'cli'), { recursive: true });
    mkdirSync(join(root, 'resources', 'managed'), { recursive: true });

    expect(resolveResourcesDir(join(root, 'src', 'cli'))).toBe(join(root, 'resources', 'managed'));
  });
});
