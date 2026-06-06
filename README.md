# Shot Tracker

A progressive web app for precision rifle target analysis. Photograph targets, calibrate scale, mark impacts, and analyze group statistics — works on iPhone, iPad, Mac, and Android.

## Features

- **Calibrated measurements** — click two known reference points (1" grid squares) to set real-world scale
- **Sequential workflow** — Calibrate → Set POA → Add shots → Save, driven by a step bar
- **Group statistics** — Mean radius, R95 (MR×2.1 per PrecisionRifleBlog), extreme spread, H/V POA offset
- **R95 circle** overlaid on target photo and composite view
- **Edit mode** — drag markers to correct placement
- **Multi-session composite** — overlay all sessions normalized to POA
- **Save backup** — creates a file you can store in iCloud Drive (syncs across all Apple devices)
- **Export spreadsheet** — CSV with per-shot H/V offsets from POA and centroid
- **Export composite image** — PNG of the composite group view
- **Works offline** — service worker caches the app for use at the range with no signal
- **Add to home screen** — install as a PWA on iPhone, iPad, Android, or Mac

## Deploy to GitHub Pages

1. Fork or clone this repo to your GitHub account
2. Go to **Settings → Pages**
3. Set **Source** to **GitHub Actions**
4. Push to `main` — the workflow deploys automatically
5. Your app is live at `https://TimFiez.github.io/shot-tracker/`

## iCloud sync workflow

On iPhone/iPad:
1. After marking shots, tap **Save session** in the drawer
2. Tap **Save backup** — iOS will ask where to save the file
3. Choose **iCloud Drive → Shot Tracker** (create the folder once)
4. On your Mac, open the same file from `~/Library/Mobile Documents/` or the Files app
5. Load backup in the desktop app to continue analysis

## Local development

No build step required — it's plain HTML, CSS, and JavaScript.

```bash
# Serve locally (required for service worker)
python3 -m http.server 8080
# then open http://localhost:8080
```

## Statistics method

Group precision is calculated from the **group centroid**, not the POA:

1. Find centroid = mean X, mean Y of all impacts
2. Mean Radius = average distance from each shot to centroid
3. R95 = Mean Radius × 2.1 (95th percentile radius estimate)
4. Extreme Spread = maximum shot-to-shot distance (CTC)
5. POA offset = centroid position relative to aim point (your zero error)

Method sourced from [PrecisionRifleBlog — Statistics for Shooters Part 3](https://precisionrifleblog.com/2020/12/12/measuring-group-size-statistics-for-shooters/).
