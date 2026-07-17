# Cost Estimate

Model: **sonnet** ($3.00/M input, $15.00/M output)
Mode: **automatic**
Selected contracts: **2**
Selected functions: **11** — scale 0.7x (small)

| Stage                              | Count | Input    | Output  | Cost     |
|------------------------------------|-------|----------|---------|----------|
| Protocol Analyzer (conditional)    |     1 |      35k |    5.6k |    $0.19 |
| Discovery agents                   |     5 |     280k |     42k |    $1.47 |
| Synthesizer                        |     1 |      35k |    8.4k |    $0.23 |
| Implementers                       |     2 |      84k |     21k |    $0.57 |
| Report Writer                      |     1 |      21k |    5.6k |    $0.15 |
| Orchestrator overhead              |     1 |     175k |     28k |    $0.94 |
| TOTAL                              |       |     630k |  110.6k |    $3.55 |

**Estimated total: $3.55** — expected range $2.48 – $5.32

These numbers are Anthropic list-price estimates for the subagents and a rough orchestrator overhead share. Actual cost varies with: coverage-iteration cycles (Step 8), re-runs after compile errors, handler complexity, whether x-ray skipped the Protocol Analyzer, and prompt-cache hit rate. Treat this as a ballpark, not a commitment.
