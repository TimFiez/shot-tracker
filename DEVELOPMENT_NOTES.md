# Shot Tracker — Development Notes

This document captures the architecture, design decisions, known issues, and development history of Shot Tracker. It exists so that future development (by Tim or with AI assistance) can pick up without re-litigating solved problems.

---

## Project origin

Built iteratively in Claude (claude.ai) over a single extended conversation, May 2026. Tim (TimFiez) is a precision rifle shooter competing in NRL Hunter, conducting load development for 6.5 Creedmoor with Berger 153.5gr LRHT and Hornady 153gr A-Tip bullets. The tool was built because no existing app (Ballistic-X, Hornady 4DOF, OnTarget TDS, TARAN) correctly combined:

1. Marking impacts on phone-camera target photos with variable scale
2. Aggregating multiple targets/sessions into a single composite view
3. Exporting individual shot XY offsets (H/V from POA and from centroid)
4. Computing correct centroid-based group statistics (not POA-based)

---

## Core statistics — the PRB method

**Source:** [PrecisionRifleBlog — Statistics for Shooters Part 3](https://precisionrifleblog.com/2020/12/12/measuring-group-size-statistics-for-shooters/)

All group precision stats are calculated from the **group centroid**, not from the POA. This is the correct definition — a tight group that is off-center from POA should show a small mean radius, not an inflated one.

### Calculation sequence

```
1. Centroid X = mean of all shot X offsets from POA (in inches)
2. Centroid Y = mean of all shot Y offsets from POA (in inches)
3. Per-shot radius from centroid = sqrt((shot.x - centroid.x)² + (shot.y - centroid.y)²)
4. Mean Radius (MR) = mean of all per-shot radii
5. R95 = MR × 2.1   ← 95th percentile radius estimate
6. Extreme Spread (ES) = maximum shot-to-shot distance (CTC), all pairs
```

### Two distinct measurements displayed

- **POA offset** (left stats panel): where the group CENTER sits relative to aim point. This is your zero error. H offset = centroidX, V offset = centroidY.
- **Group precision** (right stats panel): how tight the group is around its own center. MR, R95, ES are all centroid-based.

These are deliberately separated in the UI because conflating them (as most apps do) gives misleading results for off-zero groups.

### Coordinate system

- X increases right (positive H offset = shots hit right of POA)
- Y increases up (positive V offset = shots hit high of POA)
- Canvas Y is inverted (increases down), so: `offset.y = -(shot.ny - poa.ny) / pxPerInch`
- Natural image pixels (`nx`, `ny`) are stored; canvas display coordinates are derived at render time

---

## Architecture

### File structure

```
shot-tracker/
├── index.html          # DOM structure only — no inline JS, no inline styles
├── style.css           # All CSS including responsive breakpoints and dark mode
├── app.js              # All application logic (~875 lines)
├── sw.js               # Service worker for offline caching
├── manifest.json       # PWA manifest for "Add to Home Screen"
├── icon-192.png        # App icon (solid dark square — replace with proper icon)
├── icon-512.png        # App icon (solid dark square — replace with proper icon)
├── README.md           # User-facing setup and usage docs
└── .github/
    ├── workflows/deploy.yml          # GitHub Actions → GitHub Pages auto-deploy
    └── ISSUE_TEMPLATE/
        ├── bug_report.md
        └── feature_request.md
```

### State machine

Three independent state variables control canvas behavior:

```javascript
var calMode = false;  // Boolean — calibration in progress
var calPoints = [];   // Array of {nx, ny} — accumulates 2 clicks
var mode = 'poa';     // String: 'poa' | 'shot' | 'edit'
```

**Critical:** `calMode` is checked FIRST in `handleDown()` in a fully isolated branch that always `return`s. It never falls through to the `mode` branches. `setMode()` is never called from within the calibration branch until AFTER `calMode = false` is set. This isolation was the fix for the calibration click bug (see Bug History below).

### Coordinate storage

All markers (POA, shots, cal points) are stored in **natural image pixel coordinates** (`nx`, `ny`). Canvas display coordinates are never stored — they are derived at render time as `nx * getScale(canvas)`. This means:

- Reloading a session always places markers correctly regardless of canvas size
- The canvas can be resized freely without corrupting marker positions
- Both desktop and mobile canvases share the same state and render identically

### Dual canvas

The app maintains two canvases rendered identically: `dCanvas` (desktop) and `mCanvas` (mobile). Both are always sized and rendered together via `renderBoth()`. This means resizing the window never loses work and both layouts stay in sync.

### Persistence layers

```
IndexedDB (automatic)
  └── Sessions survive closing the browser tab, no user action needed
  └── Loaded on boot, saved after every session save/update/delete
  └── Store name: 'sessions', DB name: 'shot-tracker', version 1

localStorage (settings only)
  └── Key: 'st_settings'
  └── Stores: storageMode, calDefault, autoBackup

Backup file (manual, user-initiated)
  └── JSON with version field, savedAt timestamp, sessions array
  └── Images embedded as base64 data URLs (~3-5MB per phone photo)
  └── On iOS: "Save to Files" → iCloud Drive → syncs across all Apple devices
  └── On Mac: save anywhere in ~/Library/Mobile Documents/ for iCloud sync
```

---

## Calibration system

**Why calibration is required every image:** Target photos come from a phone camera at variable distances. There is no reliable way to know the real-world scale of a photo without a reference. Every new image must be calibrated.

**Default reference:** 1 inch (pre-filled), because Tim uses 1" grid squares on his targets. Configurable in Settings.

**Workflow:**
1. Image loads → `startCal()` fires automatically
2. Yellow cal bar appears with distance input and progress indicator
3. User clicks two points on a known reference (e.g., opposite corners of a 1" grid square)
4. `pxPerInch = pixelDistance / referenceInches`
5. Cal bar hides, mode advances to 'poa'

**Pixel-to-inches conversion:**
```javascript
function pxToIn(naturalPixels) {
  return pxPerInch ? naturalPixels / pxPerInch : naturalPixels / (imgNaturalW / 36);
}
```
The fallback `imgNaturalW / 36` is an uncalibrated estimate (assumes 36" image width) — stats are labeled `~in` when uncalibrated.

**R95 circle on target image:** Only rendered when calibrated, because the circle radius in canvas pixels depends on `pxPerInch`. Formula: `r95_canvas_px = r95_inches * pxPerInch * canvasScale`.

---

## Responsive layout

**Breakpoint:** 640px CSS width.

- **Desktop (>640px):** CSS Grid two-column layout. Left sidebar (272px) + main content. Stats always visible. Composite view in tab.
- **Mobile (≤640px):** Full-width flex column. Sidebar becomes bottom drawer (slide-up sheet). Stats hidden by default behind a tap-to-reveal toggle. Step bar scrolls horizontally. Mode buttons show icons only (no labels). Canvas fills remaining height.

Both layouts share all state, all canvases render from the same data, and all event handlers call the same underlying functions.

**iOS safe areas:** `env(safe-area-inset-top)` and `env(safe-area-inset-bottom)` applied to mobile topbar and drawer to avoid notch/Dynamic Island/home indicator overlap.

---

## PWA features

- **Manifest:** `manifest.json` with `display: standalone`, `orientation: any`, icons at 192 and 512px
- **Service worker:** `sw.js` caches all app assets + Tabler icon font on install. Serves from cache first, falls back to network. Handles offline gracefully.
- **Install prompt:** `beforeinstallprompt` event caught and deferred; shown as a banner. Fires on Android/Chrome. On iOS Safari, user must manually tap Share → Add to Home Screen (Apple does not support the install prompt API).
- **Apple-specific meta tags:** `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style: black-translucent`, `apple-mobile-web-app-title`

---

## Feedback channels

Three paths in Settings panel:

| Channel | URL | Best for |
|---------|-----|----------|
| Google Form | https://docs.google.com/forms/d/e/1FAIpQLSdAtZMd7R0NdmIinvvlbewsCCRkTY1iOY7cebsJTmz5Ta_W3g/viewform | General feedback, non-technical users |
| GitHub Issues (bug) | github.com/TimFiez/shot-tracker/issues/new?labels=bug | Bug reports with device/browser context |
| GitHub Issues (feature) | github.com/TimFiez/shot-tracker/issues/new?labels=enhancement | Feature requests with use-case context |

Issue templates auto-assign to TimFiez and pre-label with `bug` or `enhancement`.

---

## Export formats

### Backup file (JSON)
Full session state including embedded images (base64). Large — ~3-5MB per phone photo session. Version field allows future migration. Structure:
```json
{
  "version": 2,
  "savedAt": "2026-05-26T...",
  "sessions": [
    {
      "name": "H4350 load 1",
      "dist": 100,
      "notes": "41.5gr, 2490fps",
      "calibrated": true,
      "pxPerInch": 142.3,
      "imgSrc": "data:image/jpeg;base64,...",
      "imgW": 4032, "imgH": 3024,
      "poa": { "nx": 2016.0, "ny": 1512.0 },
      "shots": [
        { "nx": 2034.2, "ny": 1498.7 },
        ...
      ],
      "savedAt": "2026-05-26T..."
    }
  ]
}
```

### Spreadsheet (CSV)
Per-shot rows with both POA-relative and centroid-relative coordinates:
```
Session, Session #, Distance (yd), Calibrated, Shot #,
H from POA (in), V from POA (in),
H from centroid (in), V from centroid (in),
Radius from centroid (in), Notes
```

### Composite image (PNG)
`compCanvas.toDataURL('image/png')` — the composite view rendered at 480×480px with all sessions color-coded, R95 circle, centroid marker, POA crosshair, scale labels, and session legend.

---

## Bug history

### Calibration second click lost (fixed v9)
**Symptom:** First calibration click placed correctly, second click was lost and the UI behaved as if setting POA instead.

**Root cause:** `handleDown()` pushed the first cal point, then fell through to non-cal logic. On the second click, `calMode` had already been set to `false` by a call to `setMode('poa')` triggered at the end of the first click's processing, before the second click arrived.

**Fix:** `calMode` is now checked FIRST in `handleDown()` in a completely isolated branch that always `return`s. `setMode()` is only called AFTER `calMode = false` is explicitly set and all calibration state is finalized. No fall-through is possible from the cal branch to any other branch.

### Marker alignment on session reload (fixed v4)
**Symptom:** Loading a saved session showed markers visibly offset from their original positions.

**Root cause:** Markers were stored with both natural-pixel coordinates (`nx`, `ny`) AND canvas display coordinates (`cx`, `cy`). On reload, the canvas was sized after the image loaded, giving a different `canvasScale`. The old `cx`/`cy` values (from the original canvas size) were used for rendering, causing misalignment.

**Fix:** Only natural image pixel coordinates are stored. Canvas display coordinates are always derived at render time as `nx * getScale(canvas)`. The `cx`/`cy` fields were removed entirely.

### Session overwrite bug (fixed v3)
**Symptom:** Saving a third session would overwrite the first session instead of appending.

**Root cause:** `activeSessionIdx` remained set after saving, so every subsequent save call went into the update branch instead of the append branch.

**Fix:** Separated "Save as new session" (always appends, sets `activeSessionIdx` to the new index) from "Update session #N" (explicitly updates the loaded session). Clear UI labels for each action.

### Delete button not firing (fixed v3)
**Symptom:** Clicking "Delete" on a session card did nothing.

**Root cause:** Inline `onclick` attributes in dynamically-generated HTML were blocked by the iframe sandbox on claude.ai. The buttons were rendered but their handlers never registered.

**Fix:** All session list items are built with `document.createElement()` and event listeners attached with `addEventListener()` using closures to capture the index. No inline `onclick` anywhere in dynamic HTML.

### confirm() dialog blocked (fixed v3)
**Symptom:** Delete confirmation dialog never appeared.

**Root cause:** `window.confirm()` is blocked by iframe sandboxes.

**Fix:** All confirmations are inline UI — a "Delete this session?" row appears within the session card with Yes/No buttons. "Clear all" uses a double-tap pattern (tap once to prime, tap again within 3 seconds to confirm).

---

## Known limitations and future work

### Image size
Phone camera photos are 3-5MB each. A backup file with 5 sessions could be 15-25MB. Future options:
- Compress images before storing (canvas `toDataURL('image/jpeg', 0.7)`)
- Store images separately from session metadata
- Offer a "compact backup" option that strips images (metadata only)

### Icons
`icon-192.png` and `icon-512.png` are solid dark squares generated by a Python script. They display correctly but are not visually distinctive. Replace with a proper crosshair/target SVG rendered to PNG for a polished home screen icon.

### Offline font
The Tabler icon font loads from CDN. If the CDN is unreachable and the service worker hasn't cached it yet (first visit, offline), icons will be invisible. Solution: bundle the font locally or add explicit CDN caching to the service worker install step.

### Session image size warning
No warning is shown when a session image is very large. Could add a toast if `file.size > 5MB` suggesting the user crop or reduce resolution before loading.

### Potential future features (from development conversation)
- Per-load comparison view (overlay groups from different loads side by side)
- Velocity correlation (import chrono CSV and correlate SD/ES with group stats)
- MOA/MRAD unit toggle (currently inches only)
- Multiple POA support per target (for multi-group targets)
- Zoom/pan on the target canvas for precise marker placement on small groups
- Share sheet integration (share composite image directly from app)
- More calibration helpers (click-to-measure known ring diameter, automatic grid detection)

---

## Tech stack

| Layer | Choice | Reason |
|-------|--------|--------|
| Language | Vanilla JS (ES5-compatible) | No build step, works in all browsers, easy to maintain |
| Styling | Plain CSS with custom properties | Dark mode via `prefers-color-scheme`, no framework dependency |
| Icons | Tabler Icons webfont (CDN) | 5800+ outline icons, consistent style, small footprint |
| Storage | IndexedDB + localStorage | IndexedDB for sessions (large binary data), localStorage for settings |
| Canvas | HTML5 Canvas 2D | Direct pixel control, works identically across platforms |
| PWA | Service Worker + Web App Manifest | Offline support, home screen install, no App Store |
| Hosting | GitHub Pages via GitHub Actions | Free, HTTPS, auto-deploy on push, permanent URL |

No npm dependencies in production. No React, no Vue, no build pipeline. The entire app is 8 files totaling ~24KB compressed.

---

## Deployment

Live URL: `https://TimFiez.github.io/shot-tracker/`

Deploy is automatic: push to `main` → GitHub Actions runs `.github/workflows/deploy.yml` → GitHub Pages serves the updated site within ~60 seconds.

To deploy manually from a new machine:
```bash
git clone https://github.com/TimFiez/shot-tracker.git
cd shot-tracker
# make changes
git add . && git commit -m "description" && git push
```

---

*Last updated: May 2026. Built in collaboration with Claude (Anthropic).*
---

## Data model v2 (Session + Targets)

Restructured May 2026 based on real-world workflow feedback.

### Old model (v1)
Each 'session' was one image with one calibration, POA, and N shots. Users had to re-enter name/distance/notes for every target photo.

### New model (v2)
- **Session** = one range trip or load being tested (name, distance, notes, date)
- **Target** = one image within a session (label, imgSrc, imgW, imgH, pxPerInch, poa, shots[])
- One session has one to many targets
- Composite view shows all shots across all targets in a session, color-coded by target

### Key decisions
- **Calibration is per target** — every image gets its own pxPerInch because phone photos are taken at variable distances from the target. No "copy cal from previous" option (kept simple until user demand justifies complexity).
- **Target label defaults to image filename** — sensible default, user can override before saving.
- **Session is created first** — load image button is gated behind having an active session. Prevents orphaned images.
- **Save/New session buttons** moved above the image loading section per user feedback.
- **Active session shown as a highlighted card** in the sidebar. Active target highlighted within it.
- **DB version bumped to 2** — migration code wraps old v1 sessions into the new structure (best-effort; old flat sessions become sessions with no targets).

### Backup file version
- v1 (old): flat session with imgSrc, poa, shots at top level
- v2 (old): same flat structure
- v3 (new): sessions[] with targets[] nested within each session
