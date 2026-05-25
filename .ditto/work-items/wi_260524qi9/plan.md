# Plan

1. Confirm current v0.1/v0.2 implementation surface and keep reuse boundaries fixed.
2. Design the smallest HostAdapter execution contract that supports mockable spawn and artifact capture.
3. Implement `run with` around RunStore without changing `run record` semantics.
4. Add profile policy fixtures before relying on actual provider CLIs.
5. Add minimal `context build` and connect its output to `prompt_path`.
6. Verify schema compatibility, success/failure run capture, and profile policy behavior.
