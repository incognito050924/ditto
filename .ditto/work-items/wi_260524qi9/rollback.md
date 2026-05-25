# Rollback

- Remove `.ditto/work-items/wi_260524qi9/` if the seed is replaced before implementation starts.
- Implementation changes should keep `run record` behavior backward compatible; if not, revert the `run with` layer before touching RunStore schema.
- If implementation changes `runManifest` or exported schemas, rollback must also cover `src/schemas/run-manifest.ts`, `schemas/run-manifest.schema.json`, and compatibility of any existing `.ditto/runs/*/manifest.json` files.
