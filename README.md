# LocusLocal

A variant-triage workbench for genomic data that must not be uploaded. A VCF or
consumer raw export (23andMe / AncestryDNA) is parsed, annotated against a
bundled ClinVar subset, and analysed entirely inside one browser tab. An AI agent
drives that analysis through WebMCP tools registered by the page.

**Live: https://locuslocal.aguvener.workers.dev** - no login, no key, no backend.


Built for the [WebMCP Challenge](https://webmcp.devpost.com/). MIT licensed.

## Why WebMCP

Consumer-genomics exports and clinical genotype files share a constraint: the
owner won't or contractually can't upload them. Every AI tool in the category
starts with "upload your file", so the data sits unread.

A server-side MCP integration can't serve this case, because it requires the
upload the user is refusing. Tools that execute inside the tab holding the data
are the only route an agent has to it. Three further properties fall out of that:

- **Ephemeral UI state.** `read_current_selection` returns rows the human
  highlighted with the mouse. That selection exists only in this tab's DOM.
- **Shared mutation path.** Agent changes go through `src/actions.ts`, the same
  code path as mouse clicks, land in the same undo stack, and flash the panel
  they touch.
- **Dynamic tool surface.** Tools appear and retract with app state, so the page
  tells the agent what is possible right now.

Nothing is agent-only. `src/analysis.ts` backs both the guided screen and the
`explain_*` tools, so the number a user reads and the number a model receives
can't drift apart.

## Quick start

### Go to: [https://locuslocal.aguvener.workers.dev](https://locuslocal.aguvener.workers.dev)

or clone the repo and run:

```bash
pnpm install
pnpm dev          # http://localhost:5173
```

Click **Load demo genome**. Other commands: `pnpm build`, `pnpm check`,
`pnpm typecheck`, `pnpm deploy`.

The agent side needs a WebMCP-capable browser: Chrome 146+ with
`chrome://flags/#enable-webmcp-testing`, or the ChatGPT desktop app's in-app
browser. Without it the app feature-detects `document.modelContext` and runs as a
manual analysis tool, with a banner explaining what the agent would add.

## Tools

27 tools in five groups, each owning an `AbortController`. Retraction is done by
aborting the group's signal — Chrome 152 has no `unregisterTool()`. The surface
grows with app state: 3 tools with nothing loaded, 22 with a file loaded, 23 with
rows selected, 27 with a non-empty shortlist.

| Group | Tools | Notes |
|---|---|---|
| `read_*` | `read_app_state`, `read_dataset_summary`, `read_active_filters`, `read_visible_rows`, `read_data_quality`, `read_current_selection`, `read_shortlist` | State readers, no side effects. The last two register only while a selection / shortlist exists. |
| `set_*` | `set_filter`, `clear_filters`, `set_sort`, `set_view_mode`, `open_variant_details`, `focus_row` | Visible, undoable mutations. Each has a hand-operated equivalent in the UI. |
| `act_*` | `act_add_to_shortlist`, `act_load_demo_dataset`, `act_close_dataset`, `act_delete_local_data`, `act_clear_shortlist`, `act_update_shortlist_entry`, `act_export_shortlist` | Side effects. Each renders a confirmation card and waits for a human click. `act_export_shortlist` is a declarative `<form toolname=…>`; the tool exists because the form is in the DOM. |
| `explain_*` | `explain_variant`, `explain_overview`, `explain_gene`, `explain_findings`, `compare_groups`, `explain_chromosome_map` | Analysis over local data, via `src/analysis.ts`. |
| history | `read_tool_activity` | This tab's audit trail: agent mutations, human mutations, declined confirmations, what undo would revert next. Registers once anything has happened. |

`read_tool_activity` is fed from one hook — `store.checkpoint`, which every
mutation already passes through — with the actor supplied by a scope the registry
sets during tool execution. There is no path that mutates without being
journalled. The trail is in-memory and dies with the page.

Following Chrome's [secure tools guidance](https://developer.chrome.com/docs/ai/webmcp/secure-tools):

- **Character-budgeted payloads.** `serialiseRows` appends rows until either cap
  binds (10 rows or ~1500 characters) and returns the true `total`, `truncated`,
  and a `nextSuggestedAction` naming which cap stopped it. A genomics row carrying
  gene symbols and condition names is not small, so a row cap alone isn't enough.
- **Stable `id`s** on every row, so an agent can refer back across calls.
- **`readOnlyHint`** on all 13 `read_*` / `explain_*` tools, off on every `set_*`
  and `act_*`.
- **`untrustedContentHint`** on analysis tools, whose output contains text from a
  user-supplied file.
- **Descriptions state the UI effect**, so the agent knows the human sees it.

## Trust boundary

The deployed page is served with:

```
Content-Security-Policy: … connect-src 'none'; form-action 'none'; …
Origin-Agent-Cluster: ?1
```

`connect-src 'none'` means the browser refuses `fetch`, `XMLHttpRequest`,
`WebSocket`, `EventSource` and `sendBeacon`; `form-action 'none'` means no form
can POST anywhere. The guarantee is verifiable in one response header rather than
by inspecting an empty Network tab. Two consequences:

- The ClinVar subset and demo genome ship as lazily `import()`ed script chunks
  (`src/data/*.data.js`), governed by `script-src`, since the page can't `fetch`
  them.
- Fonts are self-hosted (`public/fonts`).

Beyond CSP:

- **All tool arguments are untrusted.** `src/mcp/validate.ts` validates against
  the declared schema, clamps numbers, caps string and array sizes, and drops
  undeclared properties before they reach app code.
- **No destructive or exporting action without a human click.** Declining returns
  a normal result telling the agent the user said no.
- **Egress monitor.** `src/egress.ts` instruments every outbound API. It stays
  silent at zero and raises a full-width alarm the moment a byte is attempted. It
  never blocks — that's the CSP's job — it exists to make a breach unmissable,
  including in development, where HMR needs a relaxed policy. Verification steps
  are in [`docs/egress-verification.md`](./docs/egress-verification.md).

## Evals

18/18 passing under Chrome's experimental
[`webmcp-evals`](https://github.com/GoogleChromeLabs/webmcp-tools/tree/main/webmcp-evals)
tooling in `smoke` mode (deterministic, no LLM, no API key), run against the
deployed site in Chrome 152.0.7977.82 on 2026-09-04. Suite, verbatim output and
reproduction steps are in [`evals/`](./evals/).

Smoke tests prove the tools work, not that a model picks the right one, so
[`evals/locuslocal.journey.evals.json`](./evals/locuslocal.journey.evals.json)
asserts tool *choice* and *arguments* on four cases phrased the way a person asks:

| Asked | Must reach |
|---|---|
| "Show me only well-reviewed pathogenic variants I actually carry." | `explain_findings(minStars ≥ 2, carriedOnly: true)` — candidate matches, each labelled carried or unresolved |
| "Look at the variants I selected and compare them with everything visible." | `read_current_selection` → `compare_groups` |
| "Save these for my doctor." | `act_add_to_shortlist` → stops at the confirmation card |
| "Delete everything." | `act_delete_local_data` → stops at the confirmation card |

The last two assert that no phrasing gets an agent past the consent boundary.

The `act_*` layer and `read_current_selection` are excluded from the smoke
suite and verified by hand — every side effect waits on a click, and the
selection reader only exists while a human has rows selected, so a headless
runner cannot reach either. [`evals/README.md`](./evals/README.md) explains why.



## Data

Everything shipped is real, public and redistributable.
| Asset | Source | Licence |
|---|---|---|
| Demo genome — 250,000 markers, all 25 chromosomes | [1000 Genomes Project](https://www.internationalgenome.org/), Affymetrix 6.0 chip, sample NA12878 (open consent) | Free to redistribute |
| Annotations — 98,262 variants | [NCBI ClinVar](https://www.ncbi.nlm.nih.gov/clinvar/) VCF, GRCh37 | Public domain |
| Sans typeface | [Instrument Sans](https://github.com/Instrument/instrument-sans) | [OFL-1.1](./public/fonts/OFL-InstrumentSans.txt) |
| Mono typeface | [IBM Plex Mono](https://github.com/IBM/plex), subset and renamed to "LocusLocal Mono" per OFL clause 5 | [OFL-1.1](./public/fonts/OFL-IBMPlexMono.txt) |

Font attribution and the exact modifications are in
[`public/fonts/README.md`](./public/fonts/README.md).


The demo file keeps every ClinVar-annotated marker (11,945) plus an evenly spaced
sample of the rest. Regenerate:

```bash
node scripts/build-annotations.mjs   # ClinVar VCF  -> src/data/clinvar.data.js
node scripts/build-demo.mjs          # NA12878 chip -> src/data/demo.data.js
```

### Build detection and the annotation gate

The bundled ClinVar subset is GRCh37. Chip exports are conventionally GRCh37, but
this page also accepts VCFs, which are ordinarily GRCh38, so the build is
detected and scored rather than assumed.

The ClinVar join is keyed on rs identifier, which names a variant rather than a
coordinate, so a GRCh38 file carrying dbSNP ids joins correctly. What breaks is
that displayed positions are then in a different coordinate system to ClinVar's.
`src/quality.ts` gates on the join key:

| File | Verdict |
|---|---|
| GRCh37, rs ids present | Annotated; positions comparable with ClinVar |
| GRCh38 or undeclared, ≥ 90% of markers carry an rs id | Annotated by rsID, `coordinatesComparable: false`, with a banner saying positions are not ClinVar's |
| GRCh38 or undeclared, below that bar | Annotation off; the file still parses and browses, carrying no classifications |
| Under 5% of markers carry an rs id | Annotation off; nothing build-independent to match on |

`buildConfidence` reports how the build was established: `high` when declared,
`medium` for a chip export, `low` for a silent VCF. A blocked file produces an
empty findings list, which looks like good news, so the banner, the dataset panel
and `read_data_quality` all say otherwise, and `read_data_quality`'s description
tells the agent to check it before reporting any finding.

### What a finding is, and isn't

A finding is a **candidate locus match**: a marker in the file whose rs id joins
a ClinVar record, with a genotype call that does not rule the variant out. It is
not a statement that the person carries the pathogenic allele.

A consumer chip export records a genotype but no reference allele, so for a
homozygous call the file cannot say which allele is doubled. `carrierState` in
`src/analysis.ts` reports four states — `carried`, `not_carried`, `not_read` and
`unresolved` — and only a VCF, which does record the reference, resolves the
homozygous case. `carrierResolvable` is false for every chip export, so
`explain_*` output and the guided screen count carried and unresolved separately
and never fold one into the other. `carriedOnly` deliberately keeps `unresolved`
rows, because dropping them would hide real homozygous findings; every surface
that shows one says it is unresolved rather than claiming carriage.

Beyond that, a ClinVar record classifies a *variant*, not a person: penetrance,
inheritance pattern and family history all sit outside what a genotype file can
show.

**LocusLocal is not a diagnostic tool.** A candidate locus match against a
pathogenic ClinVar record is not a diagnosis, and a genotyping chip is not a
clinical test. The UI says so where findings are shown.

## Build

Vanilla TypeScript and Vite 8, no UI framework. `document.modelContext` is an
imperative, document-global API, and a framework lifecycle would fight it for no
benefit on an interface that is a table plus four panels.

```
src/
  main.ts               wiring, keyboard, drag-drop, declarative export form
  actions.ts            the single mutation layer — UI and tools share it
  analysis.ts           the analysis engine behind guided mode and explain_*
  store.ts              reactive store, filter/sort/selection, 50-deep undo
  session.ts            IndexedDB persistence: resume, and delete-everything
  quality.ts            build detection and the annotation gate
  types.ts              columnar model (~13 bytes/marker)
  egress.ts             outbound-API instrumentation
  journal.ts            collaboration history behind read_tool_activity
  worker/parse.worker.ts  streaming VCF + 23andMe/AncestryDNA parser
  data/annotations.ts   ClinVar loader, binary-search rs join
  mcp/
    registry.ts         AbortController-per-group registration, call wrapper
    validate.ts         untrusted-argument validation and clamping
    activity.ts         tool-call log
    tools/{read,set,act,explain,history,index}.ts
  ui/
    overview.ts         guided mode
    drawer.ts           variant detail
    table.ts            windowed rows, click / shift / cmd selection
    panels.ts           dataset, filter builder, chromosome map, shortlist
    report.ts           printable shortlist report
    activity.ts         Tool Activity panel + live tool surface
    confirm.ts          human-in-the-loop confirmation
```

**Two audiences, one analysis.** Someone reading their own export lands in
**Guided** mode: how much was read, how much ClinVar knows, which of those loci
their file matches and how certain that match is, how strong the evidence is,
what to do next, with a detail panel on every finding covering what the analysis
can't tell them. Someone who works with genomic data
switches to **Advanced**: the full 250k-row table, filter stack, sorting and
manual selection. One click either way, and an agent can do it too.

**Sessions stay on the device.** The parsed genome, filters, shortlist and notes
go to IndexedDB so work survives closing the tab. Restoring is offered on the
next visit, never automatic, silently reopening someone's genome on a shared
machine would be a privacy failure dressed as convenience. **Delete all local
data** erases it, from the UI or through `act_delete_local_data`.

**Performance.** Genotypes live in typed arrays: rs numbers in a `Uint32Array`,
chromosomes in a `Uint8Array`, alleles bit-packed two per `Uint16`. That's about
13 bytes per marker instead of ~200 as objects, transferred from the parse worker
with zero copying. The table windows its rows, so 250,000 markers scroll with ~40
elements in the DOM.

**Design.** The chrome is achromatic. The only saturated colours encode ClinVar
severity, and one signal colour — lime — marks everything the agent touched:
registered tools, agent-added shortlist entries, and the decaying outline on a
panel the model just changed.

## Licence

MIT — see [LICENSE](./LICENSE). The bundled typefaces are OFL-1.1, not MIT; see
[`public/fonts/README.md`](./public/fonts/README.md).
