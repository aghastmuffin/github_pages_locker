import csv
import json
import re
import time
from pathlib import Path

import undetected_chromedriver as uc
from selenium.common.exceptions import NoSuchWindowException, WebDriverException


TARGET_URL = "https://sat.oly.st/tests"
UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)
YEAR_RE = re.compile(r"\b(20\d{2})\b")
SEASON_RE = re.compile(r"\b(spring|summer|fall|autumn|winter)\b", re.I)
FORM_RE = re.compile(r"\bform\s*([a-z0-9]+)\b", re.I)
MODULE_RE = re.compile(r"\bmodule\s*([12])\b", re.I)


def parse_fields(text):
    normalized = " ".join((text or "").split())
    season = None
    year = None
    form = None
    module = None
    test_type = None

    s = SEASON_RE.search(normalized)
    if s:
        season = s.group(1).lower()

    y = YEAR_RE.search(normalized)
    if y:
        year = int(y.group(1))

    f = FORM_RE.search(normalized)
    if f:
        form = f.group(1).upper()

    m = MODULE_RE.search(normalized)
    if m:
        module = int(m.group(1))

    low = normalized.lower()
    if "reading" in low and "writing" in low:
        test_type = "reading_writing"
    elif "reading & writing" in low:
        test_type = "reading_writing"
    elif "rw" in low:
        test_type = "reading_writing"
    elif "math" in low:
        test_type = "math"
    elif "full" in low and "test" in low:
        test_type = "full_test"

    return {
        "label": normalized or None,
        "season": season,
        "year": year,
        "form": form,
        "module": module,
        "test_type": test_type,
    }


def collect_cards(driver):
        script = r"""
        const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
        const out = [];

        function uuidsFromNode(node) {
            let cur = node;
            for (let depth = 0; depth < 8 && cur; depth++) {
                const anchors = [...cur.querySelectorAll('a[href]')];
                const list = [];
                for (const a of anchors) {
                    const href = a.href || '';
                    const m = href.match(uuidRe);
                    if (m) {
                        list.push({
                            uuid: m[0].toLowerCase(),
                            href,
                            anchorText: (a.innerText || '').trim(),
                        });
                    }
                }
                if (list.length) {
                    const by = new Map();
                    for (const item of list) {
                        if (!by.has(item.uuid)) by.set(item.uuid, item);
                    }
                    return [...by.values()];
                }
                cur = cur.parentElement;
            }
            return [];
        }

        // 1) Strongest signal: short text nodes containing both "form" and "sat".
        const satFormNodes = [...document.querySelectorAll('*')].filter((el) => {
            const txt = (el.innerText || '').trim();
            if (!txt || txt.length > 180) return false;
            const low = txt.toLowerCase();
            return low.includes('form') && low.includes('sat');
        });
        for (const node of satFormNodes) {
            const hits = uuidsFromNode(node);
            if (!hits.length) continue;
            for (const hit of hits) {
                out.push({
                    uuid: hit.uuid,
                    href: hit.href,
                    anchorText: hit.anchorText,
                    titleText: (node.innerText || '').trim(),
                    containerText: (node.closest('article,li,section,div')?.innerText || '').trim(),
                });
            }
        }

        // 2) Known title style from your note.
        const emeraldNodes = [...document.querySelectorAll('.bg-emerald-200.p-1.font-semibold.text-xl')];
        for (const node of emeraldNodes) {
            const hits = uuidsFromNode(node);
            if (!hits.length) continue;
            for (const hit of hits) {
                out.push({
                    uuid: hit.uuid,
                    href: hit.href,
                    anchorText: hit.anchorText,
                    titleText: (node.innerText || '').trim(),
                    containerText: (node.closest('article,li,section,div')?.innerText || '').trim(),
                });
            }
        }

        // 3) Fallback to UUID links only.
        if (out.length === 0) {
            const anchors = [...document.querySelectorAll('a[href]')];
            for (const a of anchors) {
                const href = a.href || '';
                const m = href.match(uuidRe);
                if (!m) continue;
                const uuid = m[0].toLowerCase();
                const container = a.closest('article,li,section,div');
                out.push({
                    uuid,
                    href,
                    anchorText: (a.innerText || '').trim(),
                    titleText: '',
                    containerText: (container?.innerText || '').trim(),
                });
            }
        }

        const by = new Map();
        for (const row of out) {
            if (!by.has(row.uuid)) by.set(row.uuid, row);
        }

        return {
            rows: [...by.values()],
            debug: {
                satFormNodeCount: satFormNodes.length,
                emeraldNodeCount: emeraldNodes.length,
                dedupedRows: by.size,
            },
        };
        """
        return driver.execute_script(script)


def main():
    root = Path(__file__).resolve().parent.parent
    out_dir = root / "questionbank"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_json = out_dir / "quiz_origin_manifest.json"
    out_csv = out_dir / "quiz_origin_manifest.csv"

    rows = []
    for attempt in range(1, 4):
        options = uc.ChromeOptions()
        driver = uc.Chrome(options=options)
        try:
            driver.get(TARGET_URL)
            print("Opened sat.oly tests page. If Cloudflare challenge appears, complete it in the browser.")
            print(f"Scrape attempt {attempt}/3")
            input("After the real tests page loads in the browser, press ENTER to continue scraping... ")

            deadline = time.time() + 180
            while time.time() < deadline:
                result = collect_cards(driver)
                rows = result.get("rows", [])
                debug = result.get("debug", {})
                if debug:
                    print(
                        "debug "
                        f"satForm={debug.get('satFormNodeCount')} "
                        f"emerald={debug.get('emeraldNodeCount')} "
                        f"rows={debug.get('dedupedRows')}"
                    )
                if len(rows) >= 200:
                    break
                driver.execute_script("window.scrollTo(0, document.body.scrollHeight);")
                time.sleep(1.5)

            if rows:
                break
        except (NoSuchWindowException, WebDriverException) as exc:
            print(f"Browser session interrupted on attempt {attempt}: {exc}")
        finally:
            try:
                driver.quit()
            except Exception:  # noqa: BLE001
                pass

    if not rows:
        print("No quiz rows found after retries. Could not pass challenge or page structure changed.")
        return 1

    manifest = []
    for row in sorted(rows, key=lambda r: r["uuid"]):
        best_text = row.get("titleText") or row.get("containerText") or row.get("anchorText") or ""
        fields = parse_fields(best_text)
        manifest.append(
            {
                "uuid": row["uuid"],
                "url": row["href"],
                "raw_text": best_text,
                **fields,
            }
        )

    payload = {
        "source": TARGET_URL,
        "captured_at_unix": int(time.time()),
        "count": len(manifest),
        "items": manifest,
    }
    out_json.write_text(json.dumps(payload, indent=2, ensure_ascii=False))

    with out_csv.open("w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["uuid", "season", "year", "form", "module", "test_type", "label", "url", "raw_text"])
        for item in manifest:
            writer.writerow(
                [
                    item["uuid"],
                    item["season"] or "",
                    item["year"] or "",
                    item["form"] or "",
                    item["module"] or "",
                    item["test_type"] or "",
                    item["label"] or "",
                    item["url"],
                    item["raw_text"],
                ]
            )

    print(f"Saved {len(manifest)} rows to {out_json}")
    print(f"Saved CSV to {out_csv}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
