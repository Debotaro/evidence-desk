# Security boundaries

EvidenceDesk is a single-owner workspace. Run it on loopback by default. Anyone who possesses the configured workspace token can read, edit and delete all workspace data; the token does not provide per-user authorization. Do not expose this default local installation to the Internet.

Remote binding requires a token of at least 24 characters. Generate a random token with `python -c "import secrets; print(secrets.token_urlsafe(32))"`, store it in your deployment secret manager or process environment and set `EVIDENCE_API_TOKEN`. Never commit it. The browser stores a token supplied by the user in sessionStorage, scoped to that origin and tab session. Rotate it by changing the environment and restarting the process.

Host validation mitigates DNS rebinding. Cross-origin writes are rejected. The service has no CORS allowlist, remote-URL ingestion, arbitrary filesystem paths, shell execution, external messaging tool or model-controlled action. API body/text limits and document/chunk quotas bound memory and storage; model concurrency is bounded. Add reverse-proxy request pacing and HTTPS for shared deployments. The local SQLite file and local model cache need appropriate filesystem permissions and backups.

Source markup is returned as JSON data and displayed as text. CSP forbids remote scripts and inline script/style execution. Queries and sources are not sent to hosted inference. A narrow contact-pattern redactor is not a DLP system. The instruction-like pattern filter is not a general jailbreak defense. Extractive output and absence of action tools are the main safety boundaries.

History keeps a maximum of 200 responses. Deleting a source also deletes retained histories citing it; clearing history removes all query snapshots. Filesystem backups and SQLite free pages may still retain deleted bytes. The app does not promise forensic erasure; encrypt storage and follow your own retention policy for sensitive deployments.

Report issues privately to the repository owner through their published GitHub contact. Do not open an issue containing real customer data, credentials or exploit payloads with secrets. No automated security certification is claimed.
