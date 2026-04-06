import os, re, json, time, hashlib, threading, base64
from urllib.parse import urlparse, unquote
from http.server import HTTPServer, BaseHTTPRequestHandler
import undetected_chromedriver as uc

# ── Config ──────────────────────────────────────────────────────────────
TARGET_HOST = "sat.oly.st"
BASE_DIR    = os.path.dirname(os.path.abspath(__file__))
SAVE_DIR    = os.environ.get("ARCHIVE_SAVE_DIR", BASE_DIR)
CACHE_DIR   = os.path.join(SAVE_DIR, "_cache")
PORT        = 8765
UUID_RE     = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")

os.makedirs(SAVE_DIR, exist_ok=True)
os.makedirs(CACHE_DIR, exist_ok=True)


# ── Cache helpers ────────────────────────────────────────────────────────
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
    return key

def load_from_cache(path_or_url):
    parsed = urlparse(path_or_url)
    slug = parsed.path.lstrip("/").replace("/", "__") or "index"

    # Try path+query key first (matches save_to_cache/cache_key for URLs with query).
    candidates = []
    if parsed.query:
        qhash = hashlib.md5(parsed.query.encode()).hexdigest()[:8]
        candidates.append(slug + "__" + qhash)
    # Backward-compatible fallback for path-only cache entries.
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
    # Extract content-type string from either format
    headers = meta.get("headers", [])
    if isinstance(headers, list):
        ct = next((h["value"] for h in headers if h.get("name","").lower() == "content-type"), "")
    elif isinstance(headers, dict):
        ct = headers.get("content-type", "")
    else:
        ct = ""
    return meta["status"], ct, body



# ── Local replay server ──────────────────────────────────────────────────
class ReplayHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # silence logs

    def do_GET(self):
        # Strip query string for cache lookup (most assets are immutable)
        path = urlparse(self.path).path
        status, headers, body = load_from_cache(path)
        if body is None:
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b"Not in cache: " + path.encode())
            return

        self.send_response(status or 200)
        sent_types = set()
        for h in (headers or []):
            name, val = h["name"], h["value"]
            # Skip headers that would break local serving
            if name.lower() in ("content-encoding", "transfer-encoding",
                                 "content-length", "alt-svc", "cf-ray",
                                 "nel", "report-to", "server-timing"):
                continue
            # Relax CSP so modules load from localhost
            if name.lower() == "content-security-policy":
                continue
            # Fix cross-origin for modules
            if name.lower() == "cross-origin-opener-policy":
                continue
            if name.lower() == "content-type" and name.lower() not in sent_types:
                sent_types.add(name.lower())
                self.send_header(name, val)
        # Ensure JS gets correct MIME so browser treats it as a module
        if path.endswith(".js") and "content-type" not in sent_types:
            self.send_header("Content-Type", "application/javascript")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        # Silently swallow analytics/zaraz posts
        self.send_response(200)
        self.end_headers()

def start_server():
    server = HTTPServer(("127.0.0.1", PORT), ReplayHandler)
    server.serve_forever()


# ── CDP response capture ─────────────────────────────────────────────────
captured = {}

def setup_capture(driver):
    """Enable CDP network interception and capture all sat.oly.st responses."""
    driver.execute_cdp_cmd("Network.enable", {})

    # Patch via JS fetch interception is unreliable; use CDP's getResponseBody after load.
    # We'll poll for new network events using a JS-injected XHR intercept + CDP.
    # Simpler: use Page.captureSnapshot approach for asset sniping.
    pass  # CDP event listeners aren't directly available in selenium; use JS bridge below.


