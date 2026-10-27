---
name: notebook-authoring
description: "Use when creating, editing, repairing, or handing over a reusable
  Jupyter notebook with pi-pycells: cell structure, narrative, replay safety, and
  clean-kernel validation. NOT for routine kernel analysis, single throwaway cells,
  general Python work, delegation, or orchestration."
metadata:
  type: procedure
---

# Contract

## Input Contract

- A reusable `.ipynb` artifact to create, repair, or deliver, and its intended
  reader, question, inputs, and allowed effects. Do not turn ordinary kernel
  analysis into a notebook-authoring task without an artifact requirement.
- A stable destination in the project. An omitted notebook path creates a
  throwaway file under `/tmp/pi-pycells/notebooks/`; the provision result reports
  the actual destination.
- The named live kernel, if one already exists, plus the current tool schemas.
  Examples below use pi-pycells names; use the hosting application's equivalent
  operations and approval policy rather than assuming a particular harness UI.

## Output Contract

- A self-contained notebook with readable narrative, explicit inputs and
  dependencies, reproducible computation, and deliberate replay behavior.
- Current outputs from a verified clean-kernel replay, or an explicit account
  of what could not safely be replayed and which outputs remain unverified.
- No secrets in source, outputs, metadata, or cached artifacts. Do not silently
  publish data or curate a library when only a project notebook was requested.

# Author

## Inspect before editing

1. Read the existing document with `read_cells` / `read_cell`. Inspect the live
   namespace with `inspect_kernel`; neither view alone establishes reproducibility.
2. Reuse the intended kernel when continuing work. `provision_kernel` requires
   a unique, nonempty `name`; ordinary notebook tools require `kernel: "name"`.
   They never guess the most recent kernel.
3. After a disconnected call, check discovery/attachment and operation status
   before retrying: an accepted cell may still be running or have completed.
   Recovery and host lifecycle details live in [kernels](../../docs/kernels.md).
4. Establish the execution working directory, input locations, required Python
   and dependency versions, and effect/cost limits before running anything.
   Relative paths resolve from the kernel's working directory, not automatically
   from the notebook's directory.

## State and operations

Keep three things distinct: the live namespace, saved cell source, and saved
outputs. A source edit does not undo old definitions or recompute downstream
values. Stored outputs can describe an older source/config/input state.

| Operation | Document / outputs | Live namespace |
|---|---|---|
| `scratch_run` | Records no cell or output | Mutates state; setup here is hidden from replay |
| `write_cell(at, source, type)` | Replaces the existing position and clears its outputs; appends one cell when `at` is past the end | Does not execute or change state |
| `run_cell(n)` | Executes the saved code cell at position `n`, replacing its outputs | Uses and mutates existing state; no prerequisite replay |
| `exec_cell(code)` | Executes and appends a code cell, including outputs/errors | Uses and mutates existing state |
| `run_to(n)` / `run_all` | Executes code cells 1..n / all in document order; skips markdown and stops at the first error | Uses the existing live namespace; does not clear old names |
| `reset_kernel` | Leaves sources and outputs on disk untouched | Restarts the interpreter; clears user definitions and restarts execution numbering |
| `delete_cell(n)` | Deletes the position; later positions shift down | Leaves the namespace unchanged |
| `read_cells` / `read_cell` | Reads saved sources and current output previews | Does not execute |
| `inspect_kernel` | Does not change the notebook | Inspects current names, types, and definitions |

`write_cell` is replacement-or-append, not insertion: writing at position 2
will overwrite cell 2, not shift it down. Read the surrounding cells first. To
add prose in the middle, deliberately rewrite the affected sequence, preserving
its sources, rather than expecting an insertion API. Re-read positions after
structural edits.

Notebook positions are 1-based and include markdown; execution counts (`Out[n]`)
track execution order and can differ. `read_cell_output` pages persisted output
by execution count, while `read_cell(n)` reads a document position. Scratch runs
advance execution counts without adding a saved cell. A reset leaves old outputs
visible until rerun; their presence is not evidence of a successful new replay.

## Cell structure and narrative

1. Explore with `scratch_run` when its attempts do not belong in the artifact.
   Promote every required import, definition, and input into saved cells; do not
   fix only the live kernel and leave the document wrong.
2. Prefer `write_cell` then `run_cell` for incremental authoring. Use `exec_cell`
   when code should execute and append in one step. Bulk document edits are fine
   when intentional; replay is a separate validation step, not an implicit reset.
3. Start with a title and brief motivation: question, intended reader, input
   provenance, and what the notebook produces. Put imports and a configuration
   cell near the top; keep paths and tuning knobs there. State the working
   directory assumption and environment requirements.
4. Give each cell one meaningful step. Group related one-liners; split large
   pipelines at real boundaries. Put reusable definitions in short definition
   cells or tested modules rather than copying them. There is no universal hard
   line-count limit; optimize for a reader inspecting and rerunning the step.
5. Use markdown for rationale, assumptions, interpretation, caveats, and next
   steps; comments for implementation mechanics; outputs for evidence. Label
   coherent groups rather than narrating every one-liner. Keep headings ordered.
6. End computational cells with the value/plot worth displaying; use assertions
   for invariants. Keep intermediate data local and outputs compact. Read long
   saved output instead of rerunning costly work just to see it.

## Review is separate from execution

