# Evaluation methodology

The fixture corpus contains five fictional merchant runbooks and policies. The 30 hand-authored questions are split explicitly: 4 development examples and 26 holdout examples, comprising 18 answerable questions and 8 unsupported/adversarial questions. Labels identify the expected source document. The fixed 0.52 cosine threshold, rank weights and chunk settings were selected before the first holdout execution. Subsequent correctness hardening may change the report; results must retain their exact dataset digest and code revision context.

Run `python -m evidencedesk.evaluate` from the repository root. The command creates an isolated temporary database, embeds the corpus with the real CPU model, runs all three retrieval modes, and writes a timestamped report with Python/platform details, per-case outcomes and a SHA-256 of the question set. It never tunes parameters or modifies the real application database.

Reported aggregate metrics use **holdout cases only**:

- **Recall at 3:** fraction of 18 answerable cases whose expected document occurs among the returned top three cited chunks. A refusal counts as a miss. Multiple chunks from the same document can consume ranks.
- **MRR:** mean reciprocal rank of the first expected document across those answerable cases; a miss contributes zero.
- **Abstention accuracy:** fraction of 8 known unsupported/adversarial cases refused. This is not overall answer accuracy.
- **Citation integrity:** fraction of returned citations whose chunk ID, text and version match the indexed snapshot. It measures traceability, not factual truth or answer completeness.
- **Latency:** p50 and p95 of the 26 warm holdout service queries measured with `perf_counter`. This excludes browser/network overhead, ingestion and cold model download; it is not a load test.

Read `reports/evaluation.json` for actual values. The first run showed hybrid/dense retrieval finding more expected sources than the lexical baseline, with several false refusals. The repository intentionally retains misses and the negative cases. The application UI provides the source excerpt for a human decision; it does not assert that a similarity score is a calibrated confidence probability.

Limitations: the author created both corpus and questions; 26 cases provide little statistical power. The dataset does not cover multilingual text, long PDFs, ambiguous policy conflicts, adversarial near-domain requests, customer traffic or evolving source distributions. There is no generative model, so no LLM groundedness, hallucination-rate or live LLM inference claim is made. Expand with independently labelled real questions and subject-matter review before operational use.
