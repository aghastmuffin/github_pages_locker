import json
import re
import ast
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent
CACHE_DIR = BASE_DIR / "_cache"
OUT_DIR = BASE_DIR / "questionbank"
INDEX_CHUNK = CACHE_DIR / "_app__immutable__chunks__jH9EsrC8.js.body"


def _extract_json_parse_argument(text: str) -> str | None:
    match = re.search(r"JSON\.parse\((['\"`])([\s\S]*)\1\);export", text)
    if not match:
        return None

    quote = match.group(1)
    raw = match.group(2)
    if quote == "`":
        # Some template literals embed already-escaped JSON (e.g. \"), so
        # probe raw first and fall back to unescaping if needed.
        try:
            json.loads(raw)
            return raw
        except Exception:  # noqa: BLE001
            return bytes(raw, "utf-8").decode("unicode_escape")

    # Decode JS-like escaped string literal into plain JSON text.
    return ast.literal_eval(quote + raw + quote)


def main() -> int:
    if not INDEX_CHUNK.exists():
        print(f"Missing index chunk: {INDEX_CHUNK}")
        return 1

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for old in OUT_DIR.glob("*.json"):
        old.unlink()

    source = INDEX_CHUNK.read_text(errors="replace")

    pairs = re.findall(
        r'\.\/questionSets\/([0-9a-f-]{36})\.json"\s*:\s*\(\)\s*=>\s*t\(\(\)\s*=>\s*import\("\.\/([^"\\]+)\.js"\)',
        source,
    )

    extracted = []
    failed = []
    all_quizzes = {}

    for uuid, chunk_id in pairs:
        chunk_file = CACHE_DIR / f"_app__immutable__chunks__{chunk_id}.js.body"
        if not chunk_file.exists():
            failed.append({"uuid": uuid, "chunk": f"{chunk_id}.js", "reason": "missing_chunk_file"})
            continue

        text = chunk_file.read_text(errors="replace")
        parsed_json_text = _extract_json_parse_argument(text)
        if parsed_json_text is None:
            failed.append({"uuid": uuid, "chunk": f"{chunk_id}.js", "reason": "no_json_parse_template"})
            continue

        try:
            questions = json.loads(parsed_json_text)
        except Exception as exc:  # noqa: BLE001
            failed.append(
                {
                    "uuid": uuid,
                    "chunk": f"{chunk_id}.js",
                    "reason": f"json_decode_error: {exc}",
                }
            )
            continue

        payload = {
            "uuid": uuid,
            "chunk": f"{chunk_id}.js",
            "question_count": len(questions) if isinstance(questions, list) else None,
            "questions": questions,
        }
        all_quizzes[uuid] = payload
        extracted.append(
            {
                "uuid": uuid,
                "chunk": f"{chunk_id}.js",
                "question_count": payload["question_count"],
            }
        )

        (OUT_DIR / f"{uuid}.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2))

    (OUT_DIR / "index.json").write_text(
        json.dumps(
            {
                "requested_quizzes": 277,
                "mapped_quizzes": len(pairs),
                "extracted_quizzes": len(extracted),
                "failed_quizzes": len(failed),
                "note": "Cache currently maps 273 quizzes in jH9EsrC8 chunk.",
                "items": extracted,
                "failed": failed,
            },
            indent=2,
        )
    )
    (OUT_DIR / "all_quizzes.json").write_text(json.dumps(all_quizzes, ensure_ascii=False))

    print(f"Mapped: {len(pairs)}")
    print(f"Extracted: {len(extracted)}")
    print(f"Failed: {len(failed)}")
    print(f"Output: {OUT_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
