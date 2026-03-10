# Observable Mol3D Frontend Modules

This folder is organized as small, dependency-ordered modules that all attach to
`window.ObservableMol3D`.

## Load order

1. `dashboard_mol3d_constants.js`
2. `dashboard_mol3d_utils.js`
3. `dashboard_mol3d_store.js`
4. `dashboard_mol3d_shared.js`
5. `dashboard_mol3d_geometry.js`
6. `dashboard_mol3d_measurement.js`
7. `dashboard_mol3d_vector_overlay.js`
8. `dashboard_mol3d_viewer.js`
9. `dashboard_mol3d_io_transformers.js`
10. `dashboard_mol3d_io_network.js`
11. `dashboard_mol3d_io_vector_ops.js`
12. `dashboard_mol3d_io_app.js`
13. `dashboard_mol3d_io.js`
14. `dashboard_mol3d_page.js`

## Responsibilities

- `dashboard_mol3d_constants.js`
  - Immutable app-level constants and measurement metadata
  - Playback/NAC/GIF tuning parameters and periodic table symbols

- `dashboard_mol3d_utils.js`
  - Shared pure helpers (`clampNumber`, `parseFiniteNumber`)
  - Filename sanitization and hex color normalization helpers

- `dashboard_mol3d_store.js`
  - Lightweight `getState/dispatch/subscribe` store
  - Stage-1 reducer coverage for playback/NAC/GIF UI state slices only

- `dashboard_mol3d_shared.js`
  - Bootstrap JSON parsing
  - Shared DOM references and global state assembly
  - Store wiring + compatibility exports (`root.shared.*`)
  - Generic UI/status helpers

- `dashboard_mol3d_geometry.js`
  - Geometry adapters around `window.ObservableDashboardMath`
  - Atom index resolution and canonical measurement key normalization

- `dashboard_mol3d_measurement.js`
  - Measurement track lifecycle (create/remove/highlight/color)
  - Measurement list/color panel rendering
  - Plotly line plot rendering and cursor updates

- `dashboard_mol3d_vector_overlay.js`
  - Vector arrow primitives and magnitude-to-color mapping
  - Registry-based vector overlay sources (`registerVectorSource`)
  - Per-frame rendering of all registered vector sources

- `dashboard_mol3d_viewer.js`
  - 3Dmol viewer rendering and playback loop
  - Overlay labels/lines for highlighted measurements
  - Delegates vector overlays to the vector-overlay module

- `dashboard_mol3d_io_transformers.js`
  - Pure payload/geometry transformation helpers for mol3d IO
  - XYZ frame construction, payload normalization, NAC magnitude statistics

- `dashboard_mol3d_io_network.js`
  - URL construction + fetch wrappers for trajectory/NAC/dE/dE-NAC API endpoints
  - Frontend cache and in-flight request de-duplication

- `dashboard_mol3d_io_vector_ops.js`
  - Config-driven NAC/dE/dE-NAC vector orchestration (`VECTOR_KIND_CONFIG`)
  - Pair load/reset/visibility flows, range-label updates, and vector source registration
  - Shared pair-selector synchronization for NAC and dE-NAC controls, plus independent dE pair selectors (including diagonal i=j)
  - dE accepts both diagonal/off-diagonal pairs; NAC and dE-NAC keep i!=j semantics
  - dE color/auto-scale mapping prefers trajectory-global quantiles (`de_global_norm_*`) so state-pair changes remain comparable

- `dashboard_mol3d_io_app.js`
  - Application orchestration for trajectory loading, GIF export, and file downloads
  - Delegates NAC/dE/dE-NAC vector flows to `root.ioVectorOps`

- `dashboard_mol3d_io.js`
  - Compatibility facade for `root.io`
  - Forwards legacy entrypoints to `root.ioApp` and `root.ioTransformers`

- `dashboard_mol3d_page.js`
  - Page-level orchestration
  - Event binding for controls
  - Initial trajectory load and cleanup lifecycle

## Refactor notes

- Keep exported API names stable (`root.shared`, `root.measurement`, etc.) to
  avoid breaking cross-module calls.
- Stage-1 store integration intentionally targets playback/NAC/GIF UI sync
  paths; measurement and IO remain largely direct-state for compatibility.
- Prefer extracting repeated sequences into small helpers
  (for example refresh/render paths and timer restart paths).
