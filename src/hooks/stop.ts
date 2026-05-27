import type { HookHandler } from './runtime';

/**
 * Stop hook handler (M1.4 fills the body).
 * M1.2: registered surface with a no-op pass-through.
 */
export const stopHandler: HookHandler = () => ({ exitCode: 0 });
