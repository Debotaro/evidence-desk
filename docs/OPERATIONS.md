# Deployment and recovery

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| EVIDENCE_DB | data/evidence.db | SQLite path on persistent owner-controlled storage |
| EVIDENCE_MODEL_CACHE | data/models | Public model cache; never store application secrets here |
| EVIDENCE_MODE | hybrid | `bm25` disables model initialization and download |
| EVIDENCE_API_TOKEN | unset | Owner workspace bearer token; required for remote access |
| EVIDENCE_HOSTS | 127.0.0.1,localhost,testserver | Exact allowed hostnames; add your HTTPS hostname explicitly |

The CLI binds to 127.0.0.1:8011 by default. Configure all variables in the service environment. `.env.example` is a sample; the application intentionally does not silently load files from arbitrary working directories.

## Container

```powershell
$env:EVIDENCE_API_TOKEN = '<a newly generated random token>'
docker compose up --build
```

Compose requires an explicit token, exposes only 127.0.0.1:8011, and mounts a named data volume. The image runs as UID 10001. The public model downloads on first semantic ingestion; keep the data volume to avoid repeated downloads. Do not commit real data volumes. Docker execution is not claimed unless listed as executed in the verification report.

For public hosting use a single container with persistent disk, HTTPS reverse proxy, process restart policy, restricted admin access and request limiting. Set EVIDENCE_HOSTS to the actual hostname and pass secrets at runtime. Do not mount a SQLite WAL database over a filesystem without correct locking, and do not run multiple replicas sharing it. Public hosting and any paid storage require the owner's explicit approval.

## Health and failures

`GET /api/health` reports liveness, configured retrieval mode and counts without source contents. It does not eagerly download the model or prove semantic readiness. Check readiness by ingesting a known test source and executing a semantic query. Inference errors produce a 503 response with BM25 recovery guidance. Warm a new instance before directing user traffic to it.

A 409 on a revision means the source changed or a quota was exceeded; reload the current version before retrying. A 422 means input needs correction. A 401 means a missing/invalid workspace token. A 413 means the incoming body exceeds 160 KB. Error content avoids returning model configuration or local filesystem paths.

The app stores bounded query history and per-query duration. Use container logs for operational errors, but do not add request body logging in sensitive deployments. Establish actual workload SLOs before promising latency or availability. The checked-in evaluation measures a tiny local corpus and warm sequential requests only.

## Backup and restore

Stop writes and use SQLite's backup API rather than copying the main file while WAL writes are active:

```powershell
python scripts/backup.py data/evidence.db backups/evidence-backup.db
```

The backup script refuses to overwrite an existing backup and checks database integrity. To restore, stop the service, retain the current database and its WAL/SHM files in a separate owner-approved location, copy the verified backup to the configured EVIDENCE_DB path, then restart and inspect source counts. Do not delete live files while the service runs. Restoring old backups can restore previously deleted source/history data.