`request_cell_review({ kernel, n })` presents a saved **code** cell; detached
code/file inputs and markdown cells are not accepted. It never executes code.
Where review is required, save the cell, request review, then execute separately
with `run_cell` only after approval. Rejection or unavailable review UI is not
approval. Small repairs within the approved scope do not need repeated review;
new targets, permissions, destructive effects, or materially increased cost do.
Respect explicit autonomous/no-prompt authorization and the host's policy. A
preview, saved cell, or approval is not a sandbox or enforcement token: kernels
run with the user's permissions. No preview tool makes unsafe replay safe.

# Replay safely

1. Inventory every file write, external request, expensive computation, and
   irreversible operation before replay. Separate acquisition/computation from
   presentation, and choose for each effect: read a validated artifact, use an
   idempotent operation, require explicit opt-in, or leave it unexecuted and
   report the limitation. Do not silently repeat costly or destructive work.
2. Moving heavy work into a module makes it testable, **not automatically
   replay-safe**. Calling that module from a cell still repeats its work. A
   scratch-only computation also cannot support replay unless its result and
   provenance are deliberately persisted and loaded by saved cells.
3. A cache needs identity: input content digests (or immutable revisions), all
   result-affecting configuration, code/method version, Python and dependency
   versions, and remote snapshot identity/freshness policy when relevant. Include
   random seeds where relevant; document manual method-version bumps on code
   changes. A path or file existence is not a completion or freshness check.
4. Define invalidation: identity mismatch, expired remote data, missing or
   malformed records, incomplete writes, and result-schema failures are cache
   misses. Recompute only within the allowed effect/cost scope; otherwise stop
   and explain. Validate completion and schema before reuse. Publish successful
   artifacts with an atomic replacement, not a half-written completion marker.
5. Caching computation is not exactly-once execution of external effects. A
   crash after a remote write but before recording success can repeat the write.
   Use service idempotency keys or explicit reconciliation for those effects.
   A local file guard is not a lock; coordinate concurrent writers separately.
6. Record dependency requirements with the artifact. `provision_dependency`
   installs into the named kernel's environment, which may be shared by other
   kernels; it does not record a replayable setup cell or isolate each notebook.
   Already imported modules keep their loaded versions. Finish authorized
   installs before validation, then reset to load them; document any environment
   changes. Do not put unconditional installers in `run_all`'s execution path.

## Cache example: deterministic local computation

This single-writer sketch assumes top-cell `INPUT` and `CACHE` paths, JSON-safe
`CONFIG`, an explicit `METHOD_VERSION`, `DEPENDENCY_NAMES`, and a deterministic
`compute_rows(INPUT, CONFIG)` returning a list. The input must remain stable while
hashed/computed. Adapt result validation to the actual schema; do not use this
as a remote-effect deduplicator. Bump the method version when the method changes.

```python
import hashlib
import json
import platform
from importlib.metadata import version

identity = {
    "input_sha256": hashlib.sha256(INPUT.read_bytes()).hexdigest(),
    "config": CONFIG,
    "method_version": METHOD_VERSION,
    "python": platform.python_version(),
    "dependencies": {name: version(name) for name in DEPENDENCY_NAMES},
}
record = None
try:
    record = json.loads(CACHE.read_text())
except (OSError, ValueError):
    pass
if (isinstance(record, dict) and record.get("identity") == identity
        and isinstance(record.get("rows"), list)):
    rows = record["rows"]
else:
    rows = compute_rows(INPUT, CONFIG)
    if not isinstance(rows, list):
        raise ValueError("incomplete result: expected a list")
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    pending = CACHE.with_suffix(CACHE.suffix + ".tmp")
    pending.write_text(json.dumps({"identity": identity, "rows": rows}))
    pending.replace(CACHE)
len(rows)
```

JSON round-tripping must preserve the configuration's equality (use lists, not
tuples, and string keys). For non-JSON inputs/results, define an equally explicit
serialization and validation contract instead of treating existence as success.

# Validate and hand off

1. Review the final saved sources and effect guards before resetting. Ensure
   replay has the required inputs, permissions, budget, and dependencies. If it
   cannot safely run, do not claim validation; state the blocker and stale cells.
2. Run `reset_kernel` **then** `run_all`. This is a fresh **namespace**, not a
   fresh Python environment, clean filesystem, or rollback of external effects.
   `run_all` alone (or `run_to`) retains old names and may hide missing setup.
3. Confirm every code cell ran successfully and inspect its new outputs and
   invariants. An early error stops replay: later cells may still show outputs
   from an old run. Repair the saved source/inputs and repeat clean validation,
   not just a scratch patch. `reset_kernel` then `run_to(n)` is useful for a
   partial diagnostic replay, not proof of a whole notebook's validity.
4. Check that no saved computation depends on discarded scratch state, deleted
   cells, or unrecorded module edits. State Python/dependency versions and input
   provenance; keep paths portable from the documented working directory. Audit
   code, outputs, metadata, and artifacts for secrets and machine-specific data.
5. Report the notebook path, purpose, validation performed, environment/input
   assumptions, effect opt-ins, cache invalidation rules, and any replay limits.
   Keep handoff proportional to the artifact; do not invent library curation.
6. Only if library reuse was requested, copy the finished notebook deliberately
   after checking the destination. `provision_kernel(source=...)` executes source
   code while provisioning; audit it before use, not after it starts. See the
   [notebook library](../../docs/notebook-library.md) for lookup/version behavior.
