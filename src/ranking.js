import { selectProgressPair } from "./pairing.js";
const percent = (value) => Math.round(value * 1000) / 10;
export const DEFAULT_CONFIDENCE = 95;
export function normalizeConfidence(value) {
  return Number.isFinite(value) ? Math.max(50, Math.min(99, value)) : DEFAULT_CONFIDENCE;
}
// Invert the normal CDF once per analysis, not once per film or candidate.
export function intervalMultiplier(confidenceLevel = DEFAULT_CONFIDENCE) {
  const probability = (1 + normalizeConfidence(confidenceLevel) / 100) / 2;
  let low = 0;
  let high = 4;
  for (let i = 0; i < 32; i += 1) {
    const mid = (low + high) / 2;
    if (normalCdf(mid) < probability) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

export function sortFilms(films) {
  return films.filter((film) => !film.removed).sort((a, b) => b.glicko - a.glicko || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}
// Normal approximation conditional on the current rating cutoffs. This is
// separate from the user's interval-containment rule for settling a film.
export function normalCdf(x) {
  if (!Number.isFinite(x)) return x > 0 ? 1 : 0;
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const tail = Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI) * t *
    (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - tail : tail;
}
function cutAt(sorted, rank) {
  if (rank === 0) return Infinity;
  if (rank === sorted.length) return -Infinity;
  return (sorted[rank - 1].glicko + sorted[rank].glicko) / 2;
}
function within(film, lower, upper, multiplier) {
  // Touching a cut remains unsettled, especially when ratings are tied.
  return film.glicko - multiplier * film.rd > lower && film.glicko + multiplier * film.rd < upper;
}

// Curve edits reuse the memoized rating order through the presorted option.
export function analyzeRanking(films, quotas, history = [], { presorted = false, confidenceLevel = DEFAULT_CONFIDENCE } = {}) {
  confidenceLevel = normalizeConfidence(confidenceLevel);
  const multiplier = intervalMultiplier(confidenceLevel);
  const sorted = presorted ? films : sortFilms(films);
  const assignments = new Map();
  const tiers = [];
  let cursor = 0;
  let confirmedCount = 0;
  let probabilitySum = 0;
  for (const bucket of quotas) {
    if (!bucket.quota) continue;
    const start = cursor;
    cursor += bucket.quota;
    const lower = cutAt(sorted, cursor);
    const upper = cutAt(sorted, start);
    let settledCount = 0;
    for (let i = start; i < cursor; i += 1) {
      const film = sorted[i];
      const confirmed = within(film, lower, upper, multiplier);
      const probability = normalCdf((upper - film.glicko) / film.rd) - normalCdf((lower - film.glicko) / film.rd);
      if (confirmed) { confirmedCount += 1; settledCount += 1; }
      probabilitySum += probability;
      assignments.set(film.id, {
        rating: bucket.rating, rank: i + 1, confirmed, confidence: percent(probability), lower, upper,
        intervalLower: film.glicko - multiplier * film.rd, intervalUpper: film.glicko + multiplier * film.rd,
        positionConfirmed: within(film, cutAt(sorted, i + 1), cutAt(sorted, i), multiplier),
      });
    }
    tiers.push({ ...bucket, start, end: cursor, lower, upper, settledCount,
      progress: percent(settledCount / bucket.quota), finalized: settledCount === bucket.quota });
  }
  const top = sorted.slice(0, 4);
  const topFourSettledCount = top.filter((film) => assignments.get(film.id).positionConfirmed).length;
  const topFourFinal = topFourSettledCount === top.length;
  const activeTier = tiers.find((tier) => !tier.finalized);
  let boundary;
  let stage = 'All tier intervals and top-four positions are settled.';
  if (activeTier) {
    let worstMargin = Infinity;
    for (let i = activeTier.start; i < activeTier.end; i += 1) {
      const film = sorted[i];
      if (assignments.get(film.id).confirmed) continue;
      for (const [cut, margin] of [[activeTier.start, (activeTier.upper - film.glicko) / film.rd], [activeTier.end, (film.glicko - activeTier.lower) / film.rd]]) {
        if (cut > 0 && cut < sorted.length && margin < worstMargin) { boundary = cut; worstMargin = margin; }
      }
    }
    stage = `Settling ${activeTier.rating}-star films: ${activeTier.settledCount} of ${activeTier.quota} ${confidenceLevel}% intervals fit inside the tier.`;
  } else if (!topFourFinal) {
    const index = top.findIndex((film) => !assignments.get(film.id).positionConfirmed);
    const film = sorted[index];
    boundary = index > 0 && cutAt(sorted, index) - film.glicko < film.glicko - cutAt(sorted, index + 1) ? index : index + 1;
    stage = `Refining your top four: ${topFourSettledCount} of ${top.length} positions settled using ${confidenceLevel}% intervals.`;
  }
  let selection = { nextPair: null, candidateCount: 0, lookaheadCount: 0, expectedProgress: 0 };
  if (boundary > 0 && boundary < sorted.length) {
    const scoreOrder = order => {
      const cut = cutAt(order, boundary);
      const a = order[boundary - 1];
      const b = order[boundary];
      const leftMargin = (a.glicko - cut) / (multiplier * a.rd);
      const rightMargin = (cut - b.glicko) / (multiplier * b.rd);
      const settled = Number(leftMargin > 1) + Number(rightMargin > 1);
      const clarity = Math.min(1, leftMargin) + Math.min(1, rightMargin);
      return { settled, clarity };
    };
    const cut = cutAt(sorted, boundary);
    selection = selectProgressPair(sorted, boundary, history, {
      multiplier, scoreOrder,
      focusIds: new Set(sorted.filter(film => Math.abs(film.glicko - cut) <= multiplier * film.rd).map(film => film.id)),
    });
  }
  return { sorted, quotas, assignments, tiers, topFourFinal, topFourSettledCount, topFourCount: top.length,
    confirmedCount, confidence: sorted.length ? percent(probabilitySum / sorted.length) : 0,
    ...selection, stage, activeTier, boundary, confidenceLevel, multiplier };
}
