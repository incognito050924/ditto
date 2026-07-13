# Prism design document template

The document `ditto prism doc` emits (see the "Emit the design document" stage in the
prism SKILL). It is isomorphic to the `.ditto/specs` template — headings are pulled
from the shared spec sections, so it never drifts. Sections:

1. **Feature** — the name.
2. **Summary** — what this change is, in prose. *(compile-input, digest-bound)*
3. **Background** — codebase/project facts, each a summary with a grounding pointer
   (never raw transcription).
4. **Goals** — what success is, in the user's terms. *(compile-input, digest-bound)*
5. **Non-goals** — explicitly out of scope. *(compile-input, digest-bound)*
6. **Acceptance criteria** — observable `| id | 완료 조건 | evidence |` rows.
   *(compile-input, digest-bound)*
7. **Risks** — `| 위험 | 처리 | 플래그 |`. *(compile-input, digest-bound)*
8. **Impact** — affected surfaces, each grounded.
9. **Interview log** — a short summary of the refinement (summary, not transcript).

The five compile-input sections (요약·목표·비목표·완료 조건·위험) must be non-empty;
they are what the preserved digest binds, so the compiled intent stays tied to the
exact confirmed document.
