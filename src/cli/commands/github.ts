import { defineCommand } from 'citty';
import { writeGithubConfig } from '~/core/ditto-config';
import { resolveRepoRootForCreate } from '~/core/fs';
import { type GhClient, createGhClient } from '~/core/gh-client';
import { type DittoConfigGithub, dittoConfigGithub } from '~/schemas/ditto-config';
import { RUNTIME_ERROR_EXIT, writeError, writeHuman } from '../util';
import { type Option, type PromptIO, confirm, select } from '../wizard/prompt';
import { createStdioPromptIO } from '../wizard/prompt-io';

/**
 * `ditto github setup` — GitHub Project(백로그 SoT) 연결 wizard (wi_260628d79, G9/D8).
 *
 * 단계: ① 대상 Project 지정(owner/number 또는 URL, `--project`) → ② 접근·존재 검증
 * (`gh project field-list`) → ③ status field 옵션 조회 → ④ D7 status_map 매핑 확정
 * (KEYS = done|abandoned ONLY) → ⑤ auto-reflect 토글(기본 OFF) → ⑥ `.ditto/local/config.json`
 * 의 `github` 키에 저장. 비대화형 플래그(`--project`·`--status-map`·`--auto-reflect`)는
 * **동일 config**(멱등). 권한·접근 실패는 우아한 강등으로 사유 안내(ADR-0018, never crash).
 *
 * 대화형 흐름은 기존 `PromptIO`(prompt.ts)와 fail-open config 저장은 기존 `dittoConfig`
 * 스토어(ditto-config.ts)를 재사용한다 — 병렬 prompt/config 표면을 새로 세우지 않는다.
 */

/** D7: status_map 키는 ditto 종료 enum 중 terminal 두 상태로만 제한된다. */
const STATUS_MAP_KEYS = ['done', 'abandoned'] as const;
type StatusMapKey = (typeof STATUS_MAP_KEYS)[number];

/**
 * ac-9/ac-5: claim_status_map 키는 ditto 비종료(non-terminal) 진행 상태로 제한된다.
 * terminal `status_map`(done|abandoned)과 분리된 SEPARATE 매핑 — wizard·플래그·config가
 * 어긋나지 않도록 이 단일 소스에서 키 집합을 끌어 쓴다(schema는 OPEN string 키라 enum이 없음).
 */
const CLAIM_STATUS_MAP_KEYS = ['in_progress', 'blocked'] as const;
type ClaimStatusMapKey = (typeof CLAIM_STATUS_MAP_KEYS)[number];

export interface ProjectRef {
  owner: string;
  number: number;
}

export interface StatusOption {
  id: string;
  name: string;
}

export interface GithubSetupOptions {
  /** "owner/number" 또는 GitHub Project URL. `--project` 또는 대화형 입력. */
  project?: string;
  /** "done=optid,abandoned=optid2" — `--status-map`. */
  statusMap?: string;
  /** "in_progress=optid,blocked=optid2" — `--claim-status-map` (비종료 보드 매핑, ac-9). */
  claimStatusMap?: string;
  /** `--auto-reflect`. undefined면 대화형 confirm(기본 false) / 비대화형 false. */
  autoReflect?: boolean;
  /** true면 절대 묻지 않는다(플래그만, CI/자동화). */
  nonInteractive?: boolean;
}

export type GithubSetupOutcome =
  | { ok: true; config: DittoConfigGithub; notices: string[] }
  | { ok: false; reason: string; detail: string };

/** "owner/number" 또는 Project URL을 {owner, number}로 파싱한다. 실패 시 null. */
export function parseProjectRef(input: string): ProjectRef | null {
  const raw = input.trim();
  if (raw === '') return null;
  // URL: https://github.com/users/<owner>/projects/<n> | /orgs/<owner>/projects/<n>
  if (/github\.com/i.test(raw) || raw.includes('://')) {
    const m = /\/(?:users|orgs)\/([^/]+)\/projects\/(\d+)/i.exec(raw);
    if (!m) return null;
    const number = Number.parseInt(m[2] ?? '', 10);
    if (!Number.isInteger(number) || number <= 0) return null;
    return { owner: m[1] ?? '', number };
  }
  // "owner/number"
  const parts = raw.split('/');
  if (parts.length !== 2) return null;
  const owner = (parts[0] ?? '').trim();
  const number = Number.parseInt((parts[1] ?? '').trim(), 10);
  if (owner === '' || !Number.isInteger(number) || number <= 0) return null;
  return { owner, number };
}

