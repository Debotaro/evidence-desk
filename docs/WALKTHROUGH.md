# Engineering walkthrough

Use this as a hands-on interview preparation exercise. The project was developed with AI assistance. Reading the source is not a substitute for independently demonstrating the concepts.

1. Run a query with BM25, dense and hybrid modes. Explain cosine similarity, term frequency, inverse document frequency, rank fusion and the difference between a score and a calibrated probability.
2. Reproduce one false refusal from the holdout report. Explain why tuning against that holdout would contaminate the evaluation. Create a new development example before changing thresholds.
3. Open a source in two clients, update both at the same version and show the stale-write conflict. Trace the transaction that preserves the winning revision.
4. Delete a cited source and show that its current chunks and query snapshots disappear. Explain the difference between application deletion, backup retention and forensic erasure.
5. Run protected mode, inspect a 401, a hostile Host request, a cross-origin write and a body-limit failure. Explain what the workspace token does and why it does not create multi-tenancy.
6. Add a meaningful regression test and implement a small source filter without assistance. Explain the scalability changes needed beyond the bounded SQLite design.

Do not describe independently mastered backend, ML, cloud or security expertise in interviews until you can perform and explain the relevant work yourself.
