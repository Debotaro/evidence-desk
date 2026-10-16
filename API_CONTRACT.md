# EvidenceDesk UI contract

Same-origin JSON API. Header `Authorization: Bearer <token>` only when server has EVIDENCE_API_TOKEN set. Keep a user-entered token in sessionStorage. Unset token is loopback-only local mode. UI should handle 401 with an unlock field, errors with actionable messages, loading/empty states, keyboard use and small screens. Content must render with textContent, never injected HTML. No CDN assets or external fonts.

- GET /api/health => {status:"ok", mode:"hybrid"|"bm25", model:"sentence-transformers/all-MiniLM-L6-v2"|null, documents:int, chunks:int, auth_required:bool, version:"1.0.0"}. Public health contains no source contents.
- GET /api/documents => {documents:[{id,title,version,sha256,created_at,updated_at,chunk_count,content}]}
- POST /api/documents body {title:string,content:string} => document with `created` bool. 409 for existing title with different content. Text/Markdown only. Max 50,000 characters. API redacts obvious email/phone patterns and returns redactions count.
- PUT /api/documents/{id} body {content:string,expected_version:int} => document. 409 for stale version.
- DELETE /api/documents/{id} => {deleted:true}. Purges query history with references to the document.
- POST /api/seed => {added:int}. Loads clearly fictional merchant support policies (5 documents), idempotent.
- POST /api/query body {question:string,mode:"hybrid"|"bm25"|"dense" default hybrid,top_k:3} => {id,question,status:"answered"|"abstained",answer:string,citations:[{document_id,title,version,chunk_id,text,score,dense_score,lexical_score}],reason:string|null,latency_ms:number,mode}. Extractive answer only, not generated LLM text. Dense/hybrid returns 503 if model initialization fails; health displays mode. BM25 needs no model.
- GET /api/history => {queries:[query result including created_at]}; latest 30.
- DELETE /api/history => {deleted:int}.
- GET /api/evaluations => latest checked-in evaluation report JSON or {status:"not_run"}. Real evaluation runs from command line, UI only reads report.

Error body {detail:string|list}. 422 validation. Use /assets/style.css and /assets/app.js; root HTML served by FastAPI. UI assets directory: `evidencedesk/static`. Root owns Python, tests, fixtures, docs. UI agent owns static and browser tests only. Navigation: Workbench, Knowledge, Quality; query history may be in workbench sidebar. Show actual counts/data, answer citations and honest limitations; no invented metrics. Keep restrained professional visual design with distinctive typography, excellent spacing and meaningful status.
