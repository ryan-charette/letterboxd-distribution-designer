# Letterboxd Distribution Designer

Shape a target rating curve, import your Letterboxd CSV, answer comparisons, and export a probabilistic ranking at any time. The app gives favorites extra attention while maintaining broad coverage of the library.

Everything runs in your browser. CSV data, answers, and preferences remain local. This project is independently made and is not affiliated with Letterboxd.

## Quick start

Download the repository ZIP, unzip it, and open `letterboxd-distribution-designer.html`. No server or installation is required. The standalone file is rebuilt from the source.

1. Shape the target curve and select whole-star or half-star bins.
2. Upload `ratings.csv`, `watched.csv`, or `diary.csv`. Imported ratings provide useful prior information when available; `ratings.csv` is the recommended source for the time-budget goal.
3. Choose a time budget and target model tier accuracy.
4. Pick the film you prefer. Left/right arrow keys also work. Use Undo for accidental picks or Skip when you cannot decide.
5. Export whenever the ranking is useful. Reaching the time budget makes results available without claiming that the accuracy target was reached.

## A ranking that can stop early

The 1,200–3,600-answer quality goal is intended for an **imported, pre-seeded library**. Unseeded benchmarking is a separate stress test with a different expectation.

The default budget is **60 minutes = 1,200 answered comparisons**, assuming three seconds per answer. The slider allows 5–180 minutes, up to **3,600 answers**. Pauses and skipped questions are outside this estimate. Increase the budget to continue an existing session.

The quality target defaults to 90%. For each film, the app estimates the probability that it belongs in its currently assigned tier. Summing `1 - probability` gives the **expected number of misplaced films under the model**. The quality target is reached when average tier accuracy and average top-four membership probability both meet the target. The session stops when either the quality target or the time budget is reached. These are reported as different outcomes.

Unlike a strict interval-containment rule, this allows some uncertainty to remain. The budget controls effort; achievable accuracy depends on imported ratings, answer consistency, and how similar the films are. A target is an aspiration, not a promise of real-world accuracy. Without imported ratings, 1,200–3,600 answers generally support a much coarser global ranking than they do with informative priors.

Results include a point rank, expected rank, model rank range (5th–95th percentiles), probabilities for every tier, and top-four membership probability. The four favorites are ordered by estimated preference; the stopping target concerns their membership, not certainty in their exact internal order. All probabilities remain provisional and can change with later evidence.

## Imperfect answers and the preference model

The model is an approximate Bayesian Bradley–Terry model with a lapse mixture, rather than a generic deterministic sorter. An answer never creates a hard ordering constraint. Cycles and upsets remain valid evidence, and later comparisons can repair earlier mistakes.

For latent preference scores `a` and `b`, the likelihood is `0.05 + 0.9 * sigmoid((a-b)/0.5)`. The lapse mixture leaves a 5% probability for an upset even at extreme score differences. Near-equal films are substantially harder to distinguish. This is an application modeling assumption, not an empirically fitted estimate of an individual user's error rate.

Imported ratings seed a normal prior with mean `(stars - 3) * 1.5` and standard deviation 0.4. Unseeded films start at mean zero and standard deviation 1.5. Each answer performs a soft Gaussian moment update. Every 25 answers, a global regularized fit revisits the comparison graph from the fixed priors, followed by a diagonal uncertainty approximation. Repeated pair evidence has weight proportional to the square root of the number of answers, so repeatedly clicking the same preference cannot manufacture unlimited independent evidence. Variance is floored at 0.025; the diagonal precision estimate is inflated by 1.25 and capped at the prior variance.

The posterior approximation ignores correlations and uses fixed noise/prior assumptions. Its probabilities are **model estimates, not calibrated guarantees**. The app samples 64 approximate posterior score orders, fills the target quotas in each, and estimates tier probabilities and rank ranges. Common random numbers make unchanged state reproducible. Changing the curve reuses the sampled orders instead of sorting the library again for every pointer movement.

