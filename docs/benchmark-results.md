# Noisy-user, pre-seeded acceptance benchmarks

The 1,200–3,600-answer goal applies to imported/pre-seeded libraries. These are reproducible development simulations of 1,000 films with ten half-star tiers, not real-user calibration or guarantees.

## Pre-seeded libraries (primary case)

15% of imported ratings are perturbed by half a star. Answers are random draws from a smooth preference model with a 5% upset floor, so near-ties are genuinely difficult. Movie names are independently shuffled. The implementation uses seeded prior SD 0.4, noise temperature 0.5, 64 posterior samples, and a global refit every 25 answers.

| Seed | Answers | Assumed answer time | Exact tier accuracy | Within half a star | True top-four overlap | True top-20 overlap | Model tier accuracy |
|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | 0 | 0 min | 82.8% | 99.8% | 0/4 | 12/20 | 65.9% |
| 1 | 300 | 15 min | 84.0% | 100% | 3/4 | 14/20 | 67.3% |
| 1 | 1,200 | 60 min | 85.6% | 100% | 3/4 | 16/20 | 68.1% |
| 5 | 0 | 0 min | 80.4% | 100% | 0/4 | 13/20 | 64.8% |
| 5 | 300 | 15 min | 82.4% | 100% | 2/4 | 14/20 | 66.3% |
| 5 | 1,200 | 60 min | 85.4% | 100% | 2/4 | 16/20 | 67.5% |
| 5 | 3,600 | 180 min | 88.4% | 100% | 2/4 | 18/20 | 70.5% |

The one-hour results improved favorite discovery and tier assignments over the imported order. The three-hour case improved exact tiers and top-20 membership further. Exact top-four recovery was not achieved in every case: some favorites are near-indistinguishable under the noisy oracle. The app therefore exposes their probabilities and alternatives rather than certifying four names or a strict order.

Model probabilities were conservative for tier accuracy in these cases and were not uniformly calibrated for top-four membership. The quality goal was not reached; the budget stop is a separate condition. These few development seeds do not establish average real-world performance, monotonic improvement, nominal interval coverage, or a guarantee of 90% accuracy within the budget.

Reproduce:

```bash
npm run benchmark:comparisons -- 1 seeded 1200
npm run benchmark:comparisons -- 5 seeded
```

## Unseeded library (separate stress test)

This case has no rating priors and is outside the imported-list acceptance goal. Seed 3 used the same final model and answer noise; the seeded-prior SD parameter has no effect on this case.

| Answers | Exact tier accuracy | Within half a star | True top-four overlap | True top-20 overlap |
|---|---:|---:|---:|---:|
| 0 | 18.1% | 48.3% | 0/4 | 0/20 |
| 300 | 18.7% | 54.9% | 0/4 | 0/20 |
| 1,200 | 30.3% | 73.6% | 2/4 | 8/20 |
| 3,600 | 49.9% | 92.1% | 3/4 | 17/20 |

Reproduce with `npm run benchmark:comparisons -- 3 unseeded`. The `weak` scenario separately tests substantially worse imported priors; it is not combined with the primary seeded results.

## Computation

`npm run benchmark` separates a fresh posterior from curve edits that reuse sampled score orders. A local run for 1,000 films measured about 28 ms median for a fresh posterior and 11 ms for a cached curve edit. These are Node computation timings, not measured browser frame rate or total UI latency. Results display 100 films per page; exports include all films.
