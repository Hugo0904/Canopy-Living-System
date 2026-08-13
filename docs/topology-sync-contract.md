# Canopy Living System Topology Sync Contract

## Canonical request

> 重新同步生命體

This sentence has one stable meaning. It does not ask an operator to redraw the
scene. It asks the Living System to read Canopy's current public snapshot,
validate the full topology, rebuild its local projection atomically, and report
what changed.

## Ownership

- Canopy Core owns the versioned public snapshot and its module, connection,
  and structure semantics.
- The Living System owns validation, SQLite projection, deterministic layout,
  rendering, polling, recovery, and last-known-good state.
- SQLite is a rebuildable projection, never a source of truth.
- Canopy never imports or calls this repository. Missing, stopped, broken, or
  uninstalled Living System code cannot block a Canopy prompt or lifecycle hook.

## Automatic flow

1. The backend performs one bounded public snapshot scan on its existing
   background interval. Browser tabs only read the persisted SQLite projection;
   they do not start additional Core scans.
2. Before saving, the consumer verifies unique module, connection, and structure
   node IDs; connection endpoints and signal semantics; connected top-level
   modules; structure parents, edges, dependencies, cycles, and root reachability.
3. A valid fingerprint is stored through the existing deduplicated snapshot
   path. The UI notices the new persisted snapshot without a reload.
4. Known modules keep their curated art. Any unknown module gets a stable generic
   glyph and collision-avoiding deterministic position, and its connections use
   the same generated position map.
5. Invalid or temporarily unavailable topology is rejected. The previous
   verified projection remains visible and Canopy continues normally.

## Snapshot truth states

The Living System consumes only `canopy observe snapshot --json`. It does not
reparse Seed Health JSON, private cards, policy files, or mutable runtime state
when that command fails.

`GET /api/snapshot` and `POST /api/sync` return the same envelope:

```json
{
  "snapshot": {},
  "sync": {
    "observation_state": "observed | no_data | contract_invalid",
    "projection_state": "current | last_known_good | unavailable",
    "using_last_verified": false
  }
}
```

- `observed` means the normalized schema and complete topology both passed.
  An explicitly published numeric zero remains zero.
- `no_data` means no current collection has completed. A verified persisted
  projection may remain visible, but its health colors are suppressed.
- `contract_invalid` means collection, normalized schema, or required topology
  validation failed. It never replaces the previous verified SQLite row and is
  never presented as healthy.
- A required metric key that is absent makes the snapshot `contract_invalid`;
  a present metric with a null value is shown as **data unavailable**. Neither
  case becomes numeric zero.
- Optional provider evidence may degrade through an explicit public issue. A
  required missing path must fail the provider contract instead of becoming an
  empty array or a healthy module.

## Provider checklist for a new Canopy capability

When a feature becomes a new top-level living unit rather than an internal file:

1. Give it a stable, non-display `module.id`; never reuse an old ID for a new
   meaning.
2. Publish its health, activity, impact, confidence, and metrics in Canopy's
   existing public snapshot module registry/builder.
3. Add its architectural connections to Canopy's single versioned topology
   manifest. Every endpoint must exist and the new unit must not be isolated.
4. Add its structure catalog root and bounded public paths. Do not expose raw
   prompts, secrets, private Seed state, logs, or absolute local paths.
5. Bump the relevant public contract version when semantics or required fields
   change, then run Canopy's observation-contract tests.
6. Run `重新同步生命體` from the UI (preferred) or the CLI fallback below and
   verify the reported module and connection counts plus the actual desktop and
   narrow viewport.

Internal-only capability changes do not need a new top-level module. They only
need to appear under the owning module's structure subtree when public navigation
is useful.

## Recovery and CLI fallback

Normal use is automatic. If an immediate refresh is needed, use the UI action
**重新同步生命體並確認所有連接**. For a stopped UI or terminal diagnosis:

```bash
cd /Users/shawn/Code/Canopy-Living-System
./living-system sync --canopy-root /Users/shawn/Code/Canopy
```

Success reports verified living-unit and connection counts. Failure names the
contract problem and keeps the last verified projection. Fix the Canopy public
contract and repeat the same action; never patch the SQLite projection by hand.
