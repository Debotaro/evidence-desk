"""Explicit deployment settings; no credentials are persisted by the application."""

import os
from dataclasses import dataclass, field
from pathlib import Path

MODEL = "sentence-transformers/all-MiniLM-L6-v2"


@dataclass(frozen=True)
class Settings:
    database: Path = field(default_factory=lambda: Path(os.getenv("EVIDENCE_DB", "data/evidence.db")))
    cache: Path = field(default_factory=lambda: Path(os.getenv("EVIDENCE_MODEL_CACHE", "data/models")))
    token: str = field(default_factory=lambda: os.getenv("EVIDENCE_API_TOKEN", ""))
    model_enabled: bool = field(default_factory=lambda: os.getenv("EVIDENCE_MODE", "hybrid") != "bm25")
    hosts: tuple[str, ...] = field(default_factory=lambda: tuple(
        s.strip() for s in os.getenv("EVIDENCE_HOSTS", "127.0.0.1,localhost,testserver").split(",") if s.strip()
    ))
    report: Path = field(default_factory=lambda: Path("reports/evaluation.json"))
    max_documents: int = 100
    max_chunks: int = 2000
    threshold: float = 0.52
