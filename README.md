# Letterboxd Distribution Designer

Design a target Letterboxd rating curve, upload a Letterboxd CSV export, compare films head-to-head, and export updated ratings based on your comparison results.

The app combines two workflows:

- A curve designer for shaping the rating distribution you want
- A tier-by-tier comparison sorter for deciding which films belong in each rating band

Everything runs in the browser. Uploaded CSV data is parsed locally and session state is saved in local storage.

> This project is independently made and is not affiliated with Letterboxd.

## Features

- Drag curve control points to design a target ratings distribution
- Use normal, left-skewed, right-skewed, and bimodal presets
- Toggle whole-star or half-star rating bins
- Preview how the curve maps to rating quotas
- Upload Letterboxd `watched.csv`, `ratings.csv`, or `diary.csv`
- Optionally seed Elo from imported ratings when the CSV includes ratings
- Pick preferred films in head-to-head comparisons
- Finalize rating tiers from five stars downward before moving to the next tier
- Determine the exact ordered top four, even when several favorites share a tier
- Track confirmed tier placements and a conservative confidence bound
- Export a CSV with rank, assigned rating, Elo, matches, wins, losses, imported rating, and Letterboxd URI

## Demo

![Letterboxd Distribution Designer demo](./public/demo.gif)

## Run Without Installing

You can run the app directly from the downloaded project zip.

1. Click **Code** > **Download ZIP** on GitHub.
2. Unzip the download.
3. Open `letterboxd-distribution-designer.html` in your browser.

No Node.js install, terminal commands, or web server are required for normal use.

## Developer Setup

### Prerequisites

- Node.js 18+
- npm

### Install

```bash
npm install
```

### Run Locally

```bash
npm run dev
```

Then open the local URL printed in your terminal.

### Build

```bash
npm run build
```

### Build The Clickable HTML

```bash
npm run build:standalone
```

This regenerates `letterboxd-distribution-designer.html` from the production Vite bundle. Run it after source changes that should be included in the downloadable zip experience.

### Preview Production Build

```bash
npm run preview
```

## How To Use

1. Shape the target ratings curve with the preset buttons and draggable curve points.
2. Keep half-star ratings enabled for the classic 0.5 to 5.0 Letterboxd scale, or disable them for whole-star ratings.
3. Upload a Letterboxd CSV export.
4. Choose the film you prefer in each head-to-head pair. You can also use the left and right arrow keys.
5. Follow the current tier until its membership is confirmed, then move down the scale. Zero-quota tiers are skipped.
6. Once the tiers are finalized, finish any comparisons needed to order your top four.
7. Export the updated ratings CSV, including provisional/confirmed status, top-four positions, and the tier-confidence lower bound.

## Supported CSV Columns

The importer looks for common Letterboxd-style columns. It is intentionally flexible about column names.

- Title: `Name`, `Title`, `Film`, or `Movie`
- Year: `Year` or `Release Year`
- Link: `Letterboxd URI`, `URI`, `URL`, or `Link`
- Watched date: `Watched Date` or `Date`
- Rating: `Rating`, `Stars`, or `Score`

Rows without a recognizable title are skipped. Duplicate films are deduped by URI when available, otherwise by title and year.

## How Ratings Are Assigned

The curve is sampled into rating-bin probabilities. Those probabilities become quotas for the current film count using largest-remainder rounding, so the assigned counts still add up to the number of imported films.

Each answer establishes a preference constraint: the winner ranks ahead of the loser. The app also uses transitivity (if A beats B and B beats C, A ranks ahead of C). Provisional results respect these constraints; Elo and title break ties where your answers do not yet determine an order. Imported ratings seed Elo, but do not count as evidence of a confirmed placement.

Comparisons focus exclusively on the earliest unfinished rating tier, starting with the highest nonempty quota. Every film remains eligible to challenge that tier until comparison evidence rules it out. A tier is finalized only when its entire membership is the same in every ranking consistent with your answers. Further comparisons cannot change finalized tiers unless you undo an answer or change the target curve. The app then works down the remaining tiers and finally resolves any undetermined positions in the ordered top four (or all films when fewer than four are imported).

### What confidence means

For each film, the app calculates its best and worst possible rank across all orders consistent with your comparisons. A film's tier is confirmed when both limits fall inside its assigned quota. The confidence display is the percentage of imported films with confirmed tiers, rounded down to one decimal place.

This is a **lower bound**: a uniformly selected film has at least this chance of being assigned its true tier, assuming your answers reflect consistent, transitive preferences and the chosen target distribution. Unresolved films count as zero even though some may already be correctly placed. It is not a calibrated probability estimate and does not model mistaken or changing answers. Tier confidence can reach 100% before the top-four order is finalized, because ordering films within a tier does not affect their ratings.

Skipping a pair adds no preference evidence; it favors another eligible pair within the same tier. If only one comparison remains, it will reappear. Undo removes the last answer or skip. Curve edits recompute quotas and confirmation from the saved evidence. Older sessions with contradictory answers show a warning and withhold confidence; undo the contradictory answers or reupload the CSV to restart.

### Validation

```bash
npm test
```

Tests cover convergence to known preferences, descending tier priority, finalized-tier stability, exact top-four order, skips, undo, quota changes, and conflicting saved history. An exhaustive small-set test checks rank bounds and the confidence lower bound against every compatible true ordering.

## Data And Persistence

- CSV parsing happens in the browser.
- Imported films, curve settings, and match history are saved in local storage.
- Use the app's clear/reset controls, or clear site data in your browser, to remove saved state.
- Exported results are downloaded as `letterboxd-updated-ratings.csv`.

## Project Structure

```txt
letterboxd-distribution-designer/
|-- public/
|   |-- demo.gif
|   `-- favicon.svg
|-- scripts/
|   `-- build-standalone.mjs
|-- src/
|   |-- App.jsx
|   |-- index.css
|   `-- main.jsx
|-- index.html
|-- letterboxd-distribution-designer.html
|-- package.json
|-- postcss.config.js
|-- README.md
|-- tailwind.config.js
`-- vite.config.js
```

`src/ranking.js` contains the comparison constraints, tier confirmation, confidence bound, and pair selection. `tests/ranking.test.mjs` validates the ranking behavior.

## License

MIT License. See `LICENSE` for details.
