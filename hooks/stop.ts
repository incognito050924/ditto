import { executeHook } from '../src/hooks/io';
import { stopHandler } from '../src/hooks/stop';

await executeHook(stopHandler);
