# Evals

The deterministic suite uses Chrome's
[`webmcp-evals`](https://github.com/GoogleChromeLabs/webmcp-tools/tree/main/webmcp-evals)
runner against the deployed app.

## Status

- **18/18 smoke cases passed** in Chrome 152.0.7977.82 on 2026-09-04, against
  the deployed build that includes the allele-aware carriage analysis. Verbatim
  output: [`smoke-2026-09-04.txt`](./smoke-2026-09-04.txt).
- That run covers all 18 cases in `locuslocal.evals.json`, including
  `read_data_quality` and `read_tool_activity`, which were added after an
  earlier 16-case run.
- The four cases in `locuslocal.journey.evals.json` require an LLM-backed run.
  Confirmation cases must stop at the human approval card.

## Not covered by the runner

The `act_*` layer and `read_current_selection` are excluded and verified by
hand. The smoke runner drives tools directly, and every `act_*` tool blocks on a
confirmation card that only a human click clears, so a runner can never observe
more than the card appearing. `read_current_selection` registers only while rows
are selected in the DOM, which the runner cannot do either. Both are the point
of the design rather than gaps in it: the boundary that keeps them untestable by
a script is the same boundary that keeps an agent from crossing them.

## Run

```bash
git clone --depth 1 https://github.com/GoogleChromeLabs/webmcp-tools.git
cd webmcp-tools/webmcp-evals
npm install && npm run build

node dist/bin/webmcp-evals.js smoke \
  --url "https://locuslocal.aguvener.workers.dev/?demo" \
  --evals /path/to/locuslocal/evals/locuslocal.evals.json \
  --timeout 60000 \
  --chrome-channel chrome
```

The `?demo` query loads the public demo genome needed by the dataset tools.
`--chrome-channel chrome` pins stable Chrome; without it the runner may default
to Canary. The same command with `--url http://localhost:4173/?demo` runs
against a local `pnpm build && pnpm preview`.
