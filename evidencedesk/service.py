"""Application workflows independent from HTTP."""

import json
import re
import time
import uuid
from pathlib import Path

from .config import Settings
from .retrieval import UNTRUSTED_INSTRUCTIONS, Encoder, chunks, encode, rank
from .store import Store

FIXTURES = Path(__file__).parent / "fixtures"


def redact(text: str) -> tuple[str, int]:
    text, emails = re.subn(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}", "[EMAIL REDACTED]", text)
    text, phones = re.subn(r"(?<!\w)(?:\+91[ -]?)?[6-9]\d{9}(?!\w)", "[PHONE REDACTED]", text)
    return text, emails + phones


class Knowledge:
    def __init__(self, settings: Settings, encoder: Encoder | None):
        self.settings, self.encoder = settings, encoder
        self.store = Store(settings)

    def ingest(self, title: str, content: str, doc_id=None, expected_version=None) -> dict:
        if UNTRUSTED_INSTRUCTIONS.search(content):
            raise ValueError("Source contains instruction-like text. Review and remove it before indexing.")
        content, redactions = redact(content)
        title, title_redactions = redact(title.strip())
        redactions += title_redactions
        parts = chunks(content)
        if not parts:
            raise ValueError("The source must contain non-whitespace text.")
        # Reject duplicates, stale versions and capacity failures before expensive inference.
        # Store.put repeats these checks within its write transaction to handle races.
        unchanged = self.store.preflight(title, content, len(parts), doc_id, expected_version)
        if unchanged is not None:
            return unchanged
        vectors = encode(self.encoder, [title + "\n" + p for p in parts]) if self.encoder else None
        return self.store.put(title, content, parts, vectors, redactions, doc_id, expected_version)

    def seed(self) -> int:
        docs = json.loads((FIXTURES / "corpus.json").read_text(encoding="utf-8"))
        return sum(self.ingest(d["title"], d["content"])["created"] for d in docs)

    def query(self, question: str, mode="hybrid", top_k=3, save=True) -> dict:
        started = time.perf_counter()
        question, _ = redact(question.strip())
        hits, reason = rank(question, self.store.passages(), mode, self.encoder, self.settings.threshold)
        citations = hits[:top_k]
        result = {"id": uuid.uuid4().hex, "question": question,
                  "status": "answered" if citations else "abstained",
                  "answer": citations[0]["text"] if citations else "I could not find enough evidence in the indexed sources.",
                  "citations": citations, "reason": reason, "mode": mode,
                  "latency_ms": round((time.perf_counter() - started) * 1000, 2)}
        if save:
            self.store.save_query(result)
        return result
