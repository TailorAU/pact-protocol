# Storage

## Embedded default (this repo)

Zero external services: everything runs in-process against the filesystem, under the
gitignored `intelligence/var/`. This is deliberate — CI, the smoke test, and a laptop
all get the identical stack, and the layout is the *contract*; the engine behind it is
swappable.

```
var/
  bronze/{source_id}/{yyyy}/{mm}/{dd}/{artifact_id}.bin      verbatim fetched bytes
  bronze/{source_id}/{yyyy}/{mm}/{dd}/{artifact_id}.meta.json url, fetched_at, sha256,
                                                              http_status, headers subset
  silver/{feed_id}/{yyyy-mm-dd}.jsonl                        one Observation per line,
                                                              append-only
  gold/state/{snapshot_ts}.json                              current-state snapshots
  gold/graph/deltas.jsonl                                    entity/relationship patches,
                                                              hash-chained (prev_hash)
  gold/inferences/{yyyy-mm-dd}.jsonl                         Inference records
  resolution-candidates.jsonl                                entity-resolution output
```

Rules:

- **Bronze is immutable.** Artifacts are content-addressed by sha256 in their metadata;
  a re-fetch of changed content is a new artifact, never an overwrite.
- **Silver is append-only.** Corrections are new lines with `is_correction: true`;
  nothing is rewritten.
- **Gold is disposable.** Anything in gold must be reproducible from bronze + versioned
  code. Deleting `var/gold` and re-running ingestion is always safe.
- **The graph delta journal is truth.** `gold/graph/deltas.jsonl` is hash-chained
  (`prev_hash` over the canonical JSON of the previous line, `"GENESIS"` first — the
  same construction as PACT §6.4). In-memory graph state is a projection of registry
  YAML + this journal.

## Production mapping (documented, not built here)

| Embedded piece | Production substitution |
|---|---|
| bronze files | object store (S3/GCS) with lifecycle rules, same path scheme |
| silver JSONL | TimescaleDB hypertables or ClickHouse (observations table, partitioned by feed/day) |
| current-state projection | Redis/inline materialised view fed by the same delta bus |
| gold graph journal | the same journal, plus a graph database (Kùzu embedded or Neo4j) built from it |
| cooperative scheduler | per-connector workers (containers) + a queue; identical Connector interface |

The `Store` interface in `packages/store/src/` is the seam: implementations must
preserve the three-tier rules above, and nothing outside the package may touch `var/`
directly.