/**
 * "key=optid,key2=optid2" 플래그를 `allowedKeys`로 한정해 파싱한다.
 * 허용되지 않은 키·빈 값은 dropped로 — terminal/비종료 두 매핑이 같은 규칙을 공유한다.
 */
function parseKeyedOptionFlag<K extends string>(
  input: string,
  allowedKeys: readonly K[],
): { map: Partial<Record<K, string>>; dropped: string[] } {
  const map: Partial<Record<K, string>> = {};
  const dropped: string[] = [];
  const allowed = allowedKeys as readonly string[];
  for (const part of input.split(',')) {
    const entry = part.trim();
    if (entry === '') continue;
    const eq = entry.indexOf('=');
    const key = (eq === -1 ? entry : entry.slice(0, eq)).trim();
    const value = (eq === -1 ? '' : entry.slice(eq + 1)).trim();
    if (allowed.includes(key) && value !== '') {
      map[key as K] = value;
    } else {
      dropped.push(entry);
    }
  }
  return { map, dropped };
}

/** "done=optid,abandoned=optid2" 플래그를 파싱한다. done/abandoned 외 키·빈 값은 dropped로. */
export function parseStatusMapFlag(input: string): {
  map: Partial<Record<StatusMapKey, string>>;
  dropped: string[];
} {
  return parseKeyedOptionFlag(input, STATUS_MAP_KEYS);
}

/**
 * "in_progress=optid,blocked=optid2" 플래그를 파싱한다(ac-9 비종료 보드 매핑).
 * in_progress/blocked 외 키·빈 값은 dropped로 — terminal status_map과 동일 규칙.
 */
export function parseClaimStatusMapFlag(input: string): {
  map: Partial<Record<ClaimStatusMapKey, string>>;
  dropped: string[];
} {
  return parseKeyedOptionFlag(input, CLAIM_STATUS_MAP_KEYS);
}

/**
 * `gh project field-list --format json` 출력에서 status single-select 필드의 옵션을 추출한다.
 * "Status"(대소문자 무시) 우선, 없으면 옵션을 가진 첫 single-select 필드. 없으면 null.
 */
export function extractStatusOptions(fieldList: unknown): StatusOption[] | null {
  if (typeof fieldList !== 'object' || fieldList === null) return null;
  const fields = (fieldList as { fields?: unknown }).fields;
  if (!Array.isArray(fields)) return null;
  const withOptions = fields.filter(
    (f): f is { name?: string; options: { id: string; name: string }[] } =>
      typeof f === 'object' && f !== null && Array.isArray((f as { options?: unknown }).options),
  );
  const status =
    withOptions.find((f) => (f.name ?? '').toLowerCase() === 'status') ?? withOptions[0];
  if (!status) return null;
  const options = status.options
    .filter((o) => o && typeof o.id === 'string' && typeof o.name === 'string')
    .map((o) => ({ id: o.id, name: o.name }));
  return options.length === 0 ? null : options;
}

/**
 * 대화형(PromptIO 주입) + 비대화형(플래그)에서 **동일 config**를 산출하는 빌더(ac-14 멱등).
 * gh-client로 접근 검증 + 옵션 조회(우아한 강등 — 실패 시 사유, never crash).
 */
