import type { Legibility } from './legibility';

export interface RunEfficacy {
  openBefore: number;
  openAfter: number;
  testGreenAfter: boolean;
  netProgress: boolean;
}

export function runEfficacy(
  before: Legibility,
  after: Legibility,
  testGreenAfter: boolean,
): RunEfficacy {
  const openBefore = before.howFar.open;
  const openAfter = after.howFar.open;
  return {
    openBefore,
    openAfter,
    testGreenAfter,
    netProgress: openAfter < openBefore && testGreenAfter,
  };
}
