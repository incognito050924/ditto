// Compile-time seal proof, checked by tsc (no runtime test() calls): subagent
// free text is opaque and can NEVER stand in as the queue oracle.
import type { AgentText, BoundaryEnvelope } from './host-adapter';

declare const t: AgentText;
// @ts-expect-error subagent free text is opaque — it can never be the queue oracle
const _q: BoundaryEnvelope = t;
void _q;
