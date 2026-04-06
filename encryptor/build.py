import argparse
import getpass
import shutil
import subprocess
import sys
from pathlib import Path


def clean_dir(path: Path) -> None:
    if path.exists():
        shutil.rmtree(path)
    path.mkdir(parents=True, exist_ok=True)


def read_password(cli_password: str | None) -> str:
    if cli_password:
        return cli_password

    password = getpass.getpass("Password: ")
    confirm = getpass.getpass("Confirm Password: ")
    if password != confirm:
        raise ValueError("Passwords do not match.")
    if not password:
        raise ValueError("Password cannot be empty.")
    return password


def run_encrypt(root: Path, args: argparse.Namespace, password: str) -> None:
    command = [
        sys.executable,
        str(root / "encryptor" / "encrypt.py"),
        "--root",
        str(root),
        "--source",
        args.source,
        "--output",
        args.output,
        "--password",
        password,
        "--entry",
        args.entry,
    ]
    if args.include_hidden:
        command.append("--include-hidden")

    subprocess.run(command, check=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Build protected static output with encrypted VM fragments.")
    parser.add_argument("--source", default="pagefiles", help="Source directory for protected files.")
    parser.add_argument("--entry", default="index.html", help="Entry file inside source directory.")
    parser.add_argument("--output", default="encrypted", help="Folder where encrypted artifacts are written.")
    parser.add_argument("--dist", default="dist", help="Build output directory for deployment.")
    parser.add_argument("--publish-dir", default="", help="Optional directory to mirror dist into.")
    parser.add_argument("--password", default="", help="Optional password for non-interactive builds.")
    parser.add_argument("--include-hidden", action="store_true", help="Include hidden files from source.")
    args = parser.parse_args()

    root = Path(__file__).resolve().parents[1]
    dist_dir = root / args.dist
    encrypted_dir = root / args.output

    password = read_password(args.password or None)
    run_encrypt(root, args, password)

    clean_dir(dist_dir)
    shutil.copyfile(root / "index.html", dist_dir / "index.html")
    shutil.copytree(encrypted_dir, dist_dir / args.output, dirs_exist_ok=True)

    if args.publish_dir:
        publish_dir = Path(args.publish_dir)
        clean_dir(publish_dir)
        shutil.copytree(dist_dir, publish_dir, dirs_exist_ok=True)

    print("Build complete.")
    print(f"Dist: {dist_dir}")


if __name__ == "__main__":
    main()