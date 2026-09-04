# Bundled fonts

Both families are self-hosted because the deployed page ships
`Content-Security-Policy: … connect-src 'none'; …` and so cannot fetch a webfont
from a CDN. Both are licensed under the SIL Open Font License 1.1; the full
licence text ships next to the font files and is served from the deployed site.

| File | Upstream family | Copyright | Licence |
|---|---|---|---|
| `instrument-sans-var.woff2` | [Instrument Sans](https://github.com/Instrument/instrument-sans) (variable, 400–700) | Copyright 2022 The Instrument Sans Project Authors | [OFL-1.1](./OFL-InstrumentSans.txt) |
| `plex-mono-400.woff2`, `plex-mono-500.woff2`, `plex-mono-600.woff2` | [IBM Plex Mono](https://github.com/IBM/plex) (static instances) | Copyright © 2017 IBM Corp. with Reserved Font Name "Plex" | [OFL-1.1](./OFL-IBMPlexMono.txt) |

## Modifications

Every file here is a Latin subset of its upstream release, which makes it a
Modified Version under the OFL.

- **IBM Plex Mono** carries the Reserved Font Name "Plex", so OFL clause 5
  forbids the modified files from using it. They are renamed to **LocusLocal
  Mono** in the `name` table and in `src/styles.css` (`--mono`); the file names
  keep their `plex-mono-*` stems only to record where the outlines came from.
- **Instrument Sans** declares no Reserved Font Name, so the subset keeps the
  family name.

The upstream copyright notice and a licence reference are carried in `name` IDs
0, 13 and 14 of every file, as clause 2 requires.
