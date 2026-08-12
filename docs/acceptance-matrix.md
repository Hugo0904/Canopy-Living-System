# Canopy Living System Acceptance Matrix

This file is the durable traceability list for the operator's requirements.
An item is complete only when implementation and verification evidence both
exist. Later requests extend this list instead of replacing earlier items.

## Product Boundary

| ID | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| B01 | The Living System is optional; Canopy does not depend on its runtime or database. | Implemented | `AGENTS.md`, `backend/app/canopy_adapter.py` |
| B02 | Localhost-first deployment with one command to install, build, start, update, doctor, and uninstall. | Implemented | `living-system`, legacy `observatory` alias, `README.md`, Canopy extension adapter |
| B03 | Runtime data is local and excluded from Git. | Implemented | `.gitignore`, `.data/`, SQLite settings |
| B04 | Operator card changes go through an AI-reviewed proposal, never direct JSONL mutation. | Implemented | `TreatmentComposer.tsx`, `backend/app/proposals.py` |
| B05 | Developers may request Canopy subsystem improvements through the owning workflow. | Implemented | Module detail UI creates owner-routed treatment requests with a bounded manual Codex handoff. |
| B06 | Topology synchronization remains optional, bounded, and fail-open for Canopy Core. | Implemented | Background sync and the UI/CLI recovery action all use the Living System-owned SQLite projection; Core lifecycle fail-open tests pass. |

## Visual Experience

| ID | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| V01 | A lively 3D greenhouse with red, yellow, green, and unknown health signals. | Implemented | `CanopyScene.tsx`, `styles.css` |
| V02 | Detailed, friendly/simple, and no-background modes; simple living units remain in no-background mode. | Implemented | Browser inspection plus `./living-system visual-test` across all three desktop modes. |
| V03 | Traditional Chinese, Simplified Chinese, and English UI. | Implemented | `i18n.ts` |
| V04 | Seed card identifiers have readable translated display labels without changing source IDs. | Implemented | `cardDisplayName()` |
| V05 | Organs use purpose-specific detailed/simple shapes instead of identical spheres. | Implemented | Organ glyph components |
| V06 | Neural-style architecture flows carry moving signals and show arrival absorption. | Implemented | `ConnectionArc` |
| V07 | Detailed-mode flows remain visible from the overview camera. | Implemented | Depth-independent flow rendering; desktop detailed canvas pixel verification passed. |
| V08 | Clicking a living unit centers and enlarges it; free navigation does not immediately snap back. | Implemented | `CameraRig`, `focusRevision`, selected-unit scaling |
| V09 | Detail panels close during scene movement and reopen on selection. | Implemented | Scene interaction callback |
| V10 | Top, left, and bottom HUDs start expanded and can collapse to useful compact summaries. | Implemented | `compactHud` and compact CSS states |
| V11 | Canopy shell and growth tree are clickable architecture objects. | Implemented | DOM and browser navigation select `canopy-shell` and `growth-tree` from the 3D scene. |
| V12 | Structure is richer than seven living units and uses actual Canopy files. | Implemented | Current Canopy public hierarchy exposes 174 bounded nodes and real relative paths; UI drills through them. |
| V13 | Simple mode has a clearly visible cute low-complexity tree and simplified adventure-map nodes. | Implemented | Dedicated faceted tree, six roots, three branches, and simple living-unit platforms; desktop/mobile screenshots verified. |
| V14 | Detailed mode has a distinct adventure-and-ancient-ruins world: layered tree, roots, hollow, moss, stone ring, ruins, runes, vines, lights, and spatial depth. | Implemented | Smooth layered canopy, curved branches, roots, hollow, moss, runes, lanterns, ruins, and rune platforms verified in the detailed screenshot. |
| V15 | No-background mode removes the environmental tree and ruins while retaining simple living units and architecture signals. | Implemented | Desktop no-background screenshot and canvas pixel check passed. |
| V16 | A new public module ID renders without a frontend catalog entry. | Implemented | `topologyLayout.ts` provides deterministic collision-avoiding placement; `GenericOrganGlyph` and source-name fallbacks avoid center overlap, receipt-shaped mislabeling, and translation-key text. |

## Audio

| ID | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| A01 | Multiple distinct, non-vocal, natural/acoustic/piano compositions. | Implemented | Nine complete, locally hosted and licensed tracks, including the original `Sakuya4` master with a non-destructive playback trim. |
| A02 | Music selection changes the actual composition instead of replaying one short arrangement. | Implemented | `ambientBgm.ts` maps every choice to a distinct 85-235 second track and crossfades on change |
| A03 | BGM track, volume, and enabled state survive reload; enabled BGM starts on the first allowed gesture. | Implemented | `localStorage`, hidden observable audio element, and browser activation listener |
| A04 | Buttons have restrained interaction sound. | Implemented | `playUiClick()` |
| A05 | The user can raise BGM to a normalized full-volume ceiling and see source/license attribution. | Implemented | 0-100% volume control, 88% default, and per-track source/license links |

## Navigation And Evidence

| ID | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| N01 | Architecture connections follow Canopy's public topology, not decorative guesses. | Implemented | `config/observability_topology.json` and snapshot projection |
| N02 | Drill from shell/tree to living unit, system, component, and real file with purpose and dependency details. | Implemented | Verified path: growth tree -> Seed Brain -> Brain Circuits -> `seed/brain/circuits/tone_intake.json`. |
| N03 | Each living unit shows recent actions and evidence. | Implemented | Canopy snapshot v3 exposes per-module bounded event IDs; module details show the latest five localized events. |
| N04 | A 30-day timeline can replay prompts, card changes, schedules, distillation, compression, and cleanup. | Implemented | Replay derives safe task summaries, execution outcomes, Seed actions/intake, and miss analysis from existing evidence; raw prompts are intentionally excluded. |
| N05 | Timeline storage has explicit retention, cleanup, privacy, and growth bounds. | Implemented | Canopy derives at most 160 events without new storage; the Living System prunes snapshots after 30 days/500 rows and treatments after 90 days/200 rows. |
| N06 | Historic growth can be viewed as meaningful milestones rather than raw event volume. | Implemented | Daily activity, at most 12 deduplicated milestones, active-unit highlighting, and tree growth replay are visible in the timeline. |
| N07 | “重新同步生命體” revalidates all modules, connections, and structure before rebuilding the local view. | Implemented | `backend/app/topology.py`, `POST /api/sync`, the single UI sync action, `./living-system sync`, last-known-good rejection behavior, and 18 backend contract tests. |

## Treatment And Integration

| ID | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| T01 | Cards can be created, changed, merged, archived, or diagnosed via natural-language AI requests. | Partial | Create/update/merge/archive/diagnose proposal UI is complete; applying still requires AI review and an operator-confirmed Canopy workflow. |
| T02 | Canopy core/governance cannot be directly edited by ordinary users. | Implemented | Capabilities and proposal-only boundary |
| T03 | Maintainers can select a subsystem and open an owner-routed improvement request. | Implemented | Every module detail exposes a diagnose/update request routed to `canopy_core`. |
| T04 | Codex handoff can continue the same treatment context when supported. | Partial | Successful requests expose a copyable request ID and local API handoff; no stable public API currently injects it into the already-open Codex task automatically. |

## Verification Rule

For every completed visual batch:

1. Run backend contract tests.
2. Run the production frontend build.
3. Inspect desktop and mobile rendering.
4. Confirm the canvas is nonblank, controls do not overlap, and the changed
   interaction is observable.
5. Update this matrix with concrete evidence rather than marking all items at
   the end.
