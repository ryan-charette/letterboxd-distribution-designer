import { updateGlicko, expectedGlickoScore } from './glicko.js';

const POOL_SIZE = 12;
const ANCHOR_POOL_SIZE = 8;
const LOOKAHEAD_LIMIT = 16;
const EXTRA_STANDARDIZED_GAP = 0.05;
const MATERIAL_PROGRESS_GAIN = 0.25;
const pairKey = (a, b) => [a, b].sort().join('::');
const ratingOrder = (a, b) => b.glicko - a.glicko || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);

function insertPool(pool, film, score, limit) {
  const at = pool.findIndex(item => score < item.score);
  if (at < 0) {
    if (pool.length < limit) pool.push({ film, score });
  } else {
    pool.splice(at, 0, { film, score });
    if (pool.length > limit) pool.pop();
  }
}

function outcomeOrder(sorted, a, b) {
  const order = sorted.filter(film => film.id !== a.id && film.id !== b.id);
  for (const film of [a, b]) {
    let low = 0;
    let high = order.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (ratingOrder(film, order[mid]) < 0) high = mid;
      else low = mid + 1;
    }
    order.splice(low, 0, film);
  }
  return order;
}

// Cheap shortlist followed by two-outcome lookahead. Only the changed films
// are reinserted; the full library is never re-sorted for each candidate.
export function selectProgressPair(sorted, boundary, history, { multiplier, focusIds, scoreOrder }) {
  const cut = (sorted[boundary - 1].glicko + sorted[boundary].glicko) / 2;
  const nearLeft = [];
  const nearRight = [];
  const anchors = [];
  const targets = [];
  sorted.forEach((film, index) => {
    const distance = Math.abs(film.glicko - cut);
    insertPool(index < boundary ? nearLeft : nearRight, film, distance / film.rd, POOL_SIZE);
    insertPool(anchors, film, distance / 200 + film.rd / 100, ANCHOR_POOL_SIZE);
    if (focusIds.has(film.id)) insertPool(targets, film, distance / film.rd, POOL_SIZE);
  });

  const skipped = new Map();
  for (const match of history) {
    if (!match.skipped) continue;
    const key = pairKey(match.aId, match.bId);
    skipped.set(key, (skipped.get(key) || 0) + 1);
  }
  const candidates = new Map();
  const leftIds = new Set(sorted.slice(0, boundary).map(film => film.id));
  const borderIds = [sorted[boundary - 1].id, sorted[boundary].id];

  function add(a, b) {
    if (a.id === b.id) return;
    const cross = leftIds.has(a.id) !== leftIds.has(b.id);
    // Same-side matches are useful only as calibration: an uncertain border
    // film facing an anchor with at most half its RD. Avoid sorting interiors.
    if (!cross) {
      const isAnchorPair = (borderIds.includes(a.id) && a.rd >= 2 * b.rd) ||
        (borderIds.includes(b.id) && b.rd >= 2 * a.rd);
      if (!isAnchorPair) return;
    }
    const key = pairKey(a.id, b.id);
    if (candidates.has(key)) return;
    const gap = Math.abs(a.glicko - b.glicko) / Math.hypot(a.rd, b.rd);
    const p = expectedGlickoScore(a, b);
    const aWin = { ...a, ...updateGlicko(a, [{ opponent: b, score: 1 }]) };
    const bLose = { ...b, ...updateGlicko(b, [{ opponent: a, score: 0 }]) };
    const aLose = { ...a, ...updateGlicko(a, [{ opponent: b, score: 0 }]) };
    const bWin = { ...b, ...updateGlicko(b, [{ opponent: a, score: 1 }]) };
    const clarity = film => Math.min(1, Math.abs(film.glicko - cut) / (multiplier * film.rd));
    const quickGain = p * (clarity(aWin) + clarity(bLose)) +
      (1 - p) * (clarity(aLose) + clarity(bWin)) - clarity(a) - clarity(b);
    const relevance = film => Math.exp(-0.5 * ((film.glicko - cut) / film.rd) ** 2);
    const rdGain = p * ((1 - aWin.rd / a.rd) * relevance(a) + (1 - bLose.rd / b.rd) * relevance(b)) +
      (1 - p) * ((1 - aLose.rd / a.rd) * relevance(a) + (1 - bWin.rd / b.rd) * relevance(b));
    const anchorBonus = Math.abs(a.rd - b.rd) / Math.max(a.rd, b.rd) / (1 + Math.min(a.rd, b.rd) / 100);
    const penalty = (skipped.get(key) || 0) * 0.15;
    candidates.set(key, {
      a, b, gap, cross, p, aWin, bLose, aLose, bWin, rdGain, anchorBonus, penalty,
      quickScore: Math.max(0, quickGain) + rdGain + 0.01 * anchorBonus - penalty,
    });
  }

  for (const { film: a } of nearLeft) for (const { film: b } of nearRight) add(a, b);
  const opponents = [...nearLeft, ...nearRight, ...anchors];
  for (const { film: a } of targets) for (const { film: b } of opponents) add(a, b);
  const crossPairs = [...candidates.values()].filter(pair => pair.cross).sort((a, b) => a.gap - b.gap);
  const nearest = crossPairs[0];
  const closestGap = nearest?.gap ?? Infinity;
  // Conservative locality guard: do not chase distant pairs for speculative
  // short-term gains. Always retain the closest cross-cut comparison.
  const shortlist = [...candidates.values()]
    .filter(pair => pair.gap <= closestGap + EXTRA_STANDARDIZED_GAP)
    .sort((a, b) => b.quickScore - a.quickScore)
    .slice(0, LOOKAHEAD_LIMIT);
  if (nearest && !shortlist.includes(nearest)) {
    if (shortlist.length === LOOKAHEAD_LIMIT) shortlist.pop();
    shortlist.push(nearest);
  }

  const current = scoreOrder(sorted);
  const evaluations = shortlist.map(candidate => {
    const { aWin, bLose, aLose, bWin, p } = candidate;
    const win = scoreOrder(outcomeOrder(sorted, aWin, bLose));
    const lose = scoreOrder(outcomeOrder(sorted, aLose, bWin));
    const expectedSettled = p * win.settled + (1 - p) * lose.settled;
    const expectedClarity = p * win.clarity + (1 - p) * lose.clarity;
    // Reward interval clearance and reduction in normalized overlap. Glicko
    // information gain and anchor reliability provide small tie-breakers.
    const expectedProgress = 0.25 * (expectedSettled - current.settled) + expectedClarity - current.clarity;
    return {
      ...candidate, expectedProgress, expectedSettled,
      score: expectedProgress + 0.01 * candidate.rdGain + 0.01 * candidate.anchorBonus - candidate.penalty,
    };
  });
  const reference = evaluations.find(pair => pair.a.id === nearest?.a.id && pair.b.id === nearest?.b.id);
  let best = null;
  for (const candidate of evaluations) {
    if (!candidate.cross && reference && candidate.expectedProgress < reference.expectedProgress + 0.05) continue;
    if (!best || candidate.score > best.score) best = candidate;
  }
  // Require material evidence before deviating from a useful local pair.
  // If no preview predicts progress, keep probing the cutoff rather than
  // selecting unrelated zero-gain comparisons indefinitely.
  if (best && reference && reference.penalty === 0 && best.score < reference.score + MATERIAL_PROGRESS_GAIN) best = reference;
  if (best && best.expectedProgress <= 0 && reference && reference.penalty === 0) best = reference;

  const pair = best ? { left: best.a, right: best.b } : null;
  return {
    nextPair: pair && history.length % 2 ? { left: pair.right, right: pair.left } : pair,
    candidateCount: candidates.size,
    lookaheadCount: shortlist.length,
    expectedProgress: best?.expectedProgress ?? 0,
    expectedSettled: best?.expectedSettled ?? current.settled,
  };
}
