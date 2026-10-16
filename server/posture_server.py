"""Posture Analysis — clinic server.

Serves the static app and keeps every case in one folder on the clinic server, so all
computers in the clinic see the same cases (no per-computer folders, no internet needed).

    python server/posture_server.py --app . --data D:/AHG/posture/cases --port 5460 \
        --cert D:/AHG/posture/certs/server.crt --key D:/AHG/posture/certs/server.key

The browser only offers "install as app" and offline use on HTTPS, so production runs with
--cert/--key. Without them it serves plain HTTP (tests and local use).

API (all JSON; writes must carry the header `X-Posture: 1`, which a cross-site page cannot
send without a CORS preflight this server never approves):
    GET    /api/ping                 {"ok": true, "name": ...}
    GET    /api/cases                [{"name", "size", "mtime"}]   newest first
    GET    /api/cases/<name>         case file; mtime in X-Mtime
    GET    /api/cases/<name>?meta=1  {"name", "size", "mtime"}
    PUT    /api/cases/<name>         body = case JSON · X-Base-Mtime = mtime the client last saw
                                     ("unknown" = no record) · 409 if another computer saved since
    DELETE /api/cases/<name>         moved to <data>/.trash, never deleted
    GET    /api/settings             clinic-wide settings (logo, muscle chart)
    PUT    /api/settings
Standard library only.
"""
import argparse
import datetime
import json
import mimetypes
import os
import re
import shutil
import ssl
import sys
import threading
import time
import urllib.parse
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_CASE_BYTES = 60 * 1024 * 1024      # a case carries its photos; real cases are a few MB
MAX_SETTINGS_BYTES = 20 * 1024 * 1024
STORE_NAME = "เครื่องกลาง (.63)"
NAME_RE = re.compile(r"^[^\\/:*?\"<>|\x00-\x1f]{1,200}\.json$", re.IGNORECASE)
RESERVED = {"con", "prn", "aux", "nul"} | {f"com{i}" for i in range(1, 10)} | {f"lpt{i}" for i in range(1, 10)}
TYPES = {".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
         ".html": "text/html; charset=utf-8", ".webmanifest": "application/manifest+json",
         ".json": "application/json", ".woff2": "font/woff2", ".png": "image/png",
         ".txt": "text/plain; charset=utf-8", ".zip": "application/zip", ".crt": "application/x-x509-ca-cert",
         ".cmd": "application/octet-stream"}
STATIC_DIRS = ("css", "js", "fonts", "icons", "download")
STATIC_FILES = ("index.html", "terms.html", "sw.js", "manifest.webmanifest")

_write_lock = threading.Lock()


def valid_name(name):
    """A bare case file name: no folders, no dot files, no Windows device names."""
    if not name or not NAME_RE.match(name) or name.startswith(".") or name != name.strip():
        return False
    if name.rstrip(". ") != name:
        return False
    return name.split(".")[0].lower() not in RESERVED


