import { executeHook } from '../src/hooks/io';
import { preCompactHandler } from '../src/hooks/pre-compact';

await executeHook(preCompactHandler);
