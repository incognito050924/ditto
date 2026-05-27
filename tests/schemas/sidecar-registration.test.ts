import { describe, expect, test } from 'bun:test';
import * as barrel from '~/schemas';
import { schemaExports } from '../../scripts/export-schemas';

// M0.2 acceptance — guard against false positives: both the export registry
// (scripts/export-schemas.ts) and the barrel (src/schemas/index.ts) are manual
// lists, so a new schema can be silently dropped from either. Assert every new
// sidecar schema is present in BOTH.
const NEW_SIDECARS: Array<{ exportName: string; barrelConst: keyof typeof barrel }> = [
  { exportName: 'intent', barrelConst: 'intentContract' },
  { exportName: 'question-gate', barrelConst: 'questionGate' },
  { exportName: 'interview-state', barrelConst: 'interviewState' },
  { exportName: 'autopilot', barrelConst: 'autopilot' },
  { exportName: 'dialectic', barrelConst: 'dialectic' },
  { exportName: 'convergence', barrelConst: 'convergence' },
  { exportName: 'handoff', barrelConst: 'handoff' },
];

describe('new sidecar schemas are registered in both lists', () => {
  const exportedNames = new Set(schemaExports.map((e) => e.name));

  for (const { exportName, barrelConst } of NEW_SIDECARS) {
    test(`${exportName} is in the JSON export registry`, () => {
      expect(exportedNames.has(exportName)).toBe(true);
    });

    test(`${barrelConst} is exported from the schemas barrel`, () => {
      expect(barrel[barrelConst]).toBeDefined();
    });
  }
});
