import os
import re
import json
import hashlib
import base64
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError
 
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR = os.path.join(BASE_DIR, "_cache")
TARGET_HOST = "sat.oly.st"
os.makedirs(CACHE_DIR, exist_ok=True)

UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")


def cache_key(url):
    parsed = urlparse(url)
    slug = parsed.path.lstrip("/").replace("/", "__") or "index"
    if parsed.query:
        slug += "__" + hashlib.md5(parsed.query.encode()).hexdigest()[:8]
    return slug


def save_to_cache(url, status, headers_list, body_b64, is_base64):
    key = cache_key(url)
    meta = {"url": url, "status": status, "headers": headers_list, "is_base64": is_base64}
    with open(os.path.join(CACHE_DIR, key + ".meta"), "w") as f:
        json.dump(meta, f)
    body = base64.b64decode(body_b64) if is_base64 else body_b64.encode("utf-8")
    with open(os.path.join(CACHE_DIR, key + ".body"), "wb") as f:
        f.write(body)


def load_from_cache(path_or_url):
    parsed = urlparse(path_or_url)
    slug = parsed.path.lstrip("/").replace("/", "__") or "index"

    candidates = []
    if parsed.query:
        qhash = hashlib.md5(parsed.query.encode()).hexdigest()[:8]
        candidates.append(slug + "__" + qhash)
    candidates.append(slug)

    chosen = None
    for candidate in candidates:
        body_path = os.path.join(CACHE_DIR, candidate + ".body")
        if os.path.exists(body_path):
            chosen = candidate
            break

    if chosen is None:
        return None, None, None

    meta_path = os.path.join(CACHE_DIR, chosen + ".meta")
    body_path = os.path.join(CACHE_DIR, chosen + ".body")
    with open(meta_path) as f:
        meta = json.load(f)
    with open(body_path, "rb") as f:
        body = f.read()

    headers = meta.get("headers", [])
    if isinstance(headers, list):
        ct = next((h["value"] for h in headers if h.get("name", "").lower() == "content-type"), "")
    elif isinstance(headers, dict):
        ct = headers.get("content-type", "")
    else:
        ct = ""
    return meta.get("status", 200), ct, body


def list_cached_tests():
        tests = set()
        try:
                for name in os.listdir(CACHE_DIR):
                        if not (name.startswith("tests__") and name.endswith(".meta")):
                                continue
                        match = UUID_RE.search(name)
                        if match:
                                tests.add(match.group(0))
        except FileNotFoundError:
                return []
        return sorted(tests)


def render_homepage():
        tests = list_cached_tests()
        items = "\n".join(
                f'<li><a href="/tests/{uuid}">{idx}. /tests/{uuid}</a></li>'
                for idx, uuid in enumerate(tests, start=1)
        )
        if not items:
                items = '<li>No cached tests found in _cache yet.</li>'

        return f"""<!doctype html>
<html lang=\"en\">
<head>
    <meta charset=\"utf-8\" />
    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />
    <title>Cached Tests</title>
    <style>
        :root {{ color-scheme: light; }}
        body {{
            margin: 0;
            font-family: Menlo, Monaco, Consolas, monospace;
            background: #f7f9fc;
            color: #0f172a;
            padding: 24px;
        }}
        h1 {{ margin: 0 0 8px 0; }}
        p {{ margin: 0 0 16px 0; color: #334155; }}
        ul {{ margin: 0; padding-left: 20px; }}
        li {{ margin: 6px 0; }}
        a {{ color: #0066cc; text-decoration: none; }}
        a:hover {{ text-decoration: underline; }}
    </style>
</head>
<body>
    <h1>Available Cached Tests</h1>
    <p>Indexed from sat.oly ({len(tests)} total)</p>
    <ul>{items}</ul>
</body>
</html>
""".encode("utf-8")


def fetch_and_cache_from_upstream(path_with_query):
    upstream_url = f"https://{TARGET_HOST}{path_with_query}"
    request = Request(upstream_url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urlopen(request, timeout=20) as response:
            body = response.read()
            status = getattr(response, "status", 200)
            ct = response.headers.get("Content-Type", "")
    except HTTPError as e:
        body = e.read() if hasattr(e, "read") else b""
        status = e.code
        ct = e.headers.get("Content-Type", "") if e.headers else ""
    except URLError:
        return None, None, None

    lowered_ct = (ct or "").lower()
    # Avoid poisoning cache with upstream challenge/error HTML for JSON data paths.
    if path_with_query.endswith(".json") and (status >= 400 or "text/html" in lowered_ct):
        return None, None, None

    save_to_cache(
        upstream_url,
        status,
        [{"name": "content-type", "value": ct}],
        base64.b64encode(body).decode("ascii"),
        True,
    )
    return status, ct, body

class ReplayHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/":
            body = render_homepage()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        

        if path in ("/ZZM.js", "/ZZT") or path.startswith("/GAMS") or path.startswith("/cdn-cgi"):
            self.send_response(200)
            self.send_header("Content-Type", "application/javascript")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        status, ct, body = load_from_cache(self.path)
        if body is None and parsed.query:
            status, ct, body = load_from_cache(path)

        if body is None:
            status, ct, body = fetch_and_cache_from_upstream(self.path)
            if body is None and parsed.query:
                status, ct, body = fetch_and_cache_from_upstream(path)

        if body is None:
            print(f"[404] {path}")
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b"Not in cache: " + path.encode())
            return

        if isinstance(body, str):
            body = body.encode("utf-8")

        if path.endswith(".js"):      ct = "application/javascript"
        elif path.endswith(".css"):   ct = "text/css"
        elif path.endswith(".json"):  ct = "application/json"
        elif path.endswith(".png"):   ct = "image/png"
        elif path.endswith(".svg"):   ct = "image/svg+xml"
        elif path.endswith(".ico"):   ct = "image/x-icon"
        elif path.endswith(".woff2"): ct = "font/woff2"
        else:                         ct = "text/html; charset=utf-8"

        self.send_response(status or 200)
        self.send_header("Content-Type", ct)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        self.send_response(200)
        self.end_headers()

HTTPServer(("127.0.0.1", 8765), ReplayHandler).serve_forever()