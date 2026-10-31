export const CONFIDENCE_TARGET = 0.9;
const SAMPLE_COUNT = 1024;

// Uncertainty in a film's latent preference strength, in Elo points. These
// explicit modeling choices are estimates, not empirically calibrated odds.
export function eloDeviation(film) {
  return Math.max(25, 100 / Math.sqrt(1 + Math.max(0, film.games || 0) / 4));
}

function seedFor(id) {
  let seed = 2166136261;
  for (const ch of String(id)) seed = Math.imul(seed ^ ch.charCodeAt(0), 16777619);
  return seed >>> 0 || 1;
}
function randomSource(id) {
  let seed = seedFor(id);
  return () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return ((seed >>> 0) + 0.5) / 4294967296;
  };
}
const percent = (value) => Math.round(value * 1000) / 10;
const pairKey = (a, b) => [a, b].sort().join('::');

export function analyzeRanking(films, quotas, history = []) {
  const sorted = [...films].sort((a, b) => b.elo - a.elo || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  const assignments = new Map();
  const tiers = [];
  const tierAtRank = [];
  let cursor = 0;
  for (const bucket of quotas) {
    if (!bucket.quota) continue;
    const start = cursor;
    cursor += bucket.quota;
    const tierIndex = tiers.length;
    tiers.push({ ...bucket, start, end: cursor, hits: 0 });
    for (let i = start; i < cursor; i += 1) {
      tierAtRank[i] = tierIndex;
      assignments.set(sorted[i].id, { rating: bucket.rating, rank: i + 1, hits: 0, positionHits: 0 });
    }
  }
  const sources = sorted.map((film) => randomSource(film.id));
  const deviations = sorted.map(eloDeviation);
  const boundaryHits = new Array(sorted.length).fill(0);
  const prefixHits = new Array(Math.min(4, sorted.length)).fill(0);
  // Sample uncertain latent Elo strengths, then apply the exact target quotas.
  // A single sampled strength is reused across all tiers within a simulation.
  for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
    const order = sorted.map((film, index) => {
      const normal = Math.sqrt(-2 * Math.log(sources[index]())) * Math.cos(2 * Math.PI * sources[index]());
      return { index, strength: film.elo + normal * deviations[index] };
    }).sort((a, b) => b.strength - a.strength || a.index - b.index);
    const tierCorrect = tiers.map(() => true);
    let maxOriginalRank = -1;
    let prefixCorrect = true;
    for (let rank = 0; rank < order.length; rank += 1) {
      const originalIndex = order[rank].index;
      const assignment = assignments.get(sorted[originalIndex].id);
      if (tierAtRank[rank] === tierAtRank[originalIndex]) assignment.hits += 1;
      else tierCorrect[tierAtRank[rank]] = false;
      if (rank === originalIndex) assignment.positionHits += 1;
      maxOriginalRank = Math.max(maxOriginalRank, originalIndex);
      if (maxOriginalRank === rank) boundaryHits[rank] += 1;
      prefixCorrect = prefixCorrect && rank === originalIndex;
      if (rank < prefixHits.length && prefixCorrect) prefixHits[rank] += 1;
    }
    tierCorrect.forEach((correct, index) => { if (correct) tiers[index].hits += 1; });
  }
  let confidenceSum = 0;
  let confirmedCount = 0;
  for (const assignment of assignments.values()) {
    const probability = assignment.hits / SAMPLE_COUNT;
    assignment.confidence = percent(probability);
    assignment.positionConfidence = percent(assignment.positionHits / SAMPLE_COUNT);
    assignment.confirmed = probability >= CONFIDENCE_TARGET;
    confidenceSum += probability;
    if (assignment.confirmed) confirmedCount += 1;
    delete assignment.hits;
    delete assignment.positionHits;
  }
  for (const tier of tiers) {
    tier.probability = tier.hits / SAMPLE_COUNT;
    tier.confidence = percent(tier.probability);
    tier.finalized = tier.probability >= CONFIDENCE_TARGET;
    delete tier.hits;
  }
  const topFourProbability = prefixHits.length ? prefixHits[prefixHits.length - 1] / SAMPLE_COUNT : 1;
  const topFourFinal = topFourProbability >= CONFIDENCE_TARGET;
  const activeTier = tiers.find((tier) => !tier.finalized);
  let boundary;
  let stage = 'All tiers and the top four have reached 90% model confidence.';
  if (activeTier) {
    const cuts = [activeTier.start, activeTier.end].filter((cut) => cut > 0 && cut < sorted.length);
    boundary = cuts.sort((a, b) => boundaryHits[a - 1] - boundaryHits[b - 1])[0];
    stage = `Finalizing ${activeTier.rating}-star films: ${activeTier.confidence}% confidence in the entire tier (target 90%).`;
  } else if (!topFourFinal) {
    boundary = prefixHits.findIndex((hits) => hits / SAMPLE_COUNT < CONFIDENCE_TARGET) + 1;
    stage = `Refining your top four: ${percent(topFourProbability)}% confidence in the ordered list (target 90%).`;
  }
  let nextPair = null;
  if (boundary > 0 && boundary < sorted.length) {
    const skips = new Map();
    for (const match of history) if (match.skipped) {
      const key = pairKey(match.aId, match.bId);
      skips.set(key, (skips.get(key) || 0) + 1);
    }
    // Keep attention on this tier's cut. Distant low-rated films have an
    // exponentially smaller challenge score; they do not need individual proof.
    let bestScore = -Infinity;
    for (let i = 0; i < boundary; i += 1) {
      for (let j = boundary; j < sorted.length; j += 1) {
        const key = pairKey(sorted[i].id, sorted[j].id);
        const gap = (sorted[i].elo - sorted[j].elo) / Math.hypot(deviations[i], deviations[j]);
        const score = -gap * gap / 2 - (skips.get(key) || 0) * 2;
        if (score > bestScore) {
          bestScore = score;
          nextPair = { left: sorted[i], right: sorted[j] };
        }
      }
    }
    // Alternate sides without changing confidence or which films are selected.
    if (history.length % 2) nextPair = { left: nextPair.right, right: nextPair.left };
  }
  return {
    sorted, quotas, assignments, tiers, topFourFinal, topFourConfidence: percent(topFourProbability),
    confirmedCount, confidence: sorted.length ? percent(confidenceSum / sorted.length) : 0,
    nextPair, stage, activeTier, boundary,
  };
}
