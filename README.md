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
- Identify the ordered top four at 90% model confidence, even when several favorites share a tier
- Track Elo-based tier probabilities and advance at 90% confidence
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
5. Follow the current tier until its membership reaches 90% model confidence, then move down the scale. Zero-quota tiers are skipped.
6. Once the tiers are finalized, finish any comparisons needed to order your top four.
7. Export the updated ratings CSV, including per-film tier probabilities, top-four positions, and overall estimated tier accuracy.

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

Films are ordered by Elo and assigned to the target rating quotas. Imported ratings can seed the initial Elo order. Each answer updates both films' Elo and match counts. Contradictory or changing preferences are treated as new Elo evidence rather than hard logical constraints.

The app works from the highest nonempty tier downward. A tier is finalized when the model estimates at least a **90% probability that its entire membership is correct**. Pair selection focuses on plausible challengers across that tier's least-confident cutoff, favoring small Elo gaps relative to uncertainty. Very low-rated films do not require individual comparisons against favorites. Once the tiers reach the target, the app resolves the ordered top four to the same 90% threshold (or all films if fewer than four were imported).

Finalized means sufficiently confident, not permanently locked. Confidence is recomputed as Elo changes, so an earlier tier can reopen after an upset, an undo, or a curve edit. Skips add no Elo evidence and favor another pair at the same cutoff. If only one comparison remains useful, it may reappear.

### What confidence means

The app draws 1,024 simulated preference orders from independent normal distributions centered at each film's current Elo. A film's standard deviation in Elo points is `max(25, 100 / sqrt(1 + matches / 4))`: new films have wider uncertainty, and comparisons narrow it. Imported Elo is used as an initial belief, so already-separated favorites and low-rated films need not be tested exhaustively. Disabling imported-rating seeding starts all films equally.

Each simulated order fills the same target quotas. A film's tier confidence is the fraction of simulations placing it in its currently assigned tier. **Overall estimated tier accuracy** averages these probabilities: it estimates the chance that a uniformly selected film is in its true tier. A tier's confidence instead counts simulations where its *entire set* of films is correct. Top-four confidence counts simulations matching the *entire ordered top-four list*. These different quantities are labeled separately in the interface and CSV export.

These are approximate model probabilities, not guarantees or empirically calibrated claims about a user's taste. The uncertainty formula is a modeling assumption, and simulation adds sampling error (roughly one percentage point near 90%). Sampling is deterministic for the same film IDs, Elo, and match counts, so skipping, reloading, or rearranging import rows does not itself increase confidence. All films participate in the simulations, including distant challengers, even though pair selection concentrates on plausible upsets.

### Validation

```bash
npm test
```

Tests check simulated probabilities against a two-film analytic reference, tier-level versus per-film confidence, descending tier priority, distant-challenger avoidance, skips, changing preferences, curve edits, and top-four confidence.

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

`src/ranking.js` contains the Elo uncertainty model, tier probabilities, and pair selection. `tests/ranking.test.mjs` validates the ranking behavior.

## License

MIT License. See `LICENSE` for details.
