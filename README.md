# Canopy Living System

Canopy Living System is an optional, local-first visual companion for Canopy. It
turns Canopy's health, Seed Memory, Brain, roles, Evolution, resource lifecycle,
hooks, and receipts into a navigable 3D greenhouse.

Canopy continues to work without this repository. The Living System only reads
Canopy's public observation contracts and keeps its own local history under
`.data/`.

The interface includes a bounded 30-day growth replay, per-living-unit recent
evidence, Seed Memory proposal workflows, maintainer subsystem treatments, and
three visual worlds. Activity is derived from existing Canopy receipts and task
summaries without copying raw prompts or adding a second event database.

The 3D scene includes a separate read-only **Laboratory** facility associated
with the Evolution Rings. It is a UI projection, not a Canopy Core module or
topology node, and is backed by `canopy observe evolution --json`. It shows only
bounded, allowlisted public metrics and candidate observations; missing
Proposal, Review, Experiment, Adoption, or Monitoring evidence is shown as
unreported rather than inferred.

The optional background music is hosted locally from credited CC0 and Creative
Commons sources so playback stays offline and predictable. Attribution and
source details are recorded in `public/assets/audio/README.md`; no audio or
melody is copied from the operator's musical reference.

## Quick Start

From this repository:

```bash
./living-system start --canopy-root /path/to/Canopy
```

The first run creates an isolated Python environment, installs frontend
dependencies, builds the UI, initializes SQLite, starts a localhost server, and
opens the browser. Later runs reuse the installation.

When the Canopy adapter is installed, the shorter command is:

```bash
canopy living-system
```

## Lifecycle

```bash
./living-system doctor --canopy-root /path/to/Canopy
./living-system start --canopy-root /path/to/Canopy
./living-system sync --canopy-root /path/to/Canopy
./living-system stop
./living-system update --canopy-root /path/to/Canopy
./living-system uninstall
```

`uninstall` removes generated local runtime data and dependencies from this
checkout. It does not remove Canopy, Seed Memory, or this Git repository.
Install, start, and update also ask Canopy Core to verify its optional managed
activity hooks through the narrow `canopy repair codex-hooks` contract. Uninstall
first asks Core to restore the base hook footprint. The Living System never edits
the hooks file or decides that a Core health finding is resolved.

The Living System normally synchronizes in the background. The UI action
**Sync living system** forces the same bounded refresh and reports how many
living units and connections were verified. `./living-system sync` is the CLI
fallback for maintenance or diagnosis; an invalid graph never replaces the
last verified SQLite projection.

## Topology Sync

Canopy owns the source graph through its versioned public snapshot contract.
This repository validates and projects that graph; it does not maintain a
second module or connection catalog. Unknown module IDs receive a deterministic
generic position and visual automatically, while bespoke art remains optional.

The canonical maintenance request is **“重新同步生命體”**. Its exact contract,
provider checklist, validation gates, and recovery behavior are documented in
[`docs/topology-sync-contract.md`](docs/topology-sync-contract.md).

## Development

Node.js 20 or newer is required. The lifecycle script automatically selects a
compatible local Node installation, so use it for reproducible builds:

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
./living-system install --canopy-root /path/to/Canopy
./living-system build
```

For frontend hot reload, start the backend and then run Vite with a Node 20+
installation. The Vite server proxies `/api` to port 8765.

The former `./observatory` and `canopy observatory` commands remain compatibility
aliases for existing local installations; new documentation uses Living System.

```bash
CANOPY_ROOT=/path/to/Canopy .venv/bin/python -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8765
```

## Mutation Boundary

Operators may inspect their local cards and describe a desired change in
natural language. The Living System stores a `SeedChangeProposal` request and exports
a bounded Codex handoff. It does not edit JSONL directly. Applying a proposal
remains a future Canopy-owned mutation contract with schema validation,
retrieval regression, confirmation, receipts, and rollback.
