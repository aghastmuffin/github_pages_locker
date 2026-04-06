import argparse
import base64
import hashlib
import json
import mimetypes
import os
import random
import secrets
import shutil
from pathlib import Path

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

try:
    from tqdm import tqdm
except ImportError as exc:  # pragma: no cover - import guard for CLI use
    raise SystemExit("Missing dependency 'tqdm'. Install it with: pip install tqdm") from exc


PBKDF2_ITERATIONS = 200000
SALT_LEN = 16
NONCE_LEN = 12
PART_C_LEN = 16
OP_DEFINE_FILE = 0x01


def derive_part_b(password: str, salt: bytes) -> bytes:
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=PBKDF2_ITERATIONS,
    )
    return kdf.derive(password.encode("utf-8"))


def derive_split_key(part_a: bytes, part_b: bytes, part_c: bytes) -> bytes:
    digest = hashes.Hash(hashes.SHA256())
    digest.update(part_a)
    digest.update(part_b)
    digest.update(part_c)
    return digest.finalize()


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def b64e(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def encrypt_instruction(instruction: bytes, part_a: bytes, part_b: bytes) -> dict:
    part_c = os.urandom(PART_C_LEN)
    nonce = os.urandom(NONCE_LEN)
    key = derive_split_key(part_a, part_b, part_c)
    aesgcm = AESGCM(key)
    ciphertext = aesgcm.encrypt(nonce, instruction, None)
    return {
        "v": 1,
        "partC_b64": b64e(part_c),
        "nonce_b64": b64e(nonce),
        "ciphertext_b64": b64e(ciphertext),
        "bytecode_sha256": sha256_hex(instruction),
    }


def collect_source_files(source_dir: Path, include_hidden: bool) -> list[Path]:
    files: list[Path] = []
    for path in sorted(source_dir.rglob("*")):
        if not path.is_file():
            continue

        rel_parts = path.relative_to(source_dir).parts
        if not include_hidden and any(part.startswith(".") for part in rel_parts):
            continue

        files.append(path)

    return files


def build_define_file_instruction(logical_path: str, mime: str, data: bytes) -> bytes:
    path_bytes = logical_path.encode("utf-8")
    mime_bytes = mime.encode("utf-8")

    if len(path_bytes) > 0xFFFF:
        raise ValueError(f"Path too long for bytecode format: {logical_path}")
    if len(mime_bytes) > 0xFFFF:
        raise ValueError(f"MIME type too long for bytecode format: {mime}")
    if len(data) > 0xFFFFFFFF:
        raise ValueError(f"File too large for bytecode format: {logical_path}")

    return b"".join(
        [
            bytes([OP_DEFINE_FILE]),
            len(path_bytes).to_bytes(2, "big"),
            path_bytes,
            len(mime_bytes).to_bytes(2, "big"),
            mime_bytes,
            len(data).to_bytes(4, "big"),
            data,
        ]
    )


def serialize_manifest_without_hash(manifest: dict) -> bytes:
    return json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode("utf-8")


def encrypt_tree(
    source_dir: Path,
    output_abs: Path,
    output_rel: Path,
    password: str,
    entry: str,
    include_hidden: bool,
    part_a: str,
) -> dict:
    if source_dir == output_abs or source_dir.is_relative_to(output_abs):
        raise ValueError("Source directory cannot be inside the output directory.")

    if output_abs.exists():
        shutil.rmtree(output_abs)
    output_abs.mkdir(parents=True, exist_ok=True)

    files = collect_source_files(source_dir, include_hidden)
    if not files:
        raise ValueError(f"No source files found in: {source_dir}")

    logical_paths = {path.relative_to(source_dir).as_posix() for path in files}
    if entry not in logical_paths:
        raise ValueError(f"Entry file '{entry}' was not found in source directory: {source_dir}")

    chunks_abs = output_abs / "chunks"
    chunks_abs.mkdir(parents=True, exist_ok=True)

    salt = os.urandom(SALT_LEN)
    part_b = derive_part_b(password, salt)
    part_a_bytes = part_a.encode("utf-8")

    randomized_files = files[:]
    random.SystemRandom().shuffle(randomized_files)

    manifest = {
        "version": 2,
        "format": "private-gh-vm",
        "algorithm": "AES-GCM",
        "entry": entry,
        "kdf": {
            "name": "PBKDF2-SHA256",
            "iterations": PBKDF2_ITERATIONS,
            "salt_b64": b64e(salt),
        },
        "bytecode": {
            "opcode_define_file": OP_DEFINE_FILE,
            "fragments_dir": (output_rel / "chunks").as_posix(),
        },
        "files": {},
        "fragment_order": [],
    }

    for path in tqdm(randomized_files, desc="Encrypting", unit="file"):
        logical_path = path.relative_to(source_dir).as_posix()
        source_bytes = path.read_bytes()
        mime, _ = mimetypes.guess_type(logical_path)
        mime_type = mime or "application/octet-stream"

        instruction = build_define_file_instruction(logical_path, mime_type, source_bytes)
        envelope = encrypt_instruction(instruction, part_a_bytes, part_b)

        fragment_name = f"{secrets.token_hex(12)}.bcf"
        fragment_rel = (output_rel / "chunks" / fragment_name).as_posix()
        fragment_abs = chunks_abs / fragment_name
        fragment_abs.write_text(json.dumps(envelope, separators=(",", ":")), encoding="utf-8")

        manifest["files"][logical_path] = {
            "fragment": fragment_rel,
            "mime": mime_type,
            "size": len(source_bytes),
            "sha256": sha256_hex(source_bytes),
        }
        manifest["fragment_order"].append(fragment_rel)

    manifest_hash = sha256_hex(serialize_manifest_without_hash(manifest))
    manifest["manifest_hash"] = manifest_hash
    return manifest


def write_runtime_config(output_abs: Path, output_rel: Path, part_a: str) -> Path:
    config_path = output_abs / "runtime-config.js"
    config = {
        "partA": part_a,
        "manifest": (output_rel / "manifest.vm.json").as_posix(),
    }
    script = (
        "window.__PRIVATE_GH_RUNTIME__ = Object.freeze("
        + json.dumps(config, separators=(",", ":"))
        + ");"
    )
    config_path.write_text(script, encoding="utf-8")
    return config_path


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build encrypted VM bytecode fragments for browser-side decryption and execution."
    )
    parser.add_argument(
        "--root",
        default=".",
        help="Project root (default: current directory).",
    )
    parser.add_argument(
        "--source",
        default="pagefiles",
        help="Source directory (relative to root) that contains files to protect (default: pagefiles).",
    )
    parser.add_argument(
        "--output",
        default="encrypted",
        help="Output folder for encrypted fragments and manifest (default: encrypted).",
    )
    parser.add_argument(
        "--password",
        required=True,
        help="Password used for Part B derivation (PBKDF2-SHA256).",
    )
    parser.add_argument(
        "--entry",
        default="index.html",
        help="Entry file inside source directory (default: index.html).",
    )
    parser.add_argument(
        "--include-hidden",
        action="store_true",
        help="Include hidden files from the source directory.",
    )
    parser.add_argument(
        "--part-a",
        default="",
        help="Optional explicit Part A value. If omitted, a random value is generated.",
    )
    args = parser.parse_args()

    root = Path(args.root).resolve()
    source_dir = (root / args.source).resolve()
    output_rel = Path(args.output)
    output_abs = (root / output_rel).resolve()

    if not source_dir.exists() or not source_dir.is_dir():
        raise ValueError(f"Source directory does not exist: {source_dir}")
    if args.password == "":
        raise ValueError("Password cannot be empty.")
    part_a = args.part_a or secrets.token_urlsafe(24)

    manifest = encrypt_tree(
        source_dir=source_dir,
        output_abs=output_abs,
        output_rel=output_rel,
        password=args.password,
        entry=args.entry,
        include_hidden=args.include_hidden,
        part_a=part_a,
    )

    manifest_path = output_abs / "manifest.vm.json"
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    runtime_config_path = write_runtime_config(output_abs, output_rel, part_a)

    print(f"Encrypted {len(manifest['files'])} files")
    print(f"Manifest written to: {manifest_path}")
    print(f"Runtime config written to: {runtime_config_path}")


if __name__ == "__main__":
    main()