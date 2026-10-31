import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeRanking } from '../src/ranking.js';
const films = (n) => Array.from({ length: n }, (_, i) => ({ id: String(i), title: `Film ${i}`, elo: 1500 + i * 20 }));
const win = (a, b) => ({ winnerId: String(a), loserId: String(b) });
const quotas = [{ rating: 5, quota: 2 }, { rating: 4, quota: 2 }, { rating: 3, quota: 2 }];

test('tier-first comparisons converge to true tiers and exact top four', () => {
  for (let seed = 1; seed <= 30; seed += 1) {
    let state = seed;
    const random = () => ((state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const items = films(6).sort(() => random() - 0.5);
    const truth = new Map(items.map((film, i) => [film.id, i]));
    const history = [];
    const locked = new Map();
    let ranking;
    for (let step = 0; step <= 16; step += 1) {
      ranking = analyzeRanking(items, quotas, history);
      for (const [id, rating] of locked) assert.equal(ranking.assignments.get(id).rating, rating);
      for (const tier of ranking.tiers.filter((tier) => tier.finalized)) {
        for (const film of ranking.sorted.slice(tier.start, tier.end)) locked.set(film.id, tier.rating);
      }
      const pair = ranking.nextPair;
      if (!pair) break;
      const unfinished = ranking.tiers.find((tier) => !tier.finalized);
      if (unfinished) {
        assert.ok(ranking.assignments.get(pair.left.id).rank <= unfinished.end);
        assert.ok(ranking.assignments.get(pair.right.id).rank > unfinished.end);
      }
      const [a, b] = [pair.left.id, pair.right.id];
      history.push(truth.get(a) < truth.get(b) ? win(a, b) : win(b, a));
    }
    assert.equal(ranking.nextPair, null);
    assert.equal(ranking.confidence, 100);
    assert.equal(ranking.topFourFinal, true);
    assert.deepEqual(ranking.sorted.slice(0, 4).map((f) => f.id), items.slice(0, 4).map((f) => f.id));
    for (const film of items) assert.equal(ranking.assignments.get(film.id).rating, [5, 5, 4, 4, 3, 3][truth.get(film.id)]);
  }
});

test('confidence is a valid bound across every compatible true order', () => {
  const items = films(6);
  const history = [win(0, 1), win(1, 2), win(0, 3), win(4, 5)];
  const ranking = analyzeRanking(items, quotas, history);
  function permutations(list) {
    return list.length ? list.flatMap((x) => permutations(list.filter((y) => y !== x)).map((tail) => [x, ...tail])) : [[]];
  }
  const orders = permutations(items.map((f) => f.id)).filter((order) => history.every((m) => order.indexOf(m.winnerId) < order.indexOf(m.loserId)));
  for (const film of items) {
    assert.equal(ranking.bounds.get(film.id).min, Math.min(...orders.map((o) => o.indexOf(film.id) + 1)));
    assert.equal(ranking.bounds.get(film.id).max, Math.max(...orders.map((o) => o.indexOf(film.id) + 1)));
  }
  for (const order of orders) {
    const correct = order.filter((id, i) => ranking.assignments.get(id).rating === [5, 5, 4, 4, 3, 3][i]).length;
    assert.ok(correct / 6 * 100 >= ranking.confidence);
    for (const [id, assignment] of ranking.assignments) if (assignment.confirmed) {
      assert.equal(assignment.rating, [5, 5, 4, 4, 3, 3][order.indexOf(id)]);
    }
  }
});

test('skips change pairs without adding evidence; undo restores ranking', () => {
  const items = films(6);
  const initial = analyzeRanking(items, quotas);
  const pair = initial.nextPair;
  const skip = { aId: pair.left.id, bId: pair.right.id, skipped: true };
  const skipped = analyzeRanking(items, quotas, [skip]);
  assert.notDeepEqual(skipped.nextPair, pair);
  assert.equal(skipped.confidence, initial.confidence);
  assert.deepEqual(skipped.bounds, initial.bounds);
  const history = [win(pair.left.id, pair.right.id)];
  history.pop();
  assert.deepEqual(analyzeRanking(items, quotas, history), initial);
});

test('single tier still determines ordered top four; tiny imports finish', () => {
  for (let n = 0; n <= 6; n += 1) {
    const items = films(n);
    const history = [];
    let ranking;
    for (let i = 0; i <= n * n; i += 1) {
      ranking = analyzeRanking(items, [{ rating: 5, quota: n }], history);
      if (!ranking.nextPair) break;
      const a = ranking.nextPair.left.id;
      const b = ranking.nextPair.right.id;
      history.push(Number(a) < Number(b) ? win(a, b) : win(b, a));
    }
    assert.equal(ranking.topFourFinal, true);
    assert.equal(ranking.nextPair, null);
    assert.deepEqual(ranking.sorted.slice(0, 4).map((f) => f.id), Array.from({length: Math.min(n, 4)}, (_, i) => String(i)));
  }
});

test('curve edits recompute certification, imported Elo alone is not evidence', () => {
  const items = films(6);
  assert.equal(analyzeRanking(items, quotas).confidence, 0);
  const history = [win(0, 2), win(0, 3), win(0, 4), win(0, 5), win(1, 2), win(1, 3), win(1, 4), win(1, 5)];
  const ranking = analyzeRanking(items, quotas, history);
  assert.equal(ranking.tiers[0].finalized, true);
  assert.equal(analyzeRanking(items, [{ rating: 5, quota: 1 }, { rating: 4, quota: 5 }], history).tiers[0].finalized, false);
});

test('legacy cycles cannot produce false confidence; missing films are ignored', () => {
  const ranking = analyzeRanking(films(6), quotas, [win(0, 1), win(1, 2), win(2, 0), win(9, 0)]);
  assert.equal(ranking.conflicts, 1);
  assert.equal(ranking.confidence, 0);
  assert.equal(ranking.topFourFinal, false);
});
