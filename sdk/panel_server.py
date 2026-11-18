"""Small loopback HTTP server for a plugin's right-column panel. Standard library only.

The server can stop processes and containers, and any web page open in the user's browser can send
requests to 127.0.0.1. So:
  - it binds 127.0.0.1 only;
  - the Host header must be `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding);
  - an Origin header, when present, must be this server's own origin;
  - every /api/ request (reads too) carries the per-run token in the `X-Panel-Token` header; the page
    gets the token inside its HTML (a meta tag), which another origin cannot read;
  - requests that change state are POST with `Content-Type: application/json`;
  - no CORS header is ever sent; the page may not be framed; static files come from `ui/` only, by
    plain names (no folders, no `..`).
Route handlers get (query, body) and return a JSON-able dict, or raise ApiError.
"""
from __future__ import annotations

import hmac
import http.server
import json
import os
import re
import secrets
import threading
import time
import urllib.parse

TOKEN_HEADER = "X-Panel-Token"
TOKEN_MARK = "__PANEL_TOKEN__"
MAX_BODY = 64 * 1024
STATIC_NAME = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}\.(html|css|js|svg|png)$")
TYPES = {"html": "text/html; charset=utf-8", "css": "text/css; charset=utf-8",
         "js": "text/javascript; charset=utf-8", "svg": "image/svg+xml", "png": "image/png"}
CSP = ("default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; "
       "font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")


class ApiError(Exception):
    """An answer other than 200: (status, Turkish message for the page)."""

    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


class Cached:
    """fn() kept for `ttl` seconds and shared by every caller; concurrent callers wait for one run."""

    def __init__(self, fn, ttl=2.0, clock=time.monotonic):
        self.fn = fn
        self.ttl = ttl
        self.clock = clock
        self.lock = threading.Lock()
        self.value = None
        self.at = None

    def get(self, max_age=None):
        max_age = self.ttl if max_age is None else max_age
        with self.lock:
            if self.at is not None and max_age > 0 and self.clock() - self.at <= max_age:
                return self.value
            value = self.fn()
            self.value, self.at = value, self.clock()
            return value

    def clear(self):
        with self.lock:
            self.at = None


class _Server(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False

    def handle_error(self, request, client_address):   # a client that went away is not worth a traceback
        pass


class PanelServer:
    def __init__(self, port, ui_dir, get_routes=None, post_routes=None, log=None, token=None):
        self.port = int(port)
        self.ui_dir = os.path.realpath(ui_dir)
        self.get_routes = dict(get_routes or {})
        self.post_routes = dict(post_routes or {})
        self.log = log or (lambda message: None)
        self.token = token or secrets.token_urlsafe(32)
        self.hosts = {"127.0.0.1:%d" % self.port, "localhost:%d" % self.port}
        self.origins = {"http://" + h for h in self.hosts}
        self.httpd = None

    def start(self):
        """Bind and serve on a daemon thread. Raises OSError when the port cannot be bound."""
        handler = type("Handler", (_Handler,), {"panel": self})
        self.httpd = _Server(("127.0.0.1", self.port), handler)
        threading.Thread(target=self.httpd.serve_forever, kwargs={"poll_interval": 0.25},
                         daemon=True, name="panel-http").start()
        return self

    def stop(self):
        if self.httpd:
            self.httpd.shutdown()
            self.httpd.server_close()

    def token_ok(self, value):
        return isinstance(value, str) and hmac.compare_digest(value.encode(), self.token.encode())


class _Handler(http.server.BaseHTTPRequestHandler):
    panel = None   # set on the subclass
    server_version = "cave-panel"
    sys_version = ""
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):   # no access log on stderr (it goes to cave.log)
        pass

    # ---- answers ----

    def _send(self, status, body, ctype):
        # One request per connection: a refused request may leave its body unread on the socket.
        self.close_connection = True
        self.send_response(status)
        self.send_header("Connection", "close")
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", CSP)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, status, obj):
        self._send(status, json.dumps(obj, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def _error(self, status, message):
        self._json(status, {"hata": message})

    # ---- checks shared by every method ----

    def _gate(self):
        """True when the request may go on; else the refusal has been sent and it is False."""
        panel = self.panel
        if self.headers.get("Host", "") not in panel.hosts:
            self._error(403, "Bu adres yalnız Cave içinden açılır.")
            return False
        origin = self.headers.get("Origin")
        if origin is not None and origin not in panel.origins:
            self._error(403, "Başka bir sayfadan gelen istek reddedildi.")
            return False
        return True

    def _split(self):
        parsed = urllib.parse.urlsplit(self.path)
        query = {k: v[-1] for k, v in urllib.parse.parse_qs(parsed.query, keep_blank_values=True).items()}
        return parsed.path, query

    # ---- methods ----

    def do_GET(self):
        if not self._gate():
            return
        path, query = self._split()
        if path.startswith("/api/"):
            if not self.panel.token_ok(self.headers.get(TOKEN_HEADER)):
                return self._error(403, "Belirteç eksik ya da yanlış.")
            return self._route(self.panel.get_routes, path, query, None)
        self._static(path)

    do_HEAD = do_GET

    def do_POST(self):
        if not self._gate():
            return
        path, query = self._split()
        if not path.startswith("/api/"):
            return self._error(405, "Yalnız okunur.")
        if not self.panel.token_ok(self.headers.get(TOKEN_HEADER)):
            return self._error(403, "Belirteç eksik ya da yanlış.")
        ctype = self.headers.get("Content-Type", "").split(";")[0].strip().lower()
        if ctype != "application/json":
            return self._error(415, "İstek JSON olmalı.")
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = -1
        if length < 0 or length > MAX_BODY:
            return self._error(413, "İstek çok büyük.")
        try:
            body = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
        except (ValueError, UnicodeDecodeError):
            return self._error(400, "İstek okunamadı.")
        if not isinstance(body, dict):
            return self._error(400, "İstek okunamadı.")
        self._route(self.panel.post_routes, path, query, body)

    def _refuse_method(self):
        if self._gate():
            self._error(405, "Bu yöntem yok.")

    do_PUT = do_DELETE = do_PATCH = do_OPTIONS = _refuse_method

    def _route(self, routes, path, query, body):
        fn = routes.get(path)
        if fn is None:
            return self._error(404, "Böyle bir uç yok.")
        try:
            result = fn(query, body)
        except ApiError as exc:
            return self._error(exc.status, exc.message)
        except Exception as exc:   # a broken handler answers 500, never kills the server
            self.panel.log("panel %s failed: %r" % (path, exc))
            return self._error(500, "Beklenmeyen bir hata oldu.")
        self._json(200, result if isinstance(result, dict) else {})

    def _static(self, path):
        name = "index.html" if path in ("/", "") else path.lstrip("/")
        if not STATIC_NAME.match(name):
            return self._error(404, "Bulunamadı.")
        full = os.path.realpath(os.path.join(self.panel.ui_dir, name))
        if os.path.dirname(full) != self.panel.ui_dir or not os.path.isfile(full):
            return self._error(404, "Bulunamadı.")
        with open(full, "rb") as fh:
            data = fh.read()
        ext = name.rsplit(".", 1)[1]
        if ext == "html":
            data = data.replace(TOKEN_MARK.encode(), self.panel.token.encode())
        self._send(200, data, TYPES[ext])
