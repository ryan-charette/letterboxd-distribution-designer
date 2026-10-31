import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeRanking, eloDeviation } from '../src/ranking.js';
const film = (id, elo, games = 0) => ({ id, title: id, elo, games });
const twoTiers = [{ rating: 5, quota: 1 }, { rating: 1, quota: 1 }];
const lows = () => Array.from({length: 200}, (_, i) => film(`low-${i}`, 1270));

// Independent approximation of the standard normal CDF for a two-film oracle.
function cdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const tail = Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI) * t *
    (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - tail : tail;
}

test('sampled confidence agrees with analytic two-film normal probabilities', () => {
  for (const gap of [0, 50, 150, 300]) {
    const a = film('favorite', 1500 + gap);
    const b = film('challenger', 1500);
    const ranking = analyzeRanking([a, b], twoTiers);
    const expected = cdf(gap / Math.hypot(eloDeviation(a), eloDeviation(b))) * 100;
    assert.ok(Math.abs(ranking.tiers[0].confidence - expected) < 4, `${gap}: ${ranking.tiers[0].confidence} vs ${expected}`);
    assert.equal(ranking.confidence, ranking.tiers[0].confidence);
  }
});

test('a well-separated favorite clears 90% without 200 low-rated comparisons', () => {
  const ranking = analyzeRanking([film('favorite', 1730), ...lows()], [{rating: 5, quota: 1}, {rating: 1, quota: 200}]);
  assert.ok(ranking.tiers[0].confidence >= 90);
  assert.equal(ranking.tiers[0].finalized, true);
  assert.ok(![ranking.nextPair?.left.id, ranking.nextPair?.right.id].includes('favorite'));
});

test('close favorites are tested before distant low-rated films and reach 90%', () => {
  const items = [film('favorite', 1730), film('rival', 1720), ...lows()];
  const quotas = [{rating: 5, quota: 1}, {rating: 4, quota: 1}, {rating: 1, quota: 200}];
  const history = [];
  let count = 0;
  let ranking = analyzeRanking(items, quotas, history);
  while (!ranking.tiers[0].finalized && count < 40) {
    const pair = ranking.nextPair;
    assert.deepEqual(new Set([pair.left.id, pair.right.id]), new Set(['favorite', 'rival']));
    const a = items[0]; const b = items[1];
    const expected = 1 / (1 + 10 ** ((b.elo - a.elo) / 400));
    a.elo += 36 * (1 - expected); b.elo -= 36 * (1 - expected);
    a.games += 1; b.games += 1;
    history.push({winnerId: a.id, loserId: b.id, aId: a.id, bId: b.id});
    count += 1;
    ranking = analyzeRanking(items, quotas, history);
  }
  assert.ok(count < 40);
  assert.ok(ranking.tiers[0].finalized);
});

test('tier confidence is whole-set probability; overall confidence averages film probabilities', () => {
  const items = Array.from({length: 6}, (_, i) => film(`film-${i}`, 1500));
  const ranking = analyzeRanking(items, [{rating: 5, quota: 3}, {rating: 1, quota: 3}]);
  assert.ok(ranking.tiers[0].confidence < 15);
  assert.ok(ranking.confidence > 40 && ranking.confidence < 60);
  assert.equal(ranking.activeTier.rating, 5);
  assert.ok(ranking.assignments.get(ranking.nextPair.left.id).rank <= 3);
  assert.ok(ranking.assignments.get(ranking.nextPair.right.id).rank > 3);
});

test('skip, reload, and import order do not manufacture confidence', () => {
  const items = Array.from({length: 6}, (_, i) => film(`film-${i}`, 1500));
  const quotas = [{rating: 5, quota: 2}, {rating: 1, quota: 4}];
  const initial = analyzeRanking(items, quotas);
  const history = [{aId: initial.nextPair.left.id, bId: initial.nextPair.right.id, skipped: true}];
  const skipped = analyzeRanking(items, quotas, history);
  assert.notDeepEqual(new Set([skipped.nextPair.left.id, skipped.nextPair.right.id]), new Set([initial.nextPair.left.id, initial.nextPair.right.id]));
  assert.deepEqual(skipped.assignments, initial.assignments);
  assert.deepEqual(analyzeRanking([...items].reverse(), quotas).assignments, initial.assignments);
  assert.deepEqual(analyzeRanking(items, quotas), initial);
});

test('90% is sufficient for top four; one tier does not imply a known order', () => {
  const items = [film('a', 2400), film('b', 2100), film('c', 1800), film('d', 1500), film('e', 1200)];
  const quotas = [{rating: 5, quota: 5}];
  const ranking = analyzeRanking(items, quotas);
  assert.equal(ranking.confidence, 100);
  assert.ok(ranking.topFourConfidence >= 90 && ranking.topFourConfidence < 100);
  assert.equal(ranking.topFourFinal, true);
  assert.equal(ranking.nextPair, null);
  const tied = analyzeRanking(items.map((f) => ({...f, elo: 1500})), quotas);
  assert.equal(tied.confidence, 100);
  assert.equal(tied.topFourFinal, false);
  assert.ok(tied.nextPair);
});

test('new Elo evidence and curve edits can reopen an earlier tier', () => {
  const items = [film('a', 1900), film('b', 1500), film('c', 1490)];
  const quotas = [{rating: 5, quota: 1}, {rating: 1, quota: 2}];
  assert.equal(analyzeRanking(items, quotas).tiers[0].finalized, true);
  const upset = items.map((f) => f.id === 'a' ? {...f, elo: 1510} : f);
  assert.equal(analyzeRanking(upset, quotas).tiers[0].finalized, false);
  assert.equal(analyzeRanking(items, [{rating: 5, quota: 2}, {rating: 1, quota: 1}]).tiers[0].finalized, false);
});

test('changing preferences are accepted; uncertainty shrinks and tiny imports are valid', () => {
  const items = [film('a', 1500), film('b', 1500)];
  const history = [{winnerId: 'a', loserId: 'b'}, {winnerId: 'b', loserId: 'a'}];
  assert.ok(analyzeRanking(items, twoTiers, history).nextPair);
  assert.ok(eloDeviation(film('a',1500,20)) < eloDeviation(items[0]));
  assert.equal(eloDeviation(film('a',1500,100000)),25);
  for (const count of [0,1]) {
    const ranking = analyzeRanking(items.slice(0,count), [{rating:5,quota:count}]);
    assert.equal(ranking.nextPair,null);
    assert.equal(ranking.topFourFinal,true);
    assert.equal(ranking.confidence,count ? 100 : 0);
  }
});

test('after five stars reaches the target, attention moves to the next tier', () => {
  const ranking = analyzeRanking([film('favorite',2000),film('middle-a',1500),film('middle-b',1490)], [{rating:5,quota:1},{rating:4,quota:1},{rating:1,quota:1}]);
  assert.equal(ranking.tiers[0].finalized,true);
  assert.equal(ranking.activeTier.rating,4);
  assert.deepEqual(new Set([ranking.nextPair.left.id,ranking.nextPair.right.id]), new Set(['middle-a','middle-b']));
});
