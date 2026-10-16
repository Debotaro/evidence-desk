import asyncio
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from types import SimpleNamespace

import numpy as np
import pytest
from fastapi.testclient import TestClient

from evidencedesk.app import BodyLimit, create_app
from evidencedesk.config import Settings
from evidencedesk.retrieval import MiniLMEncoder, rank
from evidencedesk.service import Knowledge
from evidencedesk.store import Conflict


@pytest.fixture
def settings(tmp_path):
    return Settings(database=tmp_path / "test.db", cache=tmp_path / "models", model_enabled=False)


class ConstantEncoder:
    def encode(self, texts):
        return [[1.0, 0.0] for _ in texts]


@pytest.mark.parametrize("mode", ["dense", "hybrid"])
def test_every_semantic_citation_passes_evidence_gate(mode):
    passages = [
        {"chunk_id": "a:1:0", "document_id": "a", "title": "Refund timeline", "version": 1,
         "text": "Refunds arrive in seven days.", "embedding": [1.0, 0.0]},
        {"chunk_id": "b:1:0", "document_id": "b", "title": "Weather", "version": 1,
         "text": "Tomorrow will be sunny.", "embedding": [0.0, 1.0]},
    ]
    hits, reason = rank("refund timeline", passages, mode, ConstantEncoder(), 0.52)
    assert reason is None and [hit["document_id"] for hit in hits] == ["a"]


def test_every_bm25_citation_has_sufficient_question_coverage():
    passages = [
        {"chunk_id": "a:1:0", "document_id": "a", "title": "Policy", "version": 1,
         "text": "Refund timeline is seven days.", "embedding": None},
        {"chunk_id": "b:1:0", "document_id": "b", "title": "Choices", "version": 1,
         "text": "Refund choices depend on payment method.", "embedding": None},
    ]
    hits, reason = rank("refund timeline deadline", passages, "bm25", None, 0.52)
    assert reason is None and [hit["document_id"] for hit in hits] == ["a"]


def test_duplicate_stale_revision_and_capacity_failures_skip_inference(settings):
    kb = Knowledge(replace(settings, max_documents=1, max_chunks=1), ConstantEncoder())
    doc = kb.ingest("Returns", "Refund requests accepted within seven days.")

    class FailingEncoder:
        def encode(self, texts):
            pytest.fail("No inference should run for this rejected or idempotent write")

    kb.encoder = FailingEncoder()
    assert kb.ingest("returns", doc["content"])["id"] == doc["id"]
    assert kb.ingest("Returns", doc["content"], doc["id"], 1)["version"] == 1
    with pytest.raises(Conflict, match="changed"):
        kb.ingest("Returns", "A new revision that must be rejected.", doc["id"], 9)
    with pytest.raises(Conflict, match="Document capacity"):
        kb.ingest("Another", "Another valid source over the document limit.")
    with pytest.raises(Conflict, match="Chunk capacity"):
        kb.ingest("Returns", "First source paragraph.\n\nSecond source paragraph.", doc["id"], 1)
    assert kb.store.documents()[0]["version"] == 1


def test_capacity_is_rechecked_after_concurrent_inference(settings):
    ready = threading.Barrier(2)

    class ConcurrentEncoder:
        def encode(self, texts):
            ready.wait(timeout=5)
            return [[1.0, 0.0] for _ in texts]

    kb = Knowledge(replace(settings, max_documents=1), ConcurrentEncoder())

    def ingest(i):
        try:
            return kb.ingest(f"Source {i}", "A new source competing for the final available slot.")["created"]
        except Conflict:
            return False

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(ingest, range(2))) == [False, True]
    assert len(kb.store.documents()) == len(kb.store.passages()) == 1


@pytest.mark.parametrize("vectors", [[], [[float("nan"), 0]], [[float("inf"), 0]], [[0, 0]], [1, 2]])
def test_invalid_model_output_returns_503_and_does_not_write(settings, vectors):
    class InvalidEncoder:
        def encode(self, texts):
            return vectors

    with TestClient(create_app(replace(settings, model_enabled=True), InvalidEncoder())) as client:
        response = client.post("/api/documents", json={"title": "Policy", "content": "Refunds arrive in seven days."})
        assert response.status_code == 503
        assert client.get("/api/documents").json()["documents"] == []
        assert response.json()["detail"] == "Semantic inference is unavailable. Try BM25 mode; check server model setup."


