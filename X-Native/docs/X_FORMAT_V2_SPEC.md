# The `.x` v2 container

Status: **frozen and shipping** — `SCHEMA_VERSION = 2` in
[`crates/x-format/src/v2.rs`](../crates/x-format/src/v2.rs). The application
writes v2 and reads v1 through the migration chain.

`.x` is JSON, deliberately: a design file should survive a text editor, a diff,
a `grep`, and an incomplete write. v2 is the same engine payload v1 carries,
wrapped in an envelope that adds the things a file needs once more than one
person or one more format touches it — identity, provenance, stable node ids,
and a migration path.

## Envelope

One object, key order fixed so two saves of the same document are byte-equal:

```json
{ "format": "x-native",
  "version": 2,
  "metadata": { "name": "Audit", "uuid": "…", "app_version": "0.34.0" },
  "fonts": [ { "family": "…", "style": "…", "source": "…" } ],
  "asset_manifest": [ { "id": "…", "kind": "png", "sha256": "…", "href": "…" } ],
  "uuids": { "/page-0/card-1": "0f3c…", "…": "…" },

  "variables": { … }, "pages": [ … ], … }
```

The last block is the v1 payload verbatim (`save_x` emits
`{"format":"x-native","version":1,…}`, and `save_x_v2` strips that prefix and
appends the rest). `X_FORMAT_VERSION` in `crates/x-format/src/lib.rs` stays `1`
— it is the *engine payload* version, and the container version is
`SCHEMA_VERSION`. Node keys inside the payload are sorted by the v1 serializer,
which is what makes determinism possible at all.

`fonts` is what the renderer needs to draw the file (`family`, `style`, and a
`source` that is either a system lookup or a path). `asset_manifest` describes
image bytes by hash and href rather than embedding them, so a file stays a text
file and an asset store can be swapped underneath it.

## Identity and stable UUIDs

`metadata.uuid` is `fnv1a128(text)` of the pre-migration bytes: migrating the
same v1 file twice yields the same identity, and identity is therefore not a
counter.

Node identity is the harder half, because ids are user-editable and short. The
`uuids` map keys are node *paths* from the root (`/page-0/card-1`) and values are
32-hex-digit ids derived by `backfill_uuids` — again FNV-1a 128 over the path, so
backfill is deterministic. Saving re-runs the backfill and then copies the
previous value for every path that already existed
(`apps/x-designer/src/bin/x_native_app/session.rs`), which is what keeps an
external reference — a prototype destination, a clipboard payload, a comment
anchor — valid across a save.

A document whose ids change on save is a document nobody can reference from
outside it. That is the whole reason this section exists.

## Reading

| Entry point | Contract |
|---|---|
| `load_x_any(text)` | version-dispatching loader; walks the migration chain stepwise, errors on a newer file |
| `load_checked(text)` | lenient parse → `validate()` → `(DocumentV2, Vec<Issue>, Vec<RecoveryNote>)`; never panics, never refuses to show you something |
| `load_x_lenient(text)` | never-fail loader: parse the longest valid prefix by brace balancing, then close it; reports a `RecoveryNote` per repair |
| `list_pages(text)` / `load_page(text, id)` | partial loading: page byte ranges without materializing the document, so a 40-page file opens as one page |
| `sniff_version(text)` | reads `version` before anything else is trusted |

`crates/x-format/src/deserialize.rs` refuses a payload newer than the loader and
names `load_x_any` in the message, so a v3 file opened by an older build fails
with instructions rather than silently dropping fields.

## Validation codes

`validate()` returns findings; it does not stop the load. These are the codes and
the corruption class each one catches:

| Code | Meaning |
|---|---|
| `E001` | duplicate node id within a page |
| `E002` | instance references a component that is not in the page |
| `E003` | override targets a node that the component does not contain |
| `E004` | binding points at an undefined variable |
| `E005` | prototype destination is not a page in the document |
| `E006` | non-finite or negative geometry |

Recovery and validation are separate axes on purpose: a file can be *recovered*
(truncated tail, repaired bracket) and still be *invalid* (a dangling variable).
The editor shows both; the CLI gate is `x_native validate <file>`, which
load → save → load and compares structural stats, exiting 5 when the round-trip
loses content.

## Budgets

Admission limits live in
[`crates/x-format/src/admission.rs`](../crates/x-format/src/admission.rs) and are
enforced before allocation: `MAX_INPUT_BYTES` = 64 MiB, `MAX_NODES` = 100 000,
`MAX_COORDINATE` = 1e9. `load_x_lenient` refuses to attempt recovery at all
above the input budget ("input exceeds recovery budget") — a truncated 60 MB file
is a repair job, and a truncated 600 MB one is an attack.

Envelope strings are bounded too: `metadata.name` and `metadata.uuid` ≤ 1024
bytes, `app_version` ≤ 256, checked at the end of `load_v2`.

## Migrations

```rust
pub type Migration = fn(&str) -> Result<String, String>;
pub const MIGRATIONS: &[(u32, Migration)] = &[(1, migrate_v1_to_v2)];
```

The chain is the contract: index `N` upgrades schema `v(N+1)` to `v(N+2)`.
`migrate_v1_to_v2` is pure — load with the v1 loader, attach metadata, backfill
uuids, re-save. Adding v3 means appending one function to this table and raising
`SCHEMA_VERSION`; no loader call site changes, which is the property that makes a
"freeze" worth declaring.
