# Architecture

## Request flow

The browser sends same-origin JSON requests to FastAPI. Host, body-size, origin and optional bearer-token boundaries execute before the source or query workflow. Pydantic rejects unknown fields and bounds text. Source text is treated as data throughout; the client uses text nodes rather than HTML insertion.

Ingestion checks source validity, redacts a limited set of contact patterns, splits paragraphs into bounded overlapping chunks, and computes normalized MiniLM vectors. A SQLite write transaction inserts the source and chunks together. Title uniqueness and version preconditions prevent concurrent duplicate or stale writes. If any chunk would exceed capacity, the transaction rolls back and leaves the old version intact.

Queries load a bounded snapshot of chunks, score BM25 and cosine similarity, and rank using the selected mode. Hybrid scoring uses 65% semantic / 35% lexical reciprocal-rank fusion with rank constant 61. A semantic evidence threshold of 0.52 was fixed before the holdout run. BM25 requires lexical coverage. Unsupported questions abstain. A supported response returns exact source text with citation snapshots and timing; no model generates prose or executes a tool.

## Data and concurrency

`documents` stores source content, content hash, current version and timestamps. `chunks` references its document through a cascading foreign key and stores text plus JSON vectors. `queries` keeps at most 200 response snapshots and exposes the latest 30. All SQL values are parameterized. Connections are short-lived, use foreign keys and a 15-second busy timeout, and write under WAL.

An update replaces current chunks in one transaction. Query history preserves old citation versions until the owner deletes the source or clears history. A concurrent source deletion cannot reintroduce the source into stored history. A response already in flight may reflect its earlier consistent snapshot; the citation records the version rather than claiming it is current.

## Boundaries and tradeoffs

SQLite and a linear scan are appropriate at the enforced small-workspace limit. They make failure behavior and deployment reproducible. At larger scale, introduce authenticated workspaces, a vector index with filtered tenant access, queued ingestion and per-tenant quotas before increasing the limits. A persistent vector database alone would not create tenancy isolation.

Inference is local after model installation. The encoder limits CPU threads. Public model download and package installation require outbound network access; source text is not sent to a hosted model endpoint. BM25 can run with no model weights. The initial model fetch and initialization are cold-start costs and are excluded from warm-query latency percentiles.

The simple instruction-like pattern filter is defense in depth, not a complete prompt-injection classifier. The stronger boundary is architectural: the app quotes sources and has no model-controlled tool or external side-effect surface. Redaction similarly handles only the documented patterns and is not a guarantee that uploaded text contains no personal data.