Pair selection normally allocates 50% of turns to favorites/top-four uncertainty, 30% to important tier boundaries, and 20% to neglected films. Optimistic score estimates keep uncertain favorites eligible. During an unseeded cold start, half the turns go to coverage until every film has been considered. Opponents are chosen near the target's score using expected information and decision relevance, with a modest preference for reliable anchors and strong penalties for repeated/recent pairs. This is a practical acquisition heuristic, not a theorem of optimal sample efficiency.

Background: [active top-K ranking with noisy comparisons](https://proceedings.mlr.press/v70/mohajer17a.html). This implementation is an application-specific approximate model and does not inherit that paper's recovery guarantees.

## Color sources

The primary accents are extracted directly from the SVG linked on [Letterboxd's official brand page](https://letterboxd.com/about/brand/):

| Color | Hex |
|---|---|
| Green | `#00E054` |
| Orange | `#FF8000` |
| Blue | `#40BCF4` |

Source asset: [official dots artwork](https://a.ltrbxd.com/logos/letterboxd-decal-dots-neg-rgb.svg). The brand page supplies artwork rather than a separate published hex table. Dark backgrounds `#14181C`, `#202830`, and `#2C3440`, and the slate text palette were verified against Letterboxd's [website stylesheet](https://s.ltrbxd.com/static/css/main-C1fpK60s.css). Additional accent tints are derived interface states, not claimed official brand specifications. The app keeps its own curve favicon and independent-project notice.

## Data, migration, and export

Common title, year, rating, date, and Letterboxd URI columns are supported. Duplicate films are deduplicated by URI when available, otherwise title and year. Rating quotas use largest-remainder rounding and always add up to the film count.

Earlier Elo/Glicko sessions migrate by replaying the recorded answers into the new model. No older rating deviations are misrepresented as new posterior uncertainty. The previous saved keys remain available. The new session uses schema version 3 and separate quality/budget preferences; the old interval-confidence percentage is not silently interpreted as a new quality target.

Undo rebuilds the most recent global-fit prefix and replays the remaining answers, restoring the posterior without replaying every prior global fit. Original per-film priors remain fixed even if the import checkbox is later toggled. New saves are debounced and flushed when leaving the page.

CSV export always includes the complete library, even though the results table displays 100 films per page. Columns include the assigned rating, full tier-probability distribution, model rank range, expected rank, preference score and uncertainty, expected misplaced count, target and budget, match statistics, imported rating, and Letterboxd URI.

## Development and validation

Node.js 18+ and npm are required for source development.

```bash
npm install
npm run dev
npm test
npm run build:standalone
```

The tests cover contradictory answers, correction of early mistakes, repeat-evidence discounting, exact replay across global-refit boundaries, legacy migration, budget stops, exploration, posterior probability identities, full tier distributions, pagination, and rendered controls and palette values.

```bash
npm run benchmark
npm run benchmark:comparisons -- 1 seeded
npm run benchmark:comparisons -- 2 weak
npm run benchmark:comparisons -- 3 unseeded
```

The performance benchmark separates fresh-posterior computation from cached curve edits for 1,000 films. The comparison benchmark reports checkpoints at 0, 300, 1,200 and 3,600 answers, plus the supplied final checkpoint. An optional third argument limits answers, for example `npm run benchmark:comparisons -- 5 seeded 1200`.

Simulated users answer probabilistically: `0.05 + 0.9 * sigmoid(true score difference / 0.35)`. True scores, prior rating errors, and names are generated from independent seeded draws; names carry no ranking information. The seeded scenario corrupts 15% of imported ratings by half a star, the weak scenario corrupts 40% and adds occasional large errors, and the unseeded scenario supplies no rating priors. The benchmark reports exact tier accuracy, accuracy within half a star, exact top-four/top-20 membership overlap, model estimates, and coverage separately. These are development simulations, not real-user or calibrated coverage validation. Quality can fluctuate after noisy answers; additional comparisons do not guarantee that every metric improves monotonically.

See `docs/benchmark-results.md` for the measured checkpoints and limitations. Performance figures describe computation rather than browser frame rate. Visual browser verification remains separate from rendered-markup tests.

## License

MIT License. See `LICENSE`.
