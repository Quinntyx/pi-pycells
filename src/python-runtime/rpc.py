import asyncio
import json
import sys
import threading
from typing import Any, Dict, Optional

"""JSONL control transport for the persistent notebook runtime.

Host-initiated exec/export_script/inspect frames are dispatched to a registered
execution handler. There is no Python-to-host-tool request channel. Malformed frames are skipped and logged; the client
disconnects only on EOF or 100 consecutive malformed frames.
"""

_ptc_rpc_asyncio = asyncio

# Startup guard: the runtime relies on PEP 604 unions in *evaluated* annotations
# (``int | None`` at def-time raises TypeError on <=3.9) and on
# ``ast.FunctionDef.type_params`` (Python 3.12+). Fail fast with a clear message
# instead of an opaque TypeError deep in the prelude — SubprocessSandbox can
# fall back to a bare `python3` that is older than the tool's configured one.
if sys.version_info < (3, 10):
    raise RuntimeError(
        f"PTC Python runtime requires Python 3.10+ (found {sys.version.split()[0]}). "
        "The runtime uses PEP 604 unions in evaluated annotations and AST "
        "type_params; older interpreters fail at definition time. Point "
        "PTC_PYTHON / the sandbox at a Python >= 3.10 interpreter."
    )

# L9 trip-wire: a single malformed stdin line is skipped and logged, but a
# stream that produces this many consecutive bad frames is genuinely broken
# (e.g. a binary blob piped into the protocol) and must not be spun on forever.
_MAX_CONSECUTIVE_MALFORMED_FRAMES = 100


class RpcProtocolError(Exception):
    """Raised for transport-level failures: EOF on stdin, a garbage frame stream,
    or client shutdown with calls still pending."""
    pass


async def _connect_stdin_reader(reader: asyncio.StreamReader, stdin: Any = None) -> None:
    """Attach `reader` to stdin, tolerating event loops without pipe support.

    `loop.connect_read_pipe(sys.stdin)` raises NotImplementedError on Windows
    ProactorEventLoop (the default since 3.8). Fall back to a daemon thread that
    blocks on `stdin.buffer.readline()` and feeds the same StreamReader via
    `call_soon_threadsafe`, so the protocol loop above is identical everywhere.
    """
    if stdin is None:
        stdin = sys.stdin
    loop = asyncio.get_running_loop()
    try:
        protocol = asyncio.StreamReaderProtocol(reader)
        await loop.connect_read_pipe(lambda: protocol, stdin)
        return
    except NotImplementedError:
        pass  # Windows ProactorEventLoop: use the threaded reader below

    def _pump() -> None:
        try:
            while True:
                line = stdin.buffer.readline() if hasattr(stdin, "buffer") else stdin.readline()
                loop.call_soon_threadsafe(reader.feed_data, line)
                if not line:
                    break  # EOF
        except Exception as error:  # broken/closed stdin
            loop.call_soon_threadsafe(reader.feed_error, error)
        finally:
            loop.call_soon_threadsafe(reader.feed_eof)

    threading.Thread(target=_pump, name="ptc-stdin-reader", daemon=True).start()


class RpcClient:
    """Notebook control client over stdin/stdout JSONL frames, dispatching
    host-initiated exec-family frames in persistent-session mode."""

    def __init__(self):
        self.error: Exception | None = None
        self.reader_task: Optional[asyncio.Task[Any]] = None
        # Persistent-session mode: the host sends {"type":"exec",...} frames on
        # the same stdin pipe; a registered handler receives them.
        self.exec_handler = None
        # Set when the host closes stdin (EOF) or the pipe breaks; the session
        # exec loop waits on this to shut down.
        self.disconnected = _ptc_rpc_asyncio.Event()

    def set_exec_handler(self, handler) -> None:
        """Register the callback that receives host "exec"/"export_script"/"inspect"/
        "doc" frames (persistent-session mode)."""
        self.exec_handler = handler

    async def start_reader(self) -> None:
        """Start the background stdin reader task."""
        self.reader_task = asyncio.create_task(self._stdin_reader())

    def _record_failure(self, error: Exception) -> None:
        self.error = error

    async def _stdin_reader(self) -> None:
        """Read stdin until EOF: route responses to pending calls, hand exec-family
        frames to the handler, and skip malformed lines. Disconnects (failing all
        pending calls) on EOF or 100 consecutive malformed/undecodable frames."""
        malformed_streak = 0
        try:
            reader = asyncio.StreamReader()
            await _connect_stdin_reader(reader)

            while True:
                line = await reader.readline()
                if not line:
                    self._record_failure(RpcProtocolError("Notebook host closed stdin"))
                    break

                try:
                    response = json.loads(line.decode().strip())
                    malformed_streak = 0
                    self._handle_response(response)
                except json.JSONDecodeError as error:
                    # L9: one malformed frame must not kill the whole persistent
                    # session. Skip the line, log it, and only disconnect when
                    # the stream is consistently garbage (trip-wire above).
                    malformed_streak += 1
                    print(
                        f"skipping malformed RPC frame ({malformed_streak} consecutive): "
                        f"JSON decode error: {error}",
                        file=sys.stderr,
                    )
                    if malformed_streak >= _MAX_CONSECUTIVE_MALFORMED_FRAMES:
                        self._record_failure(
                            RpcProtocolError(
                                f"RPC stream produced {malformed_streak} consecutive malformed frames; giving up"
                            )
                        )
                        print("stdin reader: too many consecutive malformed frames; disconnecting", file=sys.stderr)
                        break
                except Exception as error:
                    # A bad frame must not tear down the session either; but a
                    # handler that throws repeatedly is the same broken-stream
                    # case, so it feeds the same trip-wire.
                    malformed_streak += 1
                    print(
                        f"skipping undecodable RPC frame ({malformed_streak} consecutive): {error}",
                        file=sys.stderr,
                    )
                    if malformed_streak >= _MAX_CONSECUTIVE_MALFORMED_FRAMES:
                        self._record_failure(
                            RpcProtocolError(
                                f"RPC stream produced {malformed_streak} consecutive undecodable frames; giving up"
                            )
                        )
                        print("stdin reader: too many consecutive malformed frames; disconnecting", file=sys.stderr)
                        break
        except asyncio.CancelledError:
            pass
        except Exception as error:
            self._record_failure(error if isinstance(error, Exception) else RpcProtocolError(str(error)))
            print(f"stdin reader error: {error}", file=sys.stderr)
        finally:
            self.disconnected.set()

    def _handle_response(self, response: Dict[str, Any]) -> None:
        """Only dispatch notebook control frames; no host-tool invocation channel."""
        if response.get("type") not in ("exec", "export_script", "inspect", "doc"):
            raise RpcProtocolError(f"Unsupported notebook control frame: {response.get('type')}")
        if self.exec_handler is not None:
            self.exec_handler(response)

    async def cleanup(self) -> None:
        """Cancel the notebook control reader. Idempotent."""
        self._record_failure(RpcProtocolError("RPC client shut down"))
        if self.reader_task:
            self.reader_task.cancel()
            try:
                await self.reader_task
            except asyncio.CancelledError:
                pass
            self.reader_task = None


_rpc = RpcClient()

# Per-cell tool-call ledger. session.py clears this at the start of each exec
# and summarizes it into the cell's model-facing `tools:` section, so the model
# can see which Pi tools a cell used and how often.
