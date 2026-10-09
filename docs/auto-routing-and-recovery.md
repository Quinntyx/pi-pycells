# Notebook error recovery

Native tools are never hidden or automatically rerouted into Python. Use a
kernel for computation and persistent state; use Pi tools directly otherwise.

Optional recovery recognizes coroutine/never-awaited diagnostics corroborated
by an unawaited, known asyncio call in the cell or traceback. It covers
`asyncio.sleep`, subprocess creation, `wait`, `wait_for`, and `to_thread`.
It emits a bounded follow-up hint, never modifies code or invokes tools.
Deleted host-tool helpers are not recognized or recommended.

`PTC_AUTO_RECOVER` defaults to false. `PTC_AUTO_RECOVER_MAX_ATTEMPTS` defaults to
1 and is clamped to 0–4. State resets per user request; mutating requests do not
get automatic recovery. Failure details retain recovery telemetry.
