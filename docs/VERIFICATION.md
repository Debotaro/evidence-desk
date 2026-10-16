# Verification record

Executed 16 October 2026 on Windows AMD64 with Python 3.12.14, Node 24.13.0 and two model inference threads. This is local execution evidence, not customer or production deployment evidence.

## Public release verification

The public source is available at [Debotaro/evidence-desk](https://github.com/Debotaro/evidence-desk). [GitHub Actions run 38913708995](https://github.com/Debotaro/evidence-desk/actions/runs/38913708995) passed on source commit `5982dc19dea39ea158d6bfc067f4766bca4fabf1` on 16 October 2026. It reran all 46 backend tests, the real CPU MiniLM evaluation and all 10 browser checks on Linux. The evaluation again found 11/18 answerable sources with BM25 and 14/18 with dense/hybrid, with 8/8 negative refusals per mode. Its downloadable artifact retains that execution's timings separately from the original Windows measurement below.

The same run built the actual Docker image and started it as UID 10001 with a disposable named volume and an explicit workspace token. All 21 HTTP assertions passed: 12 on initial execution and 9 after a container restart. These exercise liveness, real authentication and host/origin enforcement, source ingestion, a lexical answer with an exact citation, response security policy, and source/query-history persistence. This container smoke deliberately uses BM25; semantic inference is separately exercised by native Linux CI. It does not prove public HTTPS hosting, workload capacity, backup recovery or production availability. No backend service is publicly hosted yet.

## Original local acceptance

| Check | Observed result |
| --- | --- |
| Clean environment installation | Fresh repository-local venv installed from requirements.lock + pyproject.toml; all 46 tests passed again |
| pytest API, persistence, security and fault cases | 46 passed; source/version/delete, contention, model failures, malicious/oversized requests and backup covered |
| Ruff Python checks | Passed for application, tests and scripts |
| Real CPU MiniLM evaluation | 30 total cases; aggregate metrics below use 26 holdout cases only |
| Playwright functional/accessibility suite against final live backend | 10 passed; 1 opt-in screenshot test skipped in normal suite |
| Opt-in actual screenshot execution | 1 passed separately; four images captured and visually inspected |
| Browser package formatting | Passed |
| Browser package npm audit | 0 reported vulnerabilities at this run; does not establish application or Python dependency security |
| Local HTTP execution | Service started, health returned 200, fictional corpus ingested, semantic queries executed |
| Backup | SQLite backup and integrity check passed; overwrite refusal regression passed |
| Docker / hosted CI / public deployment | Docker CLI absent on the local Windows workstation. Later Linux CI built and executed the image as documented above; backend hosting remains incomplete |

## Actual retrieval measurement

The final real-model report is `reports/evaluation.json`, generated at 2026-10-16T04:52:38.799889+00:00. Dataset SHA-256: `d2b6c83ecbf0900586d327d17475168b837d16baad73bb84aba0c99819ea3860`.

| Mode | Expected source found among first 3 on 18 answerable cases | MRR | Refusals on 8 negative cases | Citation snapshot integrity | Warm query p50 / p95 |
| --- | --- | --- | --- | --- | --- |
| BM25 | 11/18, 61.11% | 0.6111 | 8/8 | 100% | 2.16 / 2.34 ms |
| Dense MiniLM | 14/18, 77.78% | 0.7778 | 8/8 | 100% | 4.72 / 5.53 ms |
| Hybrid | 14/18, 77.78% | 0.7778 | 8/8 | 100% | 4.83 / 5.70 ms |

Check the JSON if regenerating: timings vary by machine/cache. The stored report is authoritative. The corpus, question set and 0.52 threshold were not changed to optimize these results. No generative LLM is present or evaluated. These are small synthetic fixtures, not an independent benchmark.

## Failures retained

Hybrid falsely refused four answerable holdout questions: used-item returns (`refund-2`), damaged-item evidence (`refund-3`), tracking stalled for forty-eight hours (`delivery-2`) and incident update frequency (`incident-2`). The conservative threshold trades answer coverage for refusing weak similarity. A user can inspect the actual source; the app does not fill missing evidence with plausible prose. Improving recall requires a new development set and broader independent evaluation, not editing these expected labels or silently changing the holdout threshold.

## Browser scope

Real API-backed checks exercise source retrieval/history, unsupported refusal, source creation/revision/deletion, stale-write conflicts and actual report rendering. Token-unlock UI and network-failure recovery have explicitly simulated browser responses; actual authentication and failures are independently covered in backend tests. Axe scans cover all three views at desktop/mobile sizes and answer/edit/connection dialog states, with zero observed WCAG A/AA violations. Keyboard skip navigation and Escape are exercised. Automated scans are not a complete accessibility certification.

## Acceptance

The bounded single-workspace application passed its local engineering acceptance gate before FlowLedger implementation began. README, architecture, security boundaries, evaluation methodology, operations/backup, dependency locks, license, CI and non-root container configuration are present. Public source publication and Linux CI/container execution were subsequently verified as documented above. Persistent backend hosting and its live deployment checks remain incomplete.
