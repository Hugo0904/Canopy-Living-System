# Canopy Living System

Canopy Living System is an optional, local-first visual companion for Canopy. It
turns Canopy's health, Seed Memory, Brain, roles, Evolution, resource lifecycle,
hooks, and receipts into a navigable 3D greenhouse.

Canopy continues to work without this repository. The Living System only reads
Canopy's public snapshot contract and keeps its own local history under
`.data/`.

The interface includes a bounded 30-day growth replay, per-living-unit recent
evidence, Seed Memory proposal workflows, maintainer subsystem treatments, and
three visual worlds. Activity is derived from existing Canopy receipts and task
summaries without copying raw prompts or adding a second event database.

The optional background music is hosted locally from credited CC0 and Creative
Commons sources so playback stays offline and predictable. Attribution and
source details are recorded in `public/assets/audio/README.md`; no audio or
melody is copied from the operator's musical reference.

## Quick Start

From this repository:

```bash
./observatory start --canopy-root /path/to/Canopy
```

The first run creates an isolated Python environment, installs frontend
dependencies, builds the UI, initializes SQLite, starts a localhost server, and
opens the browser. Later runs reuse the installation.

When the Canopy adapter is installed, the shorter command is:

```bash
canopy observatory
```

## Lifecycle

```bash
./observatory doctor --canopy-root /path/to/Canopy
./observatory start --canopy-root /path/to/Canopy
./observatory stop
./observatory update --canopy-root /path/to/Canopy
./observatory uninstall
```

`uninstall` removes generated local runtime data and dependencies from this
checkout. It does not remove Canopy, Seed Memory, or this Git repository.

## Development

Node.js 20 or newer is required. The lifecycle script automatically selects a
compatible local Node installation, so use it for reproducible builds:

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
./observatory install --canopy-root /path/to/Canopy
./observatory build
```

For frontend hot reload, start the backend and then run Vite with a Node 20+
installation. The Vite server proxies `/api` to port 8765.

```bash
CANOPY_ROOT=/path/to/Canopy .venv/bin/python -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8765
```

## Mutation Boundary

Operators may inspect their local cards and describe a desired change in
natural language. The Living System stores a `SeedChangeProposal` request and exports
a bounded Codex handoff. It does not edit JSONL directly. Applying a proposal
remains a future Canopy-owned mutation contract with schema validation,
retrieval regression, confirmation, receipts, and rollback.
