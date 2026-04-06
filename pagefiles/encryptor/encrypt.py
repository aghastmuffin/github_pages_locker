import argparse
import base64
import json
import mimetypes
import os
from pathlib import Path
# python3 encryptor/encrypt.py --password mysecret --entry index.html --include-hidden
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

try:
    from tqdm import tqdm
except ImportError as exc:  # pragma: no cover - import guard for CLI use
    raise SystemExit("Missing dependency 'tqdm'. Install it with: pip install tqdm") from exc


HEADER = b"ENC1"
PBKDF2_ITERATIONS = 200000
SALT_LEN = 16
NONCE_LEN = 12


def derive_key(password: str, salt: bytes) -> bytes:
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=PBKDF2_ITERATIONS,
    )
    return kdf.derive(password.encode("utf-8"))


def encrypt_bytes(data: bytes, password: str) -> str:
    salt = os.urandom(SALT_LEN)
    nonce = os.urandom(NONCE_LEN)
    key = derive_key(password, salt)
    aesgcm = AESGCM(key)
    ciphertext = aesgcm.encrypt(nonce, data, None)
    packed = HEADER + salt + nonce + ciphertext
    return base64.b64encode(packed).decode("ascii")


def should_exclude(rel_path: str, exclusions: set[str]) -> bool:
    rel = rel_path.replace("\\", "/")
    return any(rel == ex or rel.startswith(f"{ex}/") for ex in exclusions)


def collect_paths_to_encrypt(root: Path, exclusions: set[str], include_hidden: bool) -> list[Path]:
    files: list[Path] = []
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue

        rel_path = path.relative_to(root).as_posix()
        if should_exclude(rel_path, exclusions):
            continue

        if not include_hidden and any(part.startswith(".") for part in path.parts if part not in (".", "..")):
            continue

        files.append(path)

    return files


def encrypt_tree(root: Path, output_dir: Path, password: str, include_hidden: bool) -> dict:
    exclusions = {
        output_dir.as_posix(),
        ".git",
        "__pycache__",
        "_cache",
        "encryptor",
        "index.html",
    }
    manifest = {
        "version": 1,
        "algorithm": "AES-GCM",
        "kdf": "PBKDF2-SHA256",
        "iterations": PBKDF2_ITERATIONS,
        "entry": "page.html",
        "files": {},
    }

    files = collect_paths_to_encrypt(root, exclusions, include_hidden)

    for path in tqdm(files, desc="Encrypting", unit="file"):
        rel_path = path.relative_to(root).as_posix()

        encrypted_rel = f"{rel_path}.enc"
        encrypted_path = root / output_dir / encrypted_rel
        encrypted_path.parent.mkdir(parents=True, exist_ok=True)

        payload = encrypt_bytes(path.read_bytes(), password)
        encrypted_path.write_text(payload, encoding="utf-8")

        mime, _ = mimetypes.guess_type(rel_path)
        manifest["files"][rel_path] = {
            "encrypted": (output_dir / encrypted_rel).as_posix(),
            "mime": mime or "application/octet-stream",
        }

    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Encrypt a project tree into mirrored .enc files for runtime browser decryption."
    )
    parser.add_argument(
        "--root",
        default=".",
        help="Project root to encrypt (default: current directory).",
    )
    parser.add_argument(
        "--output",
        default="encrypted",
        help="Output folder for encrypted files and manifest (default: encrypted).",
    )
    parser.add_argument(
        "--password",
        required=True,
        help="Password used for PBKDF2 + AES-GCM encryption.",
    )
    parser.add_argument(
        "--entry",
        default="page.html",
        help="Default HTML file to open after unlock (default: page.html).",
    )
    parser.add_argument(
        "--include-hidden",
        action="store_true",
        help="Encrypt hidden files too.",
    )
    args = parser.parse_args()

    root = Path(args.root).resolve()
    output_dir = Path(args.output)
    manifest = encrypt_tree(root, output_dir, args.password, args.include_hidden)
    manifest["entry"] = args.entry

    manifest_path = root / output_dir / "manifest.json"
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    print(f"Encrypted {len(manifest['files'])} files")
    print(f"Manifest written to: {manifest_path}")


if __name__ == "__main__":
    main()