"""Create a SQLite online backup without overwriting an existing output."""

import argparse
import sqlite3
from contextlib import closing
from pathlib import Path


def backup(source: Path, target: Path):
    if not source.is_file():
        raise ValueError("Source database does not exist")
    if target.exists():
        raise ValueError("Refusing to overwrite an existing backup")
    target.parent.mkdir(parents=True, exist_ok=True)
    # Exclusive creation protects the owner from a race with an existing destination.
    with target.open("xb"):
        pass
    with (closing(sqlite3.connect(f"file:{source.as_posix()}?mode=ro", uri=True)) as src,
          closing(sqlite3.connect(target)) as dst):
        src.backup(dst)
        if dst.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise RuntimeError("Backup integrity check failed; retain source and inspect output")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("target", type=Path)
    args = parser.parse_args()
    backup(args.source.resolve(), args.target.resolve())
    print("Backup created and integrity check passed")
