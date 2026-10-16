import argparse
import os

import uvicorn

from .app import create_app


def main():
    parser = argparse.ArgumentParser(description="Run EvidenceDesk")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8011)
    args = parser.parse_args()
    if args.host not in ("127.0.0.1", "localhost", "::1") and not os.getenv("EVIDENCE_API_TOKEN"):
        parser.error("Binding to a remote interface requires EVIDENCE_API_TOKEN (24+ characters).")
    uvicorn.run(create_app(), host=args.host, port=args.port)


if __name__ == "__main__":
    main()