def test_model_initialization_failure_is_safe_and_bm25_remains_usable(settings, monkeypatch):
    kb = Knowledge(settings, None)
    kb.ingest("Returns", "Refund requests accepted within seven days.")

    def fail_model(**kwargs):
        raise OSError("Private setup path and credential must not reach HTTP clients")

    monkeypatch.setitem(sys.modules, "fastembed", SimpleNamespace(TextEmbedding=fail_model))
    with TestClient(create_app(replace(settings, model_enabled=True))) as client:
        response = client.post("/api/query", json={"question": "refund requests", "mode": "dense"})
        assert response.status_code == 503 and "Private" not in response.text
        assert client.post("/api/query", json={"question": "refund requests", "mode": "bm25"}).json()["status"] == "answered"
        assert len(client.get("/api/history").json()["queries"]) == 1


def test_incompatible_stored_embeddings_return_503(settings):
    kb = Knowledge(settings, ConstantEncoder())
    kb.ingest("Returns", "Refund requests accepted within seven days.")

    class OtherEncoder:
        def encode(self, texts):
            return [[1, 0, 0] for _ in texts]

    with TestClient(create_app(replace(settings, model_enabled=True), OtherEncoder())) as client:
        assert client.post("/api/query", json={"question": "refund requests", "mode": "dense"}).status_code == 503
        assert client.get("/api/history").json()["queries"] == []


def test_busy_model_rejects_extra_work_and_recovers(settings):
    started, release = threading.Event(), threading.Event()

    class BlockingModel:
        def embed(self, texts):
            started.set()
            assert release.wait(timeout=5)
            return [np.array([1.0, 0.0]) for _ in texts]

    encoder = MiniLMEncoder(settings)
    encoder._model = BlockingModel()
    with TestClient(create_app(replace(settings, model_enabled=True), encoder)) as client:
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(client.post, "/api/documents", json={"title": "First", "content": "The first source has useful text."})
            assert started.wait(timeout=5)
            try:
                busy = client.post("/api/documents", json={"title": "Second", "content": "The second source has useful text."})
                assert busy.status_code == 503 and busy.headers["retry-after"] == "1"
                assert client.get("/api/health").status_code == 200
            finally:
                release.set()
            assert pending.result(timeout=5).status_code == 200
        assert client.post("/api/documents", json={"title": "Second", "content": "The second source has useful text."}).status_code == 200


@pytest.mark.parametrize("origin", ["http://[", "https://testserver", "//testserver", "null", "http://testserver/path"])
def test_invalid_and_cross_scheme_origins_are_rejected(settings, origin):
    with TestClient(create_app(settings)) as client:
        assert client.post("/api/seed", headers={"Origin": origin}).status_code == 403
        assert client.get("/api/documents").json()["documents"] == []
        assert client.post("/api/seed", headers={"Origin": "http://testserver"}).status_code == 200


@pytest.mark.parametrize("method,path,body", [
    ("GET", "/api/documents", None), ("POST", "/api/documents", {"title": "Source", "content": "Useful source text."}),
    ("PUT", "/api/documents/missing", {"content": "Useful new source text.", "expected_version": 1}),
    ("DELETE", "/api/documents/missing", None), ("POST", "/api/seed", None),
    ("POST", "/api/query", {"question": "refund requests"}), ("GET", "/api/history", None),
    ("DELETE", "/api/history", None), ("GET", "/api/evaluations", None),
])
def test_all_workspace_endpoints_require_token(settings, method, path, body):
    with TestClient(create_app(replace(settings, token="a-valid-workspace-token-with-32-characters"))) as client:
        assert client.request(method, path, json=body).status_code == 401


def test_request_limit_cannot_be_bypassed_by_streaming_or_short_length_header():
    async def run(headers, bodies):
        sent, received = [], []

        async def receive():
            received.append(True)
            return {"type": "http.request", "body": bodies.pop(0), "more_body": bool(bodies)}

        async def send(message):
            sent.append(message)

        async def endpoint(scope, receive, send):
            pytest.fail("Oversized request must not reach the application")

        await BodyLimit(endpoint)({"type": "http", "headers": headers}, receive, send)
        return sent[0]["status"], len(received)

    assert asyncio.run(run([(b"content-length", b"160001")], [b""])) == (413, 0)
    assert asyncio.run(run([], [b"x" * 80_000, b"x" * 80_001])) == (413, 2)
    assert asyncio.run(run([(b"content-length", b"10")], [b"x" * 160_001])) == (413, 1)
