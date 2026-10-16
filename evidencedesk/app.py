"""Local web application and bounded authenticated deployment surface."""

import hmac
import json
import logging
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, field_validator
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .config import MODEL, Settings
from .retrieval import InferenceBusy, InferenceUnavailable, MiniLMEncoder
from .service import Knowledge
from .store import Conflict

LOG = logging.getLogger("evidencedesk")


class BodyLimit:
    def __init__(self, app, limit=160_000):
        self.app, self.limit = app, limit

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        for name, value in scope.get("headers", []):
            if name == b"content-length":
                try:
                    if int(value) > self.limit:
                        return await JSONResponse({"detail": "Request body exceeds 160 KB."}, 413)(scope, receive, send)
                except ValueError:
                    return await JSONResponse({"detail": "Invalid Content-Length."}, 400)(scope, receive, send)
        body = bytearray()
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            body.extend(message.get("body", b""))
            if len(body) > self.limit:
                return await JSONResponse({"detail": "Request body exceeds 160 KB."}, 413)(scope, receive, send)
            if not message.get("more_body", False):
                break
        delivered = False

        async def limited_receive():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": bytes(body), "more_body": False}
            return await receive()

        await self.app(scope, limited_receive, send)


class DocumentInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(min_length=2, max_length=120)
    content: str = Field(min_length=10, max_length=50_000)

    @field_validator("title", "content")
    @classmethod
    def nonempty(cls, value):
        if not value.strip():
            raise ValueError("Must include visible text")
        return value.strip()


class Revision(BaseModel):
    model_config = ConfigDict(extra="forbid")
    content: str = Field(min_length=10, max_length=50_000)
    expected_version: int = Field(ge=1)


class Question(BaseModel):
    model_config = ConfigDict(extra="forbid")
    question: str = Field(min_length=3, max_length=1000)
    mode: Literal["bm25", "dense", "hybrid"] = "hybrid"
    top_k: int = Field(default=3, ge=1, le=5)


def create_app(settings: Settings | None = None, encoder=None) -> FastAPI:
    settings = settings or Settings()
    if settings.token and len(settings.token) < 24:
        raise ValueError("EVIDENCE_API_TOKEN must contain at least 24 characters.")
    knowledge = Knowledge(settings, encoder or (MiniLMEncoder(settings) if settings.model_enabled else None))
    app = FastAPI(title="EvidenceDesk", version="1.0.0", docs_url=None, redoc_url=None)
    app.state.knowledge = knowledge
    app.add_middleware(BodyLimit)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=list(settings.hosts))

    @app.middleware("http")
    async def boundaries(request: Request, call_next):
        if not settings.token and request.client and request.client.host not in ("127.0.0.1", "::1", "testclient"):
            return JSONResponse({"detail": "Remote access requires EVIDENCE_API_TOKEN."}, 403)
        if request.method not in ("GET", "HEAD", "OPTIONS"):
            origin = request.headers.get("origin")
            if origin:
                try:
                    parsed = urlsplit(origin)
                    allowed = (parsed.scheme == request.url.scheme and parsed.netloc == request.headers.get("host")
                               and not parsed.path and not parsed.query and not parsed.fragment)
                except ValueError:
                    allowed = False
                if not allowed:
                    return JSONResponse({"detail": "Cross-origin writes are not allowed."}, 403)
        response = await call_next(request)
        response.headers["Content-Security-Policy"] = "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Cache-Control"] = "no-store"
        return response

    def authorize(request: Request):
        if settings.token:
            value = request.headers.get("authorization", "")
            if not hmac.compare_digest(value.encode(), f"Bearer {settings.token}".encode()):
                raise HTTPException(401, "Enter the workspace API token to continue.")

    @app.exception_handler(Conflict)
    async def conflict_handler(request, exc):
        return JSONResponse({"detail": str(exc)}, 409)

    @app.exception_handler(KeyError)
    async def missing_handler(request, exc):
        return JSONResponse({"detail": "Document not found."}, 404)

    @app.exception_handler(ValueError)
    async def invalid_handler(request, exc):
        return JSONResponse({"detail": str(exc)}, 422)

    @app.exception_handler(InferenceBusy)
    async def busy_handler(request, exc):
        return JSONResponse({"detail": "Semantic inference is busy. Retry shortly."}, 503,
                            headers={"Retry-After": "1"})

    @app.exception_handler(InferenceUnavailable)
    async def model_handler(request, exc):
        LOG.warning("Semantic inference unavailable: %s", type(exc).__name__)
        return JSONResponse({"detail": "Semantic inference is unavailable. Try BM25 mode; check server model setup."}, 503)

    protected = [Depends(authorize)]

    @app.get("/api/health")
    def health():
        docs = knowledge.store.documents()
        return {"status": "ok", "mode": "hybrid" if settings.model_enabled else "bm25",
                "model": MODEL if settings.model_enabled else None, "documents": len(docs),
                "chunks": sum(d["chunk_count"] for d in docs), "auth_required": bool(settings.token), "version": "1.0.0"}

    @app.get("/api/documents", dependencies=protected)
    def documents():
        return {"documents": knowledge.store.documents()}

    @app.post("/api/documents", dependencies=protected)
    def ingest(doc: DocumentInput):
        return knowledge.ingest(doc.title, doc.content)

    @app.put("/api/documents/{doc_id}", dependencies=protected)
    def revise(doc_id: str, revision: Revision):
        old = next((d for d in knowledge.store.documents() if d["id"] == doc_id), None)
        if not old:
            raise KeyError(doc_id)
        return knowledge.ingest(old["title"], revision.content, doc_id, revision.expected_version)

    @app.delete("/api/documents/{doc_id}", dependencies=protected)
    def delete(doc_id: str):
        knowledge.store.delete(doc_id)
        return {"deleted": True}

    @app.post("/api/seed", dependencies=protected)
    def seed():
        return {"added": knowledge.seed()}

    @app.post("/api/query", dependencies=protected)
    def query(question: Question):
        return knowledge.query(question.question, question.mode, question.top_k)

    @app.get("/api/history", dependencies=protected)
    def history():
        return {"queries": knowledge.store.history()}

    @app.delete("/api/history", dependencies=protected)
    def clear_history():
        return {"deleted": knowledge.store.clear_history()}

    @app.get("/api/evaluations", dependencies=protected)
    def evaluations():
        if not settings.report.exists():
            return {"status": "not_run"}
        return json.loads(settings.report.read_text(encoding="utf-8"))

    static = Path(__file__).parent / "static"
    static.mkdir(exist_ok=True)
    app.mount("/assets", StaticFiles(directory=static), name="assets")

    @app.get("/")
    def index():
        return FileResponse(static / "index.html")

    return app
