const percent = (value) => Math.round(value * 1000) / 10;
const pairKey = (a, b) => [a, b].sort().join('::');
const POOL_SIZE = 12;

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
function within(film, lower, upper) {
  // Touching a cut remains unsettled, especially when ratings are tied.
  return film.glicko - film.rd > lower && film.glicko + film.rd < upper;
}

// Curve edits reuse the memoized rating order through the presorted option.
export function analyzeRanking(films, quotas, history = [], { presorted = false } = {}) {
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
      const confirmed = within(film, lower, upper);
      const probability = normalCdf((upper - film.glicko) / film.rd) - normalCdf((lower - film.glicko) / film.rd);
      if (confirmed) { confirmedCount += 1; settledCount += 1; }
      probabilitySum += probability;
      assignments.set(film.id, {
        rating: bucket.rating, rank: i + 1, confirmed, confidence: percent(probability), lower, upper,
        positionConfirmed: within(film, cutAt(sorted, i + 1), cutAt(sorted, i)),
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
    stage = `Settling ${activeTier.rating}-star films: ${activeTier.settledCount} of ${activeTier.quota} rating ± RD intervals fit inside the tier.`;
  } else if (!topFourFinal) {
    const index = top.findIndex((film) => !assignments.get(film.id).positionConfirmed);
    const film = sorted[index];
    boundary = index > 0 && cutAt(sorted, index) - film.glicko < film.glicko - cutAt(sorted, index + 1) ? index : index + 1;
    stage = `Refining your top four: ${topFourSettledCount} of ${top.length} positions settled by rating ± RD.`;
  }
  let nextPair = null;
  let candidateCount = 0;
  if (boundary > 0 && boundary < sorted.length) {
    const cut = cutAt(sorted, boundary);
    // Bounded pools, selected in a linear scan, include uncertain distant
    // challengers without constructing every cross-boundary pair.
    const left = [];
    const right = [];
    const insert = (pool, film, distance) => {
      const score = distance / film.rd;
      const at = pool.findIndex((item) => score < item.score);
      if (at < 0) { if (pool.length < POOL_SIZE) pool.push({ film, score }); }
      else { pool.splice(at, 0, { film, score }); if (pool.length > POOL_SIZE) pool.pop(); }
    };
    sorted.forEach((film, index) => insert(index < boundary ? left : right, film, Math.abs(film.glicko - cut)));
    const skips = new Map();
    for (const match of history) if (match.skipped) {
      const key = pairKey(match.aId, match.bId);
      skips.set(key, (skips.get(key) || 0) + 1);
    }
    let bestScore = -Infinity;
    for (const { film: a } of left) for (const { film: b } of right) {
      candidateCount += 1;
      const gap = (a.glicko - b.glicko) / Math.hypot(a.rd, b.rd);
      const score = -gap * gap / 2 - (skips.get(pairKey(a.id, b.id)) || 0) * 2;
      if (score > bestScore) { bestScore = score; nextPair = { left: a, right: b }; }
    }
    if (history.length % 2) nextPair = { left: nextPair.right, right: nextPair.left };
  }
  return { sorted, quotas, assignments, tiers, topFourFinal, topFourSettledCount, topFourCount: top.length,
    confirmedCount, confidence: sorted.length ? percent(probabilitySum / sorted.length) : 0,
    nextPair, stage, activeTier, boundary, candidateCount };
}
