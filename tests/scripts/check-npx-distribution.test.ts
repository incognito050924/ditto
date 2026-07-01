import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkNpxDistribution } from '../../scripts/check-npx-distribution';

/**
 * npx 배포경로 회귀 가드 (wi_260701dms).
 *
 * 사용자의 유일한 배포 표면은 `npx github:incognito050924/ditto <install|update|uninstall>`
 * 이다. 그 경로가 의존하는 구조 불변식이 깨진 커밋을 정적으로 차단한다. 각 룰은 완전-유효
 * fixture 를 한 군데만 깨뜨려 위반이 잡히는지 검증한다.
 */

const VALID_BOOTSTRAP = `#!/usr/bin/env node
const GH_SOURCE = 'incognito050924/ditto';
const MARKETPLACE = 'ditto-local';
const PLUGIN = 'ditto';
function doInstall() {}
function doUpdate() {}
function doUninstall() {}
const VERB = process.argv[2] ?? '';
const RUN = { install: doInstall, update: doUpdate, uninstall: doUninstall }[VERB];
if (!RUN) { console.error('usage: npx github:incognito050924/ditto <install|update|uninstall>'); process.exit(64); }
RUN();
`;

const VALID_PKG = {
  name: 'ditto',
  bin: { ditto: './scripts/npx-bootstrap.mjs' },
  scripts: { prepare: 'git config core.hooksPath .githooks 2>/dev/null || true' },
};

const VALID_MARKETPLACE = {
  name: 'ditto-local',
  plugins: [{ name: 'ditto', source: './' }],
};

/** 완전-유효 최소 repo 를 tmpdir 에 세운다. mutate 로 한 군데만 깨뜨린다. */
async function scaffold(
  mutate: (f: {
    pkg: Record<string, unknown>;
    bootstrap: string;
    marketplace: Record<string, unknown>;
    writeBootstrap: boolean;
  }) => void = () => {},
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ditto-npxguard-'));
  const f = {
    pkg: structuredClone(VALID_PKG) as Record<string, unknown>,
    bootstrap: VALID_BOOTSTRAP,
    marketplace: structuredClone(VALID_MARKETPLACE) as Record<string, unknown>,
    writeBootstrap: true,
  };
  mutate(f);
  await Bun.write(join(root, 'package.json'), JSON.stringify(f.pkg, null, 2));
  await Bun.write(
    join(root, '.claude-plugin', 'marketplace.json'),
    JSON.stringify(f.marketplace, null, 2),
  );
  if (f.writeBootstrap) await Bun.write(join(root, 'scripts', 'npx-bootstrap.mjs'), f.bootstrap);
  return root;
}

async function rules(root: string): Promise<string[]> {
  const v = await checkNpxDistribution(root);
  return v.map((x) => x.rule);
}

describe('checkNpxDistribution — valid repo', () => {
  test('a fully-valid fixture yields zero violations', async () => {
    const root = await scaffold();
    try {
      expect(await checkNpxDistribution(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('the REAL repo (this checkout) passes the guard', async () => {
    // self-host: the guard must be green on the live tree it ships from.
    expect(await checkNpxDistribution(process.cwd())).toEqual([]);
  });
});

describe('rule: bin-field', () => {
  test('flags a missing bin.ditto entry', async () => {
    const root = await scaffold((f) => {
      f.pkg.bin = {};
    });
    try {
      expect(await rules(root)).toContain('bin-field');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('flags bin.ditto pointing at a wrong target', async () => {
    const root = await scaffold((f) => {
      f.pkg.bin = { ditto: './scripts/other.mjs' };
    });
    try {
      expect(await rules(root)).toContain('bin-field');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('flags a bin.ditto target file that does not exist', async () => {
    const root = await scaffold((f) => {
      f.writeBootstrap = false; // bin points at npx-bootstrap.mjs but file is absent
    });
    try {
      expect(await rules(root)).toContain('bin-field');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('rule: verb-routing', () => {
  test('flags a bootstrap whose RUN map drops the uninstall verb', async () => {
    const root = await scaffold((f) => {
      f.bootstrap = f.bootstrap.replace(', uninstall: doUninstall', '');
    });
    try {
      expect(await rules(root)).toContain('verb-routing');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('flags a bootstrap with no RUN verb map at all', async () => {
    const root = await scaffold((f) => {
      f.bootstrap = '#!/usr/bin/env node\nconsole.log("no run map");\n';
    });
    try {
      expect(await rules(root)).toContain('verb-routing');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('rule: npm-clone-scripts', () => {
  test('flags a clone-breaking lifecycle script (postinstall)', async () => {
    const root = await scaffold((f) => {
      (f.pkg.scripts as Record<string, string>).postinstall = 'bun run build';
    });
    try {
      expect(await rules(root)).toContain('npm-clone-scripts');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('flags a prepare that runs a build (would break a bun-less npm clone)', async () => {
    const root = await scaffold((f) => {
      (f.pkg.scripts as Record<string, string>).prepare = 'bun run build:bin';
    });
    try {
      expect(await rules(root)).toContain('npm-clone-scripts');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('rule: marketplace-consistency', () => {
  test('flags marketplace name drifting from the bootstrap MARKETPLACE constant', async () => {
    const root = await scaffold((f) => {
      f.marketplace.name = 'renamed-marketplace';
    });
    try {
      expect(await rules(root)).toContain('marketplace-consistency');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('flags the ditto plugin source not being "./" (repo root = plugin root)', async () => {
    const root = await scaffold((f) => {
      f.marketplace.plugins = [{ name: 'ditto', source: '../elsewhere' }];
    });
    try {
      expect(await rules(root)).toContain('marketplace-consistency');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('flags when no plugin matches the bootstrap PLUGIN constant', async () => {
    const root = await scaffold((f) => {
      f.marketplace.plugins = [{ name: 'not-ditto', source: './' }];
    });
    try {
      expect(await rules(root)).toContain('marketplace-consistency');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
