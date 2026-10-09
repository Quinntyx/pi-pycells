# Python execution boundary

Kernels run ordinary IPython in persistent local subprocesses. The Python-to-Pi
host-tool bridge is removed: no `ptc` namespace, generated host-tool helpers,
custom-tool Python opt-ins, or tool-call RPC dispatch. Notebook control,
progress, output, images, interrupts, and subagent snapshots remain supported.

Use `pathlib` / `open` for files, `subprocess` for processes, and
`asyncio.Semaphore` / `asyncio.gather` for concurrency. Top-level await, IPython
magics and shell escapes work. `np`, `pd`, and `plt` are lazy imports.

Call Pi tools normally from the parent agent, not from Python. Native custom
tools are described in [custom-tools.md](custom-tools.md).
`pi_subagents.AgentPool` and its SDK transport are independent of this removal.

Old bridge settings cannot re-enable it. Remove custom-tool `ptc` metadata;
legacy declarations are rejected rather than silently exposing previously
hidden tools. Update and restart/reload when agents are inactive to replace
existing interpreters and discard their old helpers.
