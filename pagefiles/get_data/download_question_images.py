import argparse
import base64
import re
import sys
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin
from urllib.request import Request, urlopen

import undetected_chromedriver as uc


IMG_RE = re.compile(r"/images/[^\"'\s)<>]+\.png", re.IGNORECASE)


def collect_image_paths(questionbank_dir: Path) -> list[str]:
	paths: set[str] = set()
	for json_file in questionbank_dir.rglob("*.json"):
		try:
			text = json_file.read_text(encoding="utf-8", errors="ignore")
		except OSError:
			continue
		for match in IMG_RE.findall(text):
			paths.add(match)
	return sorted(paths)


def current_cookie_header(driver) -> str:
	cookies = driver.get_cookies() or []
	return "; ".join(f"{c['name']}={c['value']}" for c in cookies if c.get("name") and c.get("value"))


def browser_fetch(driver, full_url: str) -> bytes | None:
	script = """
	const done = arguments[arguments.length - 1];
	const url = arguments[0];

	fetch(url, { credentials: 'include' })
	  .then(async (res) => {
		if (!res.ok) {
		  done({ ok: false, status: res.status, error: `HTTP ${res.status}` });
		  return;
		}
		const buf = await res.arrayBuffer();
		const bytes = new Uint8Array(buf);
		let binary = '';
		for (let i = 0; i < bytes.length; i++) {
		  binary += String.fromCharCode(bytes[i]);
		}
		done({ ok: true, b64: btoa(binary) });
	  })
	  .catch((err) => done({ ok: false, error: String(err) }));
	"""
	result = driver.execute_async_script(script, full_url)
	if result and result.get("ok") and result.get("b64"):
		return base64.b64decode(result["b64"])
	return None


def download_with_cookies(driver, full_url: str, timeout: int = 20) -> bytes | None:
	ua = driver.execute_script("return navigator.userAgent;")
	cookie_header = current_cookie_header(driver)
	req = Request(
		full_url,
		headers={
			"User-Agent": ua,
			"Referer": full_url,
			"Cookie": cookie_header,
			"Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
		},
	)
	try:
		with urlopen(req, timeout=timeout) as response:
			return response.read()
	except (HTTPError, URLError, TimeoutError):
		return None


def main() -> int:
	parser = argparse.ArgumentParser(
		description="Find /images/*.png references in questionbank JSON and download them locally."
	)
	parser.add_argument("--origin", default="https://sat.oly.st", help="Remote site origin.")
	parser.add_argument(
		"--auth-wait",
		type=int,
		default=120,
		help="Seconds to wait for manual Cloudflare/auth completion in opened browser.",
	)
	parser.add_argument(
		"--only-missing",
		action="store_true",
		help="Skip files that already exist in images/.",
	)
	args = parser.parse_args()

	repo_root = Path(__file__).resolve().parent.parent
	questionbank_dir = repo_root / "questionbank"
	images_dir = repo_root / "images"
	images_dir.mkdir(parents=True, exist_ok=True)

	image_paths = collect_image_paths(questionbank_dir)
	if not image_paths:
		print("No /images/*.png references found in questionbank JSON files.")
		return 0

	print(f"Found {len(image_paths)} unique image paths.")

	options = uc.ChromeOptions()
	driver = uc.Chrome(options=options)

	try:
		driver.get(args.origin)
		print("Opened browser. Complete Cloudflare/auth in this window.")
		if args.auth_wait > 0:
			print(f"Waiting {args.auth_wait}s for manual auth...")
			for remaining in range(args.auth_wait, 0, -1):
				if remaining % 15 == 0 or remaining <= 5:
					print(f"  starting in {remaining}s")
				time.sleep(1)

		downloaded = 0
		skipped = 0
		failed = 0

		start = time.time()
		for idx, path in enumerate(image_paths, start=1):
			local_path = repo_root / path.lstrip("/")
			local_path.parent.mkdir(parents=True, exist_ok=True)

			if args.only_missing and local_path.exists():
				skipped += 1
				continue

			full_url = urljoin(args.origin.rstrip("/") + "/", path.lstrip("/"))

			content = download_with_cookies(driver, full_url)
			if content is None:
				content = browser_fetch(driver, full_url)

			if content is None:
				failed += 1
				print(f"[{idx}/{len(image_paths)}] FAIL {path}")
				continue

			try:
				local_path.write_bytes(content)
			except OSError as exc:
				failed += 1
				print(f"[{idx}/{len(image_paths)}] FAIL write {path}: {exc}")
				continue

			downloaded += 1
			if idx % 25 == 0 or idx == len(image_paths):
				print(f"[{idx}/{len(image_paths)}] downloaded={downloaded} skipped={skipped} failed={failed}")

		elapsed = time.time() - start
		print("\nDone.")
		print(f"Downloaded: {downloaded}")
		print(f"Skipped:    {skipped}")
		print(f"Failed:     {failed}")
		print(f"Elapsed:    {elapsed:.1f}s")

		return 0 if failed == 0 else 2
	finally:
		driver.quit()


if __name__ == "__main__":
	sys.exit(main())
