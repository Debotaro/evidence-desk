"""BM25 baseline, real CPU transformer inference and weighted rank fusion."""

import math
import re
import threading
from collections import Counter
from typing import Protocol

import numpy as np

from .config import MODEL, Settings

STOP = {"a", "an", "the", "is", "are", "was", "were", "be", "been", "to", "of", "for", "in", "on", "at", "as", "and", "or", "with", "do", "does", "how", "what", "when", "which", "i", "we", "my", "can", "should", "our", "it", "this", "that", "please", "me", "you", "your", "must", "may"}
UNTRUSTED_INSTRUCTIONS = re.compile(
    r"ignore\s+(?:all\s+|previous\s+|prior\s+)*instructions|system\s*prompt|"
    r"reveal\s+(?:the\s+)?(?:secret|password|token)|act\s+as\s+(?:a\s+)?system|"
    r"override\s+(?:all\s+)?(?:rules|policy)", re.IGNORECASE
)


def tokens(text: str) -> list[str]:
    return [t for t in re.findall(r"[^\W_]+", text.lower(), re.UNICODE) if t not in STOP]


def chunks(text: str, max_chars: int = 700) -> list[str]:
    """Bound both long paragraphs and long unbroken strings; modest overlap retains context."""
    result = []
    for paragraph in re.split(r"\n\s*\n", text.strip()):
        rest = paragraph.strip()
        while len(rest) > max_chars:
            cut = rest.rfind(" ", max_chars // 2, max_chars)
            cut = cut if cut > 0 else max_chars
            result.append(rest[:cut].strip())
            rest = rest[max(1, cut - 80):].strip()
        if rest:
            result.append(rest)
    return result


class Encoder(Protocol):
    def encode(self, texts: list[str]) -> list[list[float]]: ...


class InferenceUnavailable(RuntimeError):
    """The model could not produce a valid embedding batch."""


class InferenceBusy(InferenceUnavailable):
    """CPU inference is already in progress; callers should retry later."""


def encode(encoder: Encoder, texts: list[str]) -> list[list[float]]:
    """Validate model output before using it for ranking or persisting it."""
    try:
        vectors = np.asarray(encoder.encode(texts), dtype=float)
        if (vectors.ndim != 2 or vectors.shape[0] != len(texts) or vectors.shape[1] == 0
                or not np.isfinite(vectors).all()):
            raise ValueError("Invalid embedding batch")
        norms = np.linalg.norm(vectors, axis=1)
        if not np.isfinite(norms).all() or np.any(norms <= 0):
            raise ValueError("Invalid embedding norm")
        return (vectors / norms[:, None]).tolist()
    except InferenceUnavailable:
        raise
    except Exception as exc:
        raise InferenceUnavailable("Semantic embedding failed.") from exc


class MiniLMEncoder:
    def __init__(self, settings: Settings):
        self.settings = settings
        self._model = None
        self._lock = threading.Lock()

    def encode(self, texts: list[str]) -> list[list[float]]:
        # A busy model rejects excess work instead of tying up the worker pool in a queue.
        if not self._lock.acquire(blocking=False):
            raise InferenceBusy("Semantic inference is busy. Retry shortly.")
        try:
            if self._model is None:
                from fastembed import TextEmbedding
                self._model = TextEmbedding(model_name=MODEL, cache_dir=str(self.settings.cache), threads=2)
            vectors = list(self._model.embed(texts))
            return [(v / max(float(np.linalg.norm(v)), 1e-12)).tolist() for v in vectors]
        except Exception as exc:
            raise InferenceUnavailable("Semantic model initialization or inference failed.") from exc
        finally:
            self._lock.release()


def bm25(question: str, texts: list[str]) -> list[float]:
    docs = [tokens(t) for t in texts]
    if not docs:
        return []
    avg = sum(map(len, docs)) / len(docs) or 1
    counts = [Counter(doc) for doc in docs]
    scores = [0.0] * len(docs)
    for term in set(tokens(question)):
        df = sum(term in count for count in counts)
        idf = math.log(1 + (len(docs) - df + 0.5) / (df + 0.5))
        for i, doc in enumerate(docs):
            tf = counts[i][term]
            scores[i] += idf * tf * 2.5 / (tf + 1.5 * (0.25 + 0.75 * len(doc) / avg))
    return scores


def rank(question: str, passages: list[dict], mode: str, encoder: Encoder | None,
         threshold: float) -> tuple[list[dict], str | None]:
    if UNTRUSTED_INSTRUCTIONS.search(question):
        return [], "Instruction-like query refused. Ask a question about the source material."
    if not tokens(question):
        return [], "The question needs a specific topic from your knowledge base."
    if not passages:
        return [], "Add source documents before asking a question."
    texts = [p["title"] + "\n" + p["text"] for p in passages]
    lexical = bm25(question, texts)
    dense = [0.0] * len(passages)
    if mode != "bm25":
        if encoder is None:
            raise InferenceUnavailable("Semantic model is disabled. Choose BM25 mode or enable the model.")
        query = np.array(encode(encoder, [question])[0])
        missing = [i for i, p in enumerate(passages) if p["embedding"] is None]
        if missing:
            # Handles knowledge imported while the server ran in BM25 mode.
            for i, vector in zip(missing, encode(encoder, [texts[i] for i in missing]), strict=True):
                passages[i]["embedding"] = vector
        try:
            embeddings = np.asarray([p["embedding"] for p in passages], dtype=float)
            if embeddings.shape != (len(passages), len(query)) or not np.isfinite(embeddings).all():
                raise ValueError("Stored embeddings do not match the query model")
            dense = (embeddings @ query).tolist()
        except (ValueError, TypeError) as exc:
            raise InferenceUnavailable("Stored embeddings are incompatible. Reindex the source documents.") from exc
    lr = sorted(range(len(passages)), key=lambda i: (-lexical[i], passages[i]["chunk_id"]))
    dr = sorted(range(len(passages)), key=lambda i: (-dense[i], passages[i]["chunk_id"]))
    ls = {i: (61 / (61 + n) if lexical[i] > 0 else 0) for n, i in enumerate(lr)}
    ds = {i: 61 / (61 + n) for n, i in enumerate(dr)}
    if mode == "bm25":
        scores = lexical
    elif mode == "dense":
        scores = dense
    else:
        scores = [0.65 * ds[i] + 0.35 * ls[i] for i in range(len(passages))]
    order = sorted(range(len(passages)), key=lambda i: (-scores[i], passages[i]["chunk_id"]))
    top = order[0]
    qterms = set(tokens(question))

    def supported(i):
        coverage = len(qterms & set(tokens(texts[i]))) / len(qterms)
        return (lexical[i] > 0 and coverage >= 0.5) if mode == "bm25" else dense[i] >= threshold

    if not supported(top):
        return [], "No source meets the evidence threshold. Check the policy or add a relevant document."
    hits = []
    for i in order:
        # Every citation must pass the same evidence gate as the answer's source.
        if not supported(i):
            continue
        p = passages[i]
        hits.append({k: p[k] for k in ("document_id", "title", "version", "chunk_id", "text")} | {
            "score": round(scores[i], 4), "dense_score": round(dense[i], 4),
            "lexical_score": round(lexical[i], 4)
        })
    return hits, None
