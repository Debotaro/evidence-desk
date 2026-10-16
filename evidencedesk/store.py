"""SQLite repository with atomic version replacement and query snapshot retention."""

import hashlib
import json
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import UTC, datetime

from .config import Settings


def now() -> str:
    return datetime.now(UTC).isoformat()


class Conflict(ValueError):
    pass


class Store:
    def __init__(self, settings: Settings):
        self.settings = settings
        settings.database.parent.mkdir(parents=True, exist_ok=True)
        with self.connection() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS documents (
                    id TEXT PRIMARY KEY, title TEXT COLLATE NOCASE UNIQUE NOT NULL,
                    content TEXT NOT NULL, sha256 TEXT NOT NULL, version INTEGER NOT NULL,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, redactions INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS chunks (
                    id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
                    text TEXT NOT NULL, embedding TEXT
                );
                CREATE INDEX IF NOT EXISTS chunk_document ON chunks(document_id);
                CREATE TABLE IF NOT EXISTS queries (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, result TEXT NOT NULL);
            """)

    @contextmanager
    def connection(self):
        db = sqlite3.connect(self.settings.database, timeout=15)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        try:
            with db:
                yield db
        finally:
            db.close()

    def documents(self) -> list[dict]:
        with self.connection() as db:
            return [dict(r) for r in db.execute("""
                SELECT d.*, (SELECT COUNT(*) FROM chunks c WHERE c.document_id=d.id) AS chunk_count
                FROM documents d ORDER BY updated_at DESC, id
            """)]

    def _check_write(self, db, title, digest, part_count, doc_id, expected_version):
        """Check against a consistent snapshot; the caller chooses read or write locking."""
        old = (db.execute("SELECT * FROM documents WHERE id=?", (doc_id,)).fetchone() if doc_id else
               db.execute("SELECT * FROM documents WHERE title=? COLLATE NOCASE", (title,)).fetchone())
        if doc_id and old is None:
            raise KeyError(doc_id)
        if doc_id and old["version"] != expected_version:
            raise Conflict("This document changed. Reload it before saving a new version.")
        old_count = (db.execute("SELECT COUNT(*) FROM chunks WHERE document_id=?", (old["id"],)).fetchone()[0]
                     if old is not None else 0)
        if old is not None:
            if old["sha256"] == digest:
                return old, dict(old) | {"chunk_count": old_count, "created": False}
            if not doc_id:
                raise Conflict("A different document has this title. Open it and save a new version.")
        if old is None and db.execute("SELECT COUNT(*) FROM documents").fetchone()[0] >= self.settings.max_documents:
            raise Conflict("Document capacity reached. Delete unused sources first.")
        count = db.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
        if count - old_count + part_count > self.settings.max_chunks:
            raise Conflict("Chunk capacity reached. Shorten the source or remove unused documents.")
        return old, None

    def preflight(self, title: str, content: str, part_count: int, doc_id=None, expected_version=None):
        digest = hashlib.sha256(content.encode()).hexdigest()
        with self.connection() as db:
            db.execute("BEGIN")
            return self._check_write(db, title, digest, part_count, doc_id, expected_version)[1]

    def put(self, title: str, content: str, parts: list[str], vectors: list | None,
            redactions: int = 0, doc_id: str | None = None, expected_version: int | None = None) -> dict:
        digest = hashlib.sha256(content.encode()).hexdigest()
        stamp = now()
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            old, unchanged = self._check_write(db, title, digest, len(parts), doc_id, expected_version)
            if unchanged is not None:
                return unchanged
            if doc_id:
                version = old["version"] + 1
                db.execute("UPDATE documents SET content=?,sha256=?,version=?,updated_at=?,redactions=? WHERE id=?",
                           (content, digest, version, stamp, redactions, doc_id))
                db.execute("DELETE FROM chunks WHERE document_id=?", (doc_id,))
            else:
                doc_id, version = uuid.uuid4().hex, 1
                db.execute("INSERT INTO documents VALUES (?,?,?,?,?,?,?,?)",
                           (doc_id, title, content, digest, version, stamp, stamp, redactions))
            for i, text in enumerate(parts):
                chunk_id = f"{doc_id}:{version}:{i}"
                vector = json.dumps(vectors[i]) if vectors is not None else None
                db.execute("INSERT INTO chunks VALUES (?,?,?,?)", (chunk_id, doc_id, text, vector))
            row = db.execute("SELECT * FROM documents WHERE id=?", (doc_id,)).fetchone()
            return dict(row) | {"chunk_count": len(parts), "created": version == 1}

    def passages(self) -> list[dict]:
        with self.connection() as db:
            rows = db.execute("""SELECT c.id AS chunk_id,c.document_id,c.text,c.embedding,d.title,d.version
                                 FROM chunks c JOIN documents d ON d.id=c.document_id ORDER BY c.id""")
            return [dict(r) | {"embedding": json.loads(r["embedding"]) if r["embedding"] else None} for r in rows]

    def delete(self, doc_id: str) -> None:
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            if not db.execute("DELETE FROM documents WHERE id=?", (doc_id,)).rowcount:
                raise KeyError(doc_id)
            # Purge retained citation snapshots as part of the same transaction.
            rows = db.execute("SELECT id,result FROM queries").fetchall()
            ids = [r["id"] for r in rows if any(c["document_id"] == doc_id for c in json.loads(r["result"])["citations"])]
            db.executemany("DELETE FROM queries WHERE id=?", [(i,) for i in ids])

    def save_query(self, result: dict):
        with self.connection() as db:
            # A concurrent deletion must not reintroduce a deleted source via history.
            db.execute("BEGIN IMMEDIATE")
            ids = {r[0] for r in db.execute("SELECT id FROM documents")}
            if any(c["document_id"] not in ids for c in result["citations"]):
                return
            db.execute("INSERT INTO queries VALUES (?,?,?)", (result["id"], now(), json.dumps(result)))
            db.execute("DELETE FROM queries WHERE id NOT IN (SELECT id FROM queries ORDER BY created_at DESC LIMIT 200)")

    def history(self) -> list[dict]:
        with self.connection() as db:
            return [json.loads(r["result"]) | {"created_at": r["created_at"]} for r in
                    db.execute("SELECT * FROM queries ORDER BY created_at DESC LIMIT 30")]

    def clear_history(self) -> int:
        with self.connection() as db:
            return db.execute("DELETE FROM queries").rowcount