def capture_all_responses(driver):
    """
    After page is fully loaded, use CDP to enumerate and save all network
    responses from sat.oly.st that are now in the browser's cache.
    """
    # Get all resource URLs from the page
    resources = driver.execute_script("""
        return performance.getEntriesByType('resource')
            .map(r => r.name)
            .filter(u => u.includes('sat.oly.st') || u.startsWith('/'));
    """)
    # Also grab the main document URL
    resources.insert(0, driver.current_url)

    # Preload likely SvelteKit data endpoints that may not appear in performance entries.
    current_parsed = urlparse(driver.current_url)
    if TARGET_HOST in current_parsed.netloc:
        base = f"https://{TARGET_HOST}{current_parsed.path.rstrip('/')}"
        if current_parsed.path.startswith("/tests"):
            resources.append(base + "/__data.json")

    saved = 0
    for url in resources:
        if not url.startswith("http"):
            continue
        parsed = urlparse(url)
        if TARGET_HOST not in parsed.netloc:
            continue
        key = cache_key(url)
        body_path = os.path.join(CACHE_DIR, key + ".body")
        if os.path.exists(body_path):
            continue  # already cached
        try:
            # Use fetch from the page context to grab the cached response
            result = driver.execute_script("""
                const url = arguments[0];
                return fetch(url, {cache: 'force-cache', credentials: 'include'})
                    .then(async r => {
                        const ct = r.headers.get('content-type') || '';
                        const status = r.status || 200;
                        const buf = await r.arrayBuffer();
                        const bytes = new Uint8Array(buf);
                        let binary = '';
                        bytes.forEach(b => binary += String.fromCharCode(b));
                        return {
                            ok: true,
                            status,
                            b64: btoa(binary),
                            ct
                        };
                    })
                    .catch(e => ({ok: false, error: e.toString()}));
            """, url)
            if result and result.get("ok"):
                status = int(result.get("status", 200))
                ct = (result.get("ct") or "").lower()
                # Do not cache challenge/error HTML as JSON data endpoints.
                if url.endswith("/__data.json") and (status >= 400 or "text/html" in ct):
                    continue
                save_to_cache(url, status,
                              [{"name": "content-type", "value": result.get("ct", "")}],
                              result["b64"], True)
                saved += 1
        except Exception as e:
            pass
    return saved

if __name__ == "__main__":
# ── Main ─────────────────────────────────────────────────────────────────
    options = uc.ChromeOptions()
    driver = uc.Chrome(options=options)

    driver.get(f"https://{TARGET_HOST}")
    input("Pass Cloudflare check, then press ENTER...")

    # Navigate to tests list to get all UUIDs
    driver.get(f"https://{TARGET_HOST}/tests")
    time.sleep(3)

    # Collect all test links
    elements = driver.find_elements("xpath", "//a[@href]")
    test_urls = set()
    for el in elements:
        href = el.get_attribute("href") or ""
        if UUID_RE.search(href) and TARGET_HOST in href:
            test_urls.add(href)

    print(f"[+] Found {len(test_urls)} tests")

    # Visit each test, wait for full load, capture assets
    for i, url in enumerate(sorted(test_urls)):
        uuid = UUID_RE.search(url).group(0)
        print(f"[{i+1}/{len(test_urls)}] Warming cache for {uuid}...")
        driver.get(url)

        # Wait for SvelteKit to finish loading question data
        for _ in range(30):
            time.sleep(0.5)
            loaded = driver.execute_script(
                "return document.readyState === 'complete' && "
                "document.body.innerText.length > 300"
            )
            if loaded:
                break
        time.sleep(1.5)  # extra buffer for async chunk imports

        n = capture_all_responses(driver)
        print(f"    Cached {n} new assets")

    print("\n[+] Cache warm. Starting local replay server...")

    # Start server in background
    t = threading.Thread(target=start_server, daemon=True)
    t.start()
    print(f"[+] Serving at http://127.0.0.1:{PORT}")

    # Now open each test from localhost
    print("\nOpening tests from localhost — buttons and timer should now work.\n")
    print("Tests available at:")
    for url in sorted(test_urls):
        uuid = UUID_RE.search(url).group(0)
        local_url = f"http://127.0.0.1:{PORT}/tests/{uuid}"
        print(f"  {local_url}")

    # Open the first one to demo
    first_uuid = UUID_RE.search(sorted(test_urls)[0]).group(0)
    driver.get(f"http://127.0.0.1:{PORT}/tests/{first_uuid}")

    input("\nPress ENTER to quit...")
    driver.quit()