def mtime_ms(path):
    return int(os.stat(path).st_mtime_ns // 1_000_000)


class Store:
    def __init__(self, data_dir):
        self.dir = os.path.abspath(data_dir)
        self.trash = os.path.join(self.dir, ".trash")
        self.audit = os.path.join(self.dir, ".audit.jsonl")
        self.settings = os.path.join(self.dir, ".settings.json")
        os.makedirs(self.trash, exist_ok=True)

    def path(self, name):
        p = os.path.join(self.dir, name)
        if os.path.dirname(os.path.abspath(p)) != self.dir:
            raise ValueError("bad name")
        return p

    def list(self):
        out = []
        with os.scandir(self.dir) as it:
            for e in it:
                if e.is_file() and valid_name(e.name):
                    st = e.stat()
                    out.append({"name": e.name, "size": st.st_size, "mtime": int(st.st_mtime_ns // 1_000_000)})
        out.sort(key=lambda x: -x["mtime"])
        return out

    def log(self, ip, action, name="", size=0, note=""):
        rec = {"ts": datetime.datetime.now().isoformat(timespec="seconds"), "ip": ip,
               "action": action, "name": name, "bytes": size}
        if note:
            rec["note"] = note
        try:
            with open(self.audit, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
        except OSError:
            pass


def atomic_write(path, data):
    tmp = path + ".tmp-%d-%d" % (os.getpid(), threading.get_ident())
    with open(tmp, "wb") as fh:
        fh.write(data)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


class Handler(BaseHTTPRequestHandler):
    server_version = "PostureServer/1"
    timeout = 60                              # a stalled connection frees its thread
    store = None
    app_dir = None

    # ---------------------------------------------------------------- helpers
    def log_message(self, fmt, *args):       # quiet: one line per error only
        if args and str(args[1] if len(args) > 1 else "").startswith(("4", "5")):
            sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    def _send(self, code, body=b"", ctype="application/json; charset=utf-8", headers=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        elif isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _err(self, code, msg):
        self._send(code, {"ok": False, "error": msg})

    def _body(self, limit):
        n = int(self.headers.get("Content-Length") or 0)
        if n > limit:
            raise OverflowError
        return self.rfile.read(n) if n else b""

    def _ip(self):
        return self.client_address[0]

    def _route(self):
        u = urllib.parse.urlsplit(self.path)
        return urllib.parse.unquote(u.path), urllib.parse.parse_qs(u.query)

    def _write_ok(self):
        if self.headers.get("X-Posture") != "1":
            self._err(HTTPStatus.FORBIDDEN, "missing X-Posture header")
            return False
        return True

    # ---------------------------------------------------------------- verbs
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        path, q = self._route()
        if path == "/api/ping":
            return self._send(200, {"ok": True, "name": STORE_NAME}, headers={"Cache-Control": "no-store"})
        if path == "/api/cases":
            return self._send(200, self.store.list(), headers={"Cache-Control": "no-store"})
        if path.startswith("/api/cases/"):
            return self._get_case(path[len("/api/cases/"):], q)
        if path == "/api/settings":
            try:
                with open(self.store.settings, "rb") as fh:
                    data = fh.read()
            except FileNotFoundError:
                data = b"{}"
            return self._send(200, data, headers={"Cache-Control": "no-store"})
        if path.startswith("/api/"):
            return self._err(404, "not found")
        return self._static(path)

    def do_PUT(self):
        path, _ = self._route()
        if not self._write_ok():
            return
        if path.startswith("/api/cases/"):
            return self._put_case(path[len("/api/cases/"):])
        if path == "/api/settings":
            try:
                data = self._body(MAX_SETTINGS_BYTES)
                obj = json.loads(data.decode("utf-8"))
                if not isinstance(obj, dict):
                    raise ValueError
            except OverflowError:
                return self._err(413, "settings too large")
            except (ValueError, UnicodeDecodeError):
                return self._err(400, "settings must be a JSON object")
            clean = {k: obj.get(k) for k in ("logo", "chart") if k in obj}
            with _write_lock:
                atomic_write(self.store.settings, json.dumps(clean, ensure_ascii=False).encode("utf-8"))
            self.store.log(self._ip(), "settings", size=len(data))
            return self._send(200, {"ok": True})
        return self._err(404, "not found")

    def do_DELETE(self):
        path, _ = self._route()
        if not self._write_ok():
            return
        if not path.startswith("/api/cases/"):
            return self._err(404, "not found")
        name = path[len("/api/cases/"):]
        if not valid_name(name):
            return self._err(400, "bad file name")
        p = self.store.path(name)
        with _write_lock:
            if not os.path.isfile(p):
                return self._err(404, "not found")
            stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
            shutil.move(p, os.path.join(self.store.trash, "%s.%s" % (name, stamp)))
        self.store.log(self._ip(), "delete", name)
        return self._send(200, {"ok": True})

    # ---------------------------------------------------------------- cases
    def _get_case(self, name, q):
        if not valid_name(name):
            return self._err(400, "bad file name")
        p = self.store.path(name)
        if not os.path.isfile(p):
            return self._err(404, "not found")
        mt = mtime_ms(p)
        if q.get("meta"):
            return self._send(200, {"name": name, "size": os.path.getsize(p), "mtime": mt},
                              headers={"Cache-Control": "no-store"})
        with open(p, "rb") as fh:
            data = fh.read()
        return self._send(200, data, headers={"X-Mtime": str(mt), "Cache-Control": "no-store"})

    def _put_case(self, name):
        if not valid_name(name):
            return self._err(400, "bad file name")
        try:
            data = self._body(MAX_CASE_BYTES)
            obj = json.loads(data.decode("utf-8"))
            if not isinstance(obj, dict):
                raise ValueError
        except OverflowError:
            return self._err(413, "case too large")
        except (ValueError, UnicodeDecodeError):
            return self._err(400, "case must be a JSON object")
        base = (self.headers.get("X-Base-Mtime") or "unknown").strip()
        p = self.store.path(name)
        with _write_lock:
            exists = os.path.isfile(p)
            if exists and base not in ("unknown",):
                cur = mtime_ms(p)
                if base == "new" or not base.isdigit() or int(base) != cur:
                    self.store.log(self._ip(), "conflict", name, len(data), note="base=%s cur=%d" % (base, cur))
                    return self._send(409, {"ok": False, "error": "conflict", "mtime": cur})
            atomic_write(p, data)
            # keep mtimes strictly increasing so two saves in one millisecond still differ
            mt = mtime_ms(p)
            if exists and base.isdigit() and mt <= int(base):
                t = (int(base) + 1) / 1000.0
                os.utime(p, (t, t))
                mt = mtime_ms(p)
        self.store.log(self._ip(), "save" if exists else "create", name, len(data),
                       note="" if base != "unknown" or not exists else "no-base")
        return self._send(200, {"ok": True, "mtime": mt})

    # ---------------------------------------------------------------- static app
    def _static(self, path):
        rel = path.lstrip("/") or "index.html"
        parts = rel.replace("\\", "/").split("/")
        # no "..", no dot files/folders (.git), and only the app's own files and folders
        if any(not p or p.startswith(".") for p in parts):
            return self._err(404, "not found")
        if not (rel in STATIC_FILES or (parts[0] in STATIC_DIRS and len(parts) > 1)):
            return self._err(404, "not found")
        full = os.path.abspath(os.path.join(self.app_dir, *parts))
        if not full.startswith(self.app_dir + os.sep) or not os.path.isfile(full):
            return self._err(404, "not found")
        ext = os.path.splitext(full)[1].lower()
        ctype = TYPES.get(ext) or mimetypes.guess_type(full)[0] or "application/octet-stream"
        with open(full, "rb") as fh:
            data = fh.read()
        headers = {"Cache-Control": "no-cache"}   # the service worker keeps the offline copy
        if parts[0] == "download":                # always save, never open in the tab
            headers["Content-Disposition"] = 'attachment; filename="%s"' % parts[-1].replace('"', "")
        return self._send(200, data, ctype, headers=headers)


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        # browsers that do not trust the clinic certificate yet, plain-HTTP probes, dropped
        # connections: one line, not a traceback each
        exc = sys.exc_info()[1]
        if isinstance(exc, (ssl.SSLError, ConnectionError, TimeoutError)):
            sys.stderr.write("%s %s: %s\n" % (time.strftime("%H:%M:%S"), client_address[0], exc.__class__.__name__))
            return
        super().handle_error(request, client_address)


def make_server(app_dir, data_dir, host, port, cert=None, key=None):
    store = Store(data_dir)
    handler = type("H", (Handler,), {"store": store, "app_dir": os.path.abspath(app_dir)})
    httpd = Server((host, port), handler)
    if cert and key:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        ctx.load_cert_chain(cert, key)
        # handshake in the request thread, not in accept(): one slow client must not stall the rest
        httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True, do_handshake_on_connect=False)
    return httpd


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--app", default=os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    ap.add_argument("--data", required=True)
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=5460)
    ap.add_argument("--cert")
    ap.add_argument("--key")
    a = ap.parse_args()
    httpd = make_server(a.app, a.data, a.host, a.port, a.cert, a.key)
    print("%s posture server on %s://%s:%d  data=%s" % (
        time.strftime("%Y-%m-%d %H:%M:%S"), "https" if a.cert else "http", a.host, a.port,
        os.path.abspath(a.data)), flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
