"""Reproducible isolated evaluation; never alters a user's knowledge database."""

import argparse
import hashlib
import json
import platform
import tempfile
from dataclasses import replace
from pathlib import Path

import numpy as np

from .config import MODEL, Settings
from .retrieval import MiniLMEncoder
from .service import FIXTURES, Knowledge
from .store import now


def evaluate(output: Path, semantic: bool = True) -> dict:
    cases_bytes = (FIXTURES / "evaluation.json").read_bytes()
    cases = json.loads(cases_bytes)
    base = Settings()
    with tempfile.TemporaryDirectory(prefix="evidencedesk-eval-") as folder:
        settings = replace(base, database=Path(folder) / "eval.db", model_enabled=semantic)
        encoder = MiniLMEncoder(settings) if semantic else None
        kb = Knowledge(settings, encoder)
        kb.seed()
        report = {"status": "complete", "generated_at": now(), "dataset": "fictional-support-v1",
                  "dataset_sha256": hashlib.sha256(cases_bytes).hexdigest(),
                  "note": "Synthetic author-created fixtures. Holdout labels are separated from development cases; neither is an external benchmark. Threshold fixed before running holdout. Measures retrieval, refusal and source integrity, not LLM generation or business impact.",
                  "model": MODEL if semantic else None, "threshold": settings.threshold,
                  "corpus_documents": len(kb.store.documents()), "cases": len(cases),
                  "environment": {"python": platform.python_version(), "platform": platform.system(), "machine": platform.machine(), "threads": 2},
                  "modes": []}
        for mode in (["bm25", "dense", "hybrid"] if semantic else ["bm25"]):
            results, integrity = [], []
            passages = {p["chunk_id"]: p for p in kb.store.passages()}
            for case in cases:
                response = kb.query(case["question"], mode=mode, save=False)
                titles = [c["title"] for c in response["citations"]]
                expected = case["expected_document"]
                rank = titles.index(expected) + 1 if expected and expected in titles else None
                if case["split"] == "holdout":
                    integrity.extend(c["chunk_id"] in passages and c["text"] == passages[c["chunk_id"]]["text"]
                                     and c["version"] == passages[c["chunk_id"]]["version"] for c in response["citations"])
                results.append(case | {"status": response["status"], "hit": rank is not None,
                                       "rank": rank, "latency_ms": response["latency_ms"], "citations": titles})
            holdout = [r for r in results if r["split"] == "holdout"]
            answerable = [r for r in holdout if r["expected_document"]]
            negative = [r for r in holdout if not r["expected_document"]]
            report["modes"].append({"mode": mode, "answerable_cases": len(answerable),
                                    "unanswerable_cases": len(negative),
                                    "recall_at_3": sum(r["hit"] for r in answerable) / len(answerable),
                                    "mrr": sum(1 / r["rank"] if r["rank"] else 0 for r in answerable) / len(answerable),
                                    "abstention_accuracy": sum(r["status"] == "abstained" for r in negative) / len(negative),
                                    "citation_integrity": sum(integrity) / len(integrity) if integrity else None,
                                    "latency_p50_ms": round(float(np.percentile([r["latency_ms"] for r in holdout], 50)), 2),
                                    "latency_p95_ms": round(float(np.percentile([r["latency_ms"] for r in holdout], 95)), 2),
                                    "results": results})
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=Path("reports/evaluation.json"))
    parser.add_argument("--bm25-only", action="store_true")
    args = parser.parse_args()
    result = evaluate(args.output, not args.bm25_only)
    print(json.dumps({"dataset": result["dataset"], "cases": result["cases"],
                      "modes": [{k: v for k, v in m.items() if k != "results"} for m in result["modes"]]}, indent=2))
