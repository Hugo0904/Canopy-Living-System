# AGENTS.md - Canopy Living System

## Project Boundary

- This repository is Canopy's optional local Living System interface for visibility and treatment proposals.
- The Living System may depend on Canopy's public observation contracts. Canopy must not depend on the Living System's runtime, database, frontend, or generated assets.
- Preserve this priority order in every design and review: (1) smooth Canopy core operation, (2) bounded performance cost, (3) Living System assistance. A richer UI never justifies slowing or destabilizing the core.
- All observation, event capture, import, synchronization, history, and visualization paths are advisory and fail-open relative to Canopy's normal work. Their timeout, exception, corrupt state, missing dependency, or unavailable UI must never block a prompt, tool call, preflight, postflight, or ordinary Canopy command.
- A Canopy installation without this optional Living System must retain its existing behavior and hook footprint. High-frequency event capture and UI synchronization activate only through explicit extension installation or enablement, and removal must restore the base path without leaving required runtime dependencies.
- Core writes only its own bounded, sanitized public observation evidence. This project owns SQLite projection, polling, compaction, rendering, and recovery; the projection must be rebuildable and must never become Canopy's source of truth.
- Prefer incremental reads, persisted snapshots, bounded retention, and background work. Do not add synchronous UI work, database access, network access, an LLM call, or full-history scanning to Canopy's critical path.
- Operator Seed Memory remains local and private. Never copy it into Git fixtures, screenshots, analytics, or shared examples.
- Normal monitoring is deterministic and read-only. Do not add an LLM polling loop.
- A UI action must not directly mutate Seed cards, Canopy governance, roles, receipts, or evidence logs. It creates a typed treatment request for the owning Canopy workflow.

## Data And Security

- Bind the local service to `127.0.0.1` by default.
- Store local history under `.data/`; keep schema migrations in Git and runtime data out of Git.
- Never expose secret values, raw credentials, hidden reasoning, or unrestricted filesystem paths through the API.
- Receipts and logs are evidence. They may be diagnosed or summarized, never edited from this UI.

## Verification

- Verify backend contracts with Python tests.
- Verify the production frontend build.
- Include a negative isolation check for auxiliary event changes: disabled or failing Living System components must leave base Canopy behavior operational and must not make lifecycle hooks fail closed.
- Verify bounded startup, polling, retention, and import behavior so one browser tab cannot trigger duplicate full Core scans.
- For 3D changes, inspect desktop and mobile screenshots and confirm the canvas is nonblank and controls do not overlap.
