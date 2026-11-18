"""Minimal client for Cave's plugin service protocol (manifest format 2, stdio).

JSON-RPC 2.0, one message per line over stdin/stdout, standard library only.
Threads: the main thread reads stdin; events run one at a time on a dispatcher
thread (in arrival order); each command.run gets its own thread; periodic jobs
have one thread each. `call` is safe from any thread except the reader.
"""
from __future__ import annotations

import collections
import json
import sys
import threading
import time

# Cave answers rate_limited above 50 requests in 10 s; stay well under it.
RATE_LIMIT_REQUESTS = 40
RATE_LIMIT_WINDOW = 10.0


class HostError(Exception):
    """An error answer from Cave (or a local failure: code `timeout` / `closed`)."""

    def __init__(self, code, message="", data=None):
        super().__init__("%s: %s" % (code, message) if message else str(code))
        self.code = code
        self.message = message
        self.data = data


class Periodic:
    """A job run every `seconds`; `kick()` runs it again as soon as possible."""

    def __init__(self, plugin, seconds, fn, immediate=True):
        self._plugin = plugin
        self._seconds = seconds
        self._fn = fn
        self._immediate = immediate
        self._kick = threading.Event()
        self._started = False

    def kick(self):
        self._kick.set()

    def wake(self):
        self._kick.set()

    def _start(self):
        if self._started:
            return
        self._started = True
        threading.Thread(target=self._loop, daemon=True, name="every-%s" % getattr(self._fn, "__name__", "job")).start()

    def _loop(self):
        stop = self._plugin.stopping
        if not self._immediate:
            self._kick.wait(self._seconds)
        while not stop.is_set():
            self._kick.clear()
            try:
                self._fn()
            except Exception as exc:  # a failing job never kills the service
                self._plugin.log("periodic job %s failed: %r" % (getattr(self._fn, "__name__", "?"), exc))
            if stop.is_set():
                return
            self._kick.wait(self._seconds)


