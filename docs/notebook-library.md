# The PTC notebook library

The library is an optional directory of reusable Python notebooks. Supplying
`source` to `provision_kernel` copies a source notebook to the destination,
executes its code cells, and preserves its markdown and metadata. The source
file is never modified. It is not a Pi skill and there is no promotion tool.

## Reuse a notebook

```javascript
provision_kernel({
  name: "analysis",
  notebook: "reports/analysis.ipynb",
  source: "code-review"
})
```

A bare source name looks in the library for `<name>.ipynb`, then falls back to
`<name>.py`. You can instead supply a notebook or Python file path; relative
paths resolve against the current working directory. Notebook code cells run
in order; markdown remains interleaved. A Python file runs as one prefix cell.
The new kernel inherits the resulting namespace. Continue using that same
kernel name in later calls.

Prefix numbering includes markdown cells. Seven source cells make the first
new `exec_cell` cell number eight. A sourcing error is recorded on the failed
cell and leaves the kernel available for inspection and repair. Notebook
Python-version metadata can be overridden with `version` without changing the
original source metadata.

## Library location

Resolution order:

1. `PtcSettings.libraryDir`, for programmatic callers.
2. The `PTC_LIBRARY_DIR` environment variable (a leading `~` is expanded).
3. `<PI_CODING_AGENT_DIR>/pycells-library`, defaulting to
   `~/.pi/agent/pycells-library` when that agent-dir variable is unset.

Interactive settings are environment-driven. Use `PTC_LIBRARY_DIR` to relocate
the library; there is no settings-file field for it.

## Keep durable artifacts

Pass a project notebook path when its record should survive the task. Omitted
paths create scratch notebooks under `/tmp/pi-pycells/notebooks/`. The notebook
on disk already contains executed cells and captured outputs; no additional
tool is needed to keep it.

Library curation is optional. If explicitly requested, ordinary file operations
can copy a finished `.ipynb` into the library; check for an existing destination
before replacing it. Do not silently overwrite an existing reusable notebook
or copy one with unguarded effects or hidden setup state. Use the
[notebook-authoring skill](../skills/notebook-authoring/SKILL.md) when creating,
repairing, or handing over a reusable notebook, not for routine kernel analysis.
Audit replay effects and cached-result identities before sourcing: provisioning
executes code immediately; copying an artifact does not make it safe to rerun.

## Runtime requirements

Notebook reuse requires the notebook's Python dependencies and inputs, not an
orchestration SDK. Library lookup is independent of optional integrations.

Use `provision_dependency` for the explicitly named live kernel when needed; it
requires `uv` on PATH. The backing environment may be shared. Installation does
not record dependency setup in the notebook or reload already imported modules.
Document requirements, complete authorized installs, then reset before replay.
A kernel reset clears Python memory, not files, installed packages, or external
effects. Native interpreter round-trip tests use `PTC_TEST_REAL_RUNTIME=true`.
