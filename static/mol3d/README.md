# Observable Mol3D Frontend Modules

This folder is organized as small, dependency-ordered modules that all attach to
`window.ObservableMol3D`.

## Load order

1. `dashboard_mol3d_shared.js`
2. `dashboard_mol3d_geometry.js`
3. `dashboard_mol3d_measurement.js`
4. `dashboard_mol3d_viewer.js`
5. `dashboard_mol3d_io.js`
6. `dashboard_mol3d_page.js`

## Responsibilities

- `dashboard_mol3d_shared.js`
  - Bootstrap JSON parsing
  - Shared constants, DOM references, and global state
  - Generic UI/status helpers

- `dashboard_mol3d_geometry.js`
  - Geometry adapters around `window.ObservableDashboardMath`
  - Atom index resolution and canonical measurement key normalization

- `dashboard_mol3d_measurement.js`
  - Measurement track lifecycle (create/remove/highlight/color)
  - Measurement list/color panel rendering
  - Plotly line plot rendering and cursor updates

- `dashboard_mol3d_viewer.js`
  - 3Dmol viewer rendering and playback loop
  - Overlay labels/lines for highlighted measurements

- `dashboard_mol3d_io.js`
  - Trajectory fetch/cache, XYZ conversion, file downloads
  - GIF export pipeline and cancellation flow

- `dashboard_mol3d_page.js`
  - Page-level orchestration
  - Event binding for controls
  - Initial trajectory load and cleanup lifecycle

## Refactor notes

- Keep exported API names stable (`root.shared`, `root.measurement`, etc.) to
  avoid breaking cross-module calls.
- Prefer extracting repeated sequences into small helpers
  (for example refresh/render paths and timer restart paths).
