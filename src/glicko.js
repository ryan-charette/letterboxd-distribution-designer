// Glicko-1, https://www.glicko.net/glicko/glicko.pdf . Each comparison is
// one rating period; c=0 (no calendar-time drift for a static film collection).
export const INITIAL_RATING = 1500;
export const INITIAL_RD = 350;
export const SEEDED_RD = 150;
const MIN_RD = 30;
const Q = Math.log(10) / 400;
const g = (rd) => 1 / Math.sqrt(1 + 3 * Q * Q * rd * rd / (Math.PI * Math.PI));

export function initialGlicko(film, seedFromExistingRatings = true) {
  const seeded = seedFromExistingRatings && Number(film.importedRating) > 0;
  return { glicko: INITIAL_RATING + (seeded ? (Number(film.importedRating) - 3) * 115 : 0), rd: seeded ? SEEDED_RD : INITIAL_RD };
}

// All opponents must be supplied at their pre-period ratings.
export function updateGlicko(player, results) {
  let information = 0;
  let improvement = 0;
  for (const { opponent, score } of results) {
    const weight = g(opponent.rd);
    const expected = 1 / (1 + 10 ** (-weight * (player.glicko - opponent.glicko) / 400));
    information += Q * Q * weight * weight * expected * (1 - expected);
    improvement += weight * (score - expected);
  }
  const variance = 1 / (1 / (player.rd * player.rd) + information);
  return { glicko: player.glicko + Q * variance * improvement, rd: Math.max(MIN_RD, Math.sqrt(variance)) };
}

function snapshot(film) {
  return Object.fromEntries(['glicko', 'rd', 'games', 'wins', 'losses', 'lastPlayedAt'].map((key) => [key, film[key]]));
}
export function recordComparison(winner, loser, createdAt = Date.now()) {
  const winnerUpdate = updateGlicko(winner, [{ opponent: loser, score: 1 }]);
  const loserUpdate = updateGlicko(loser, [{ opponent: winner, score: 0 }]);
  return {
    winner: { ...winner, ...winnerUpdate, games: winner.games + 1, wins: winner.wins + 1, lastPlayedAt: createdAt },
    loser: { ...loser, ...loserUpdate, games: loser.games + 1, losses: loser.losses + 1, lastPlayedAt: createdAt },
    match: {
      aId: winner.id, bId: loser.id, winnerId: winner.id, loserId: loser.id, createdAt,
      before: { [winner.id]: snapshot(winner), [loser.id]: snapshot(loser) },
      after: { [winner.id]: winnerUpdate, [loser.id]: loserUpdate },
    },
  };
}

// Replay the actual saved answers rather than pretending old Elo deviations
// were Glicko RDs. Rebuild undo snapshots using the new rating system.
export function migrateSession(saved) {
  if (!saved || saved.schemaVersion === 2) return saved;
  const films = (saved.films || []).map(({ elo, ...film }) => ({
    ...film, ...initialGlicko(film, saved.seedFromExistingRatings !== false),
    games: 0, wins: 0, losses: 0, lastPlayedAt: null,
  }));
  const byId = new Map(films.map((film) => [film.id, film]));
  const history = [];
  for (const match of saved.history || []) {
    if (match.skipped) { history.push({ ...match, before: {}, after: {} }); continue; }
    const winner = byId.get(match.winnerId);
    const loser = byId.get(match.loserId);
    if (!winner || !loser || winner.id === loser.id) continue;
    const result = recordComparison(winner, loser, match.createdAt);
    byId.set(winner.id, result.winner);
    byId.set(loser.id, result.loser);
    history.push({ ...result.match, aId: match.aId, bId: match.bId });
  }
  return { ...saved, schemaVersion: 2, films: films.map((film) => byId.get(film.id)), history };
}
