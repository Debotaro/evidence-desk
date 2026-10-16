"""Exercise a disposable container over HTTP; never point this at a real workspace."""

import argparse
import json
import os
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

TITLE = "Container smoke fixture"
CONTENT = "Refund requests must arrive within seven days of delivery."


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("base_url")
    parser.add_argument("phase", choices=("initial", "restarted"))
    args = parser.parse_args()
    token = os.environ["EVIDENCE_API_TOKEN"]
    checks = 0

    def request(path, method="GET", body=None, auth=True, headers=None):
        values = {"Authorization": f"Bearer {token}"} if auth else {}
        values.update(headers or {})
        encoded = None
        if body is not None:
            encoded = json.dumps(body).encode()
            values["Content-Type"] = "application/json"
        req = Request(args.base_url.rstrip("/") + path, encoded, values, method=method)
        try:
            response = urlopen(req, timeout=3)
        except HTTPError as exc:
            response = exc
        with response:
            payload = response.read().decode()
            if "application/json" in response.headers.get("Content-Type", ""):
                payload = json.loads(payload)
            return response.status, payload, response.headers

    def check(condition, message):
        nonlocal checks
        if not condition:
            raise AssertionError(message)
        checks += 1

    deadline = time.monotonic() + 60
    while True:
        try:
            status, health, _ = request("/api/health", auth=False)
            if status == 200:
                break
        except (URLError, ConnectionError, TimeoutError):
            pass
        if time.monotonic() >= deadline:
            raise TimeoutError("Disposable container did not become live within 60 seconds")
        time.sleep(0.3)
    check(health["auth_required"] and health["mode"] == "bm25", "Explicit protected BM25 mode")
    check(request("/api/documents", auth=False)[0] == 401, "Read token gate")
    check(request("/api/seed", "POST", auth=False)[0] == 401, "Write token gate")
    check(request("/api/documents", headers={"Authorization": "Bearer invalid"})[0] == 401,
          "Invalid token refused")
    check(request("/api/health", headers={"Host": "evil.example"})[0] == 400,
          "Unlisted host refused")
    check(request("/api/seed", "POST", headers={"Origin": "https://evil.example"})[0] == 403,
          "Cross-origin write refused")

    if args.phase == "initial":
        check(health["documents"] == 0, "Smoke requires a disposable empty volume")
        status, doc, _ = request("/api/documents", "POST", {"title": TITLE, "content": CONTENT})
        check(status == 200 and doc["created"] and doc["version"] == 1, "Real source persisted")
        status, result, headers = request("/api/query", "POST", {
            "question": "Refund requests delivery", "mode": "bm25",
        })
        check(status == 200 and result["status"] == "answered", "Real lexical query answered")
        citation = result["citations"][0]
        check(citation["document_id"] == doc["id"] and citation["version"] == 1
              and citation["text"] in CONTENT, "Exact stored source citation")
        check("default-src 'self'" in headers["Content-Security-Policy"], "Response security policy")
    else:
        check(health["documents"] == 1 and health["chunks"] == 1, "Volume survived container restart")
        status, docs, _ = request("/api/documents")
        check(status == 200 and len(docs["documents"]) == 1
              and docs["documents"][0]["title"] == TITLE, "Source survived restart")

    status, history, _ = request("/api/history")
    check(status == 200 and len(history["queries"]) == 1
          and history["queries"][0]["status"] == "answered", "Query snapshot durably retained")
    print(json.dumps({"phase": args.phase, "checks_passed": checks,
                      "scope": "disposable protected BM25 container; no semantic inference claim"}))


if __name__ == "__main__":
    main()