export async function buildGithubConfig(
  io: PromptIO,
  gh: GhClient,
  opts: GithubSetupOptions,
): Promise<GithubSetupOutcome> {
  const notices: string[] = [];

  // ① 대상 Project 지정 (플래그 우선, 없으면 대화형 입력 — 비대화형이면 빈 값)
  const rawRef =
    opts.project ??
    (opts.nonInteractive ? '' : (await io.ask('대상 Project (owner/number 또는 URL): ')).trim());
  const ref = parseProjectRef(rawRef);
  if (!ref) {
    return { ok: false, reason: 'invalid_project', detail: rawRef };
  }

  // ② 접근·존재 검증 + ③ status field 옵션 조회 (한 호출). 우아한 강등 — never crash.
  // field-list는 Project read 접근(권한)까지 함께 게이트한다; write(item-edit) 권한은
  // 실제 반영(G5) 시점에 동일 강등 경로로 검증된다(파괴적 probe 회피).
  const res = gh.projectFieldList(ref.owner, ref.number);
  if (!res.ok) {
    return { ok: false, reason: res.reason, detail: res.detail };
  }
  const options = extractStatusOptions(res.value);
  if (!options) {
    return {
      ok: false,
      reason: 'no_status_field',
      detail: `Project ${ref.owner}/${ref.number}에 status single-select 필드가 없음`,
    };
  }
  const optionIds = new Set(options.map((o) => o.id));

  // Capture the Project node id (PVT_…) — `project item-edit --project-id` needs it for
  // board status reflection (ac-5). BEST-EFFORT (ADR-0018): projectView degraded or no id
  // → config saved WITHOUT node_id (reflection later skips the board with a notice).
  const viewRes = gh.projectView(ref.owner, ref.number);
  const nodeId =
    viewRes.ok && typeof (viewRes.value as { id?: unknown })?.id === 'string'
      ? (viewRes.value as { id: string }).id
      : undefined;
  if (!nodeId) {
    notices.push(
      'Project node_id를 조회하지 못함 — 보드 status 반영(ac-5)은 skip된다(링크·표시는 정상).',
    );
  }

  // ④ status/claim 매핑에서 공유하는 선택지(대화형) — 한 번만 조립한다.
  const choiceOptions: Option[] = [
    { label: '(매핑 안 함 — 반영 시 skip)', value: '' },
    ...options.map((o) => ({ label: o.name, value: o.id })),
  ];

  // ④a D7 terminal status_map 매핑 확정 — KEYS = done|abandoned ONLY.
  const statusMap: Partial<Record<StatusMapKey, string>> = {};
  if (opts.nonInteractive || opts.statusMap !== undefined) {
    const { map, dropped } = parseStatusMapFlag(opts.statusMap ?? '');
    for (const d of dropped) notices.push(`status-map 항목 무시(키는 done|abandoned만): ${d}`);
    for (const key of STATUS_MAP_KEYS) {
      const optId = map[key];
      if (optId === undefined) continue;
      if (!optionIds.has(optId)) {
        notices.push(`매핑 옵션 id '${optId}'(${key})가 Project status에 없음 — skip`);
        continue;
      }
      statusMap[key] = optId;
    }
  } else {
    for (const key of STATUS_MAP_KEYS) {
      const picked = await select(
        io,
        `ditto '${key}' → Project status 옵션 선택`,
        choiceOptions,
        '',
      );
      if (picked !== '' && optionIds.has(picked)) statusMap[key] = picked;
    }
  }

  // ④b ac-9 비종료(claim) 보드 매핑 확정 — KEYS = in_progress|blocked. terminal
  // status_map과 분리된 claim_status_map에 쓴다(터미널 enum은 그대로 둔다).
  const claimStatusMap: Partial<Record<ClaimStatusMapKey, string>> = {};
  if (opts.nonInteractive || opts.claimStatusMap !== undefined) {
    const { map, dropped } = parseClaimStatusMapFlag(opts.claimStatusMap ?? '');
    for (const d of dropped)
      notices.push(`claim-status-map 항목 무시(키는 in_progress|blocked만): ${d}`);
    for (const key of CLAIM_STATUS_MAP_KEYS) {
      const optId = map[key];
      if (optId === undefined) continue;
      if (!optionIds.has(optId)) {
        notices.push(`claim 매핑 옵션 id '${optId}'(${key})가 Project status에 없음 — skip`);
        continue;
      }
      claimStatusMap[key] = optId;
    }
  } else {
    for (const key of CLAIM_STATUS_MAP_KEYS) {
      const picked = await select(
        io,
        `ditto '${key}' → Project status 옵션 선택(claim 보드 반영)`,
        choiceOptions,
        '',
      );
      if (picked !== '' && optionIds.has(picked)) claimStatusMap[key] = picked;
    }
  }

  // ⑤ auto-reflect 토글 — 기본 OFF.
  const autoReflect =
    opts.autoReflect ??
    (opts.nonInteractive
      ? false
      : await confirm(io, '완료 시 Project status 자동 반영(auto-reflect)?', false));

  // ⑥ 스키마로 결박 검증(키 제약 재확인) 후 산출.
  const candidate = {
    project: { owner: ref.owner, number: ref.number, ...(nodeId ? { node_id: nodeId } : {}) },
    status_map: statusMap,
    ...(Object.keys(claimStatusMap).length > 0 ? { claim_status_map: claimStatusMap } : {}),
    auto_reflect: autoReflect,
  };
  const parsed = dittoConfigGithub.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, reason: 'schema_invalid', detail: parsed.error.message.slice(0, 200) };
  }
  return { ok: true, config: parsed.data, notices };
}

