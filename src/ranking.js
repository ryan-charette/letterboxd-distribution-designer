// Comparisons are constraints on a consistent, transitive preference order.
// Elo only breaks ties between films whose relative order is not established.
export function analyzeRanking(films, quotas, history = []) {
  const byId = new Map(films.map((film) => [film.id, film]));
  const edges = new Map(films.map((film) => [film.id, new Set()]));
  function reachable(start, target) {
    const seen = new Set();
    const pending = [start];
    while (pending.length) {
      const id = pending.pop();
      if (id === target) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      pending.push(...edges.get(id));
    }
    return false;
  }
  let conflicts = 0;
  for (const match of history) {
    if (match.skipped || !byId.has(match.winnerId) || !byId.has(match.loserId)) continue;
    if (reachable(match.loserId, match.winnerId)) {
      conflicts += 1;
      continue;
    }
    edges.get(match.winnerId).add(match.loserId);
  }
  const descendants = new Map();
  const ancestors = new Map(films.map((film) => [film.id, new Set()]));
  for (const film of films) {
    const seen = new Set();
    const pending = [...edges.get(film.id)];
    while (pending.length) {
      const id = pending.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      ancestors.get(id).add(film.id);
      pending.push(...edges.get(id));
    }
    descendants.set(film.id, seen);
  }
  const bounds = new Map(films.map((film) => [film.id, {
    min: ancestors.get(film.id).size + 1,
    max: films.length - descendants.get(film.id).size,
  }]));
  // Kahn's algorithm produces an order respecting every accepted comparison.
  const indegree = new Map(films.map((film) => [film.id, 0]));
  for (const targets of edges.values()) for (const id of targets) indegree.set(id, indegree.get(id) + 1);
  const available = films.filter((film) => indegree.get(film.id) === 0);
  const sorted = [];
  while (available.length) {
    available.sort((a, b) => b.elo - a.elo || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
    const film = available.shift();
    sorted.push(film);
    for (const id of edges.get(film.id)) {
      indegree.set(id, indegree.get(id) - 1);
      if (!indegree.get(id)) available.push(byId.get(id));
    }
  }
  const assignments = new Map();
  const tiers = [];
  let cursor = 0;
  let confirmedCount = 0;
  for (const bucket of quotas) {
    const start = cursor;
    cursor += bucket.quota;
    if (!bucket.quota) continue;
    let finalized = !conflicts;
    for (let i = start; i < cursor; i += 1) {
      const film = sorted[i];
      const bound = bounds.get(film.id);
      const confirmed = !conflicts && bound.min > start && bound.max <= cursor;
      if (confirmed) confirmedCount += 1;
      else finalized = false;
      assignments.set(film.id, { rating: bucket.rating, rank: i + 1, confirmed });
    }
    tiers.push({ ...bucket, start, end: cursor, finalized });
  }
  const topFourFinal = !conflicts && sorted.slice(0, 4).every((film) => {
    const bound = bounds.get(film.id);
    return bound.min === bound.max;
  });
  let boundary = tiers.find((tier) => !tier.finalized)?.end;
  let stage = boundary === undefined ? "All rating tiers finalized." : `Finalizing ${tiers.find((tier) => !tier.finalized).rating}-star films, then moving down.`;
  if (boundary === undefined && !topFourFinal) {
    boundary = sorted.findIndex((film, index) => index < 4 && bounds.get(film.id).min !== bounds.get(film.id).max) + 1;
    stage = `Determining top-four position ${boundary}.`;
  }
  const skipCounts = new Map();
  const key = (a, b) => [a, b].sort().join("::");
  for (const match of history) if (match.skipped) {
    const pair = key(match.aId, match.bId);
    skipCounts.set(pair, (skipCounts.get(pair) || 0) + 1);
  }
  let choice = null;
  if (boundary !== undefined && boundary < films.length) {
    // Only compare across the earliest unfinished cut. Prefer its weakest
    // incumbent, then let every still-eligible challenger reach that cut.
    for (let i = boundary - 1; i >= 0; i -= 1) {
      for (let j = boundary; j < sorted.length; j += 1) {
        const a = sorted[i];
        const b = sorted[j];
        if (descendants.get(a.id).has(b.id)) continue;
        const skips = skipCounts.get(key(a.id, b.id)) || 0;
        if (!choice || skips < choice.skips) choice = { left: a, right: b, skips };
      }
    }
  }
  return {
    sorted, quotas, assignments, bounds, tiers, topFourFinal, conflicts,
    confirmedCount, confidence: films.length ? Math.floor(1000 * confirmedCount / films.length) / 10 : 0,
    nextPair: conflicts ? null : choice, stage: conflicts ? "Resolve conflicting saved comparisons before continuing." : stage,
  };
}
