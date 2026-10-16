import sqlite3

import pytest

from scripts.backup import backup


def test_consistent_backup_and_overwrite_refusal(tmp_path):
    source, target = tmp_path / "source.db", tmp_path / "copy.db"
    with sqlite3.connect(source) as db:
        db.execute("CREATE TABLE sample(value TEXT)")
        db.execute("INSERT INTO sample VALUES ('persisted')")
    backup(source, target)
    with sqlite3.connect(target) as db:
        assert db.execute("SELECT value FROM sample").fetchone()[0] == "persisted"
    with pytest.raises(ValueError, match="overwrite"):
        backup(source, target)
    with pytest.raises(ValueError, match="does not exist"):
        backup(tmp_path / "missing.db", tmp_path / "another.db")