const githubSetupCommand = defineCommand({
  meta: {
    name: 'setup',
    description: 'GitHub Project(백로그 SoT)를 지정·검증·매핑해 config에 연결',
  },
  args: {
    dir: {
      type: 'string',
      required: false,
      description: '대상 프로젝트 루트(기본: 가까운 repo 루트)',
    },
    project: {
      type: 'string',
      required: false,
      description: '대상 Project — "owner/number" 또는 URL',
    },
    'status-map': {
      type: 'string',
      required: false,
      description: 'D7 매핑 "done=<optid>,abandoned=<optid>" (키=done|abandoned)',
    },
    'claim-status-map': {
      type: 'string',
      required: false,
      description:
        '비종료 보드 매핑 "in_progress=<optid>,blocked=<optid>" (키=in_progress|blocked)',
    },
    'auto-reflect': {
      type: 'boolean',
      required: false,
      description: '완료 시 Project status 자동 반영(기본 OFF)',
    },
    yes: {
      type: 'boolean',
      required: false,
      default: false,
      description: '비대화형(플래그만, CI)',
    },
  },
  run: async ({ args }) => {
    const repoRoot =
      typeof args.dir === 'string' && args.dir !== '' ? args.dir : await resolveRepoRootForCreate();
    const nonInteractive = Boolean(args.yes) || !process.stdin.isTTY;
    const io = nonInteractive
      ? { isTTY: false, ask: async () => '', write: (t: string) => process.stdout.write(t) }
      : createStdioPromptIO();
    try {
      const opts: GithubSetupOptions = {
        nonInteractive,
        ...(typeof args.project === 'string' ? { project: args.project } : {}),
        ...(typeof args['status-map'] === 'string' ? { statusMap: args['status-map'] } : {}),
        ...(typeof args['claim-status-map'] === 'string'
          ? { claimStatusMap: args['claim-status-map'] }
          : {}),
        ...(typeof args['auto-reflect'] === 'boolean' ? { autoReflect: args['auto-reflect'] } : {}),
      };
      const outcome = await buildGithubConfig(io, createGhClient(), opts);
      if (!outcome.ok) {
        writeError(
          `github setup: ${outcome.reason}${outcome.detail ? ` — ${outcome.detail}` : ''}`,
        );
        process.exit(RUNTIME_ERROR_EXIT);
      }
      await writeGithubConfig(repoRoot, outcome.config);
      const p = outcome.config.project;
      writeHuman(`github setup: linked Project ${p.owner}/${p.number} → .ditto/local/config.json`);
      writeHuman(
        `  status_map: ${
          Object.keys(outcome.config.status_map).length === 0
            ? '(none — 매핑 없음, 반영 시 skip)'
            : Object.entries(outcome.config.status_map)
                .map(([k, v]) => `${k}=${v}`)
                .join(', ')
        }`,
      );
      const claimMap = outcome.config.claim_status_map;
      writeHuman(
        `  claim_status_map: ${
          !claimMap || Object.keys(claimMap).length === 0
            ? '(none — 비종료 매핑 없음, 반영 시 skip)'
            : Object.entries(claimMap)
                .map(([k, v]) => `${k}=${v}`)
                .join(', ')
        }`,
      );
      writeHuman(`  auto_reflect: ${outcome.config.auto_reflect ? 'ON' : 'OFF'}`);
      for (const n of outcome.notices) writeHuman(`  note: ${n}`);
    } finally {
      if ('close' in io && typeof io.close === 'function') io.close();
    }
  },
});

export const githubCommand = defineCommand({
  meta: { name: 'github', description: 'GitHub 연계 (Projects v2 백로그 연결)' },
  subCommands: { setup: githubSetupCommand },
});
