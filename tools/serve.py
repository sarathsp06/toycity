#!/usr/bin/env python3
"""Local web server for the toy city that always serves fresh files.

Usage: python3 tools/serve.py [PORT] [--snap FILE.png]
Every response carries Cache-Control: no-cache, so a normal reload picks up re-baked squares and
a re-exported person.glb without version numbers in URLs. Browsers still revalidate cheaply:
unchanged files answer 304 Not Modified.
"""
import functools
import http.server
import os
import sys


class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, *a):
        pass

    def do_POST(self):
        # development aid: the preview page can POST a PNG of its canvas, saved as snap.png
        if self.path != "/_snap" or not SNAP:
            self.send_error(404); return
        n = int(self.headers.get("Content-Length", 0))
        if n > 20_000_000:
            self.send_error(413); return
        with open(SNAP, "wb") as f:
            f.write(self.rfile.read(n))
        self.send_response(204); self.end_headers()


SNAP = None


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    if "--snap" in sys.argv:
        SNAP = sys.argv[sys.argv.index("--snap") + 1]
    web = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web")
    http.server.ThreadingHTTPServer(("127.0.0.1", port), functools.partial(NoCache, directory=web)).serve_forever()