class Plugin:
    def __init__(self, stdin=None, stdout=None, stderr=None):
        self._in = stdin if stdin is not None else sys.stdin
        self._out = stdout if stdout is not None else sys.stdout
        self._err = stderr if stderr is not None else sys.stderr
        self._out_lock = threading.Lock()
        self._err_lock = threading.Lock()
        self._pending = {}
        self._pending_lock = threading.Lock()
        self._next_id = 1
        self._sent = collections.deque()
        self._rate_lock = threading.Lock()
        self._events = {}
        self._commands = {}
        self._periodics = []
        self._queue = collections.deque()
        self._queue_cv = threading.Condition()
        self._initialized = threading.Event()
        self.stopping = threading.Event()
        self.granted = []
        self.data_dir = None
        self.port = None
        self.id = None
        self.version = None
        self.dir = None

    # ---- registration -------------------------------------------------

    def on_event(self, name):
        def register(handler):
            self._events.setdefault(name, []).append(handler)
            return handler
        return register

    def on_command(self, command_id):
        def register(handler):
            self._commands[command_id] = handler
            return handler
        return register

    def every(self, seconds, fn, immediate=True):
        job = Periodic(self, seconds, fn, immediate)
        self._periodics.append(job)
        if self._initialized.is_set():
            job._start()
        return job

    # ---- output -------------------------------------------------------

    def log(self, message):
        with self._err_lock:
            try:
                self._err.write(str(message).replace("\n", " ")[:1500] + "\n")
                self._err.flush()
            except (OSError, ValueError):
                pass

    def _send(self, obj):
        line = json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n"
        with self._out_lock:
            try:
                self._out.write(line)
                self._out.flush()
            except (OSError, ValueError):
                self._shutdown()
                raise HostError("closed", "stdout closed")

    def notify(self, method, params=None):
        msg = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            msg["params"] = params
        self._send(msg)

    def call(self, method, params=None, timeout=5):
        if self.stopping.is_set():
            raise HostError("closed", "service is stopping")
        self._throttle()
        with self._pending_lock:
            req_id = self._next_id
            self._next_id += 1
            slot = {"event": threading.Event(), "reply": None}
            self._pending[req_id] = slot
        msg = {"jsonrpc": "2.0", "id": req_id, "method": method}
        if params is not None:
            msg["params"] = params
        try:
            self._send(msg)
        except HostError:
            with self._pending_lock:
                self._pending.pop(req_id, None)
            raise
        if not slot["event"].wait(timeout):
            with self._pending_lock:
                self._pending.pop(req_id, None)
            raise HostError("timeout", "no answer to %s in %ss" % (method, timeout))
        reply = slot["reply"]
        if reply is None:
            raise HostError("closed", "connection closed")
        if "error" in reply and reply["error"] is not None:
            err = reply["error"] if isinstance(reply["error"], dict) else {}
            data = err.get("data") if isinstance(err.get("data"), dict) else {}
            raise HostError(data.get("code") or err.get("code") or "error", err.get("message", ""), data)
        result = reply.get("result")
        return result if result is not None else {}

    def _throttle(self):
        while True:
            with self._rate_lock:
                now = time.monotonic()
                while self._sent and now - self._sent[0] > RATE_LIMIT_WINDOW:
                    self._sent.popleft()
                if len(self._sent) < RATE_LIMIT_REQUESTS:
                    self._sent.append(now)
                    return
                wait = RATE_LIMIT_WINDOW - (now - self._sent[0]) + 0.01
            if self.stopping.wait(wait):
                return

    # ---- input --------------------------------------------------------

    def run(self):
        """Main loop; returns after `shutdown` or end of stdin."""
        threading.Thread(target=self._dispatch_loop, daemon=True, name="events").start()
        try:
            while not self.stopping.is_set():
                line = self._in.readline()
                if not line:
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except ValueError:
                    self.log("bad json line ignored")
                    continue
                if not isinstance(msg, dict):
                    continue
                try:
                    self._handle(msg)
                except Exception as exc:
                    self.log("message handling failed: %r" % (exc,))
        finally:
            self._shutdown()

    def _shutdown(self):
        self.stopping.set()
        with self._queue_cv:
            self._queue_cv.notify_all()
        for job in self._periodics:
            job.wake()
        with self._pending_lock:
            pending, self._pending = self._pending, {}
        for slot in pending.values():
            slot["event"].set()

    def _handle(self, msg):
        method = msg.get("method")
        if method is None:
            if "id" in msg:
                with self._pending_lock:
                    slot = self._pending.pop(msg["id"], None)
                if slot is not None:
                    slot["reply"] = msg
                    slot["event"].set()
            return
        params = msg.get("params") if isinstance(msg.get("params"), dict) else {}
        has_id = "id" in msg
        if method == "initialize" and has_id:
            self._on_initialize(msg["id"], params)
        elif method == "shutdown":
            self._shutdown()
        elif method == "event" and not has_id:
            with self._queue_cv:
                self._queue.append(params)
                self._queue_cv.notify()
        elif method == "command.run" and has_id:
            threading.Thread(target=self._run_command, args=(msg["id"], params), daemon=True, name="command").start()
        elif has_id:
            self._reply_error(msg["id"], "unknown_method", "unknown method %s" % method, -32601)

    def _on_initialize(self, req_id, params):
        info = params.get("plugin") if isinstance(params.get("plugin"), dict) else {}
        self.id = info.get("id")
        self.version = info.get("version")
        self.dir = info.get("dir")
        self.data_dir = info.get("dataDir")
        caps = params.get("capabilities")
        self.granted = list(caps) if isinstance(caps, list) else []
        self.port = params.get("port")
        self._send({"jsonrpc": "2.0", "id": req_id, "result": {}})
        self._initialized.set()
        for job in self._periodics:
            job._start()

    def _reply_error(self, req_id, code, message, numeric=-32000):
        try:
            self._send({"jsonrpc": "2.0", "id": req_id,
                        "error": {"code": numeric, "message": message, "data": {"code": code}}})
        except HostError:
            pass

    def _run_command(self, req_id, params):
        handler = self._commands.get(params.get("id"))
        if handler is None:
            self._reply_error(req_id, "not_found", "unknown command %s" % params.get("id"))
            return
        try:
            result = handler(params)
        except Exception as exc:
            self.log("command %s failed: %r" % (params.get("id"), exc))
            self._reply_error(req_id, "action_failed", str(exc))
            return
        if isinstance(result, str):
            result = {"message": result}
        elif not isinstance(result, dict):
            result = {}
        try:
            self._send({"jsonrpc": "2.0", "id": req_id, "result": result})
        except HostError:
            pass

    def _dispatch_loop(self):
        while True:
            with self._queue_cv:
                while not self._queue and not self.stopping.is_set():
                    self._queue_cv.wait()
                if self.stopping.is_set():
                    return
                params = self._queue.popleft()
            name = params.get("name")
            data = params.get("data") if isinstance(params.get("data"), dict) else {}
            for handler in list(self._events.get(name, [])):
                try:
                    handler(data)
                except Exception as exc:
                    self.log("event %s handler failed: %r" % (name, exc))
