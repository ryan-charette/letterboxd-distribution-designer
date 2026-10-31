import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeRanking, sortFilms, normalCdf } from '../src/ranking.js';
import { initialGlicko, updateGlicko, recordComparison, migrateSession } from '../src/glicko.js';
const film = (id, glicko, rd = 100) => ({id, title:id, glicko, rd, games:0, wins:0, losses:0, lastPlayedAt:null});
const quotas = [{rating:5,quota:1},{rating:4,quota:1},{rating:1,quota:1}];

test('Glicko matches the published 1500/200 three-opponent example', () => {
  const result = updateGlicko(film('player',1500,200), [
    {opponent:film('a',1400,30),score:1},
    {opponent:film('b',1550,100),score:0},
    {opponent:film('c',1700,300),score:0},
  ]);
  assert.ok(Math.abs(result.glicko - 1464.106) < 0.001);
  assert.ok(Math.abs(result.rd - 151.399) < 0.001);
});

test('both participants update from pre-comparison ratings; undo restores rating and RD', () => {
  const a = film('a',1500,350); const b = film('b',1500,100);
  const result = recordComparison(a,b,123);
  assert.deepEqual(result.match.after.a,updateGlicko(a,[{opponent:b,score:1}]));
  assert.deepEqual(result.match.after.b,updateGlicko(b,[{opponent:a,score:0}]));
  assert.ok(result.winner.rd < a.rd && result.loser.rd < b.rd);
  assert.ok(result.winner.glicko - a.glicko > b.glicko - result.loser.glicko);
  assert.deepEqual({...result.winner,...result.match.before.a},a);
  assert.deepEqual({...result.loser,...result.match.before.b},b);
  assert.equal(a.games,0);
});

test('seeded and unseeded imports use explicit Glicko priors', () => {
  assert.deepEqual(initialGlicko({importedRating:5}),{glicko:1730,rd:150});
  assert.deepEqual(initialGlicko({importedRating:5},false),{glicko:1500,rd:350});
  assert.deepEqual(initialGlicko({importedRating:null}),{glicko:1500,rd:350});
  assert.deepEqual(updateGlicko(film('a',1500,200),[]),{glicko:1500,rd:200});
});

test('legacy migration replays answers and rebuilds reversible Glicko snapshots', () => {
  const old = {seedFromExistingRatings:true, films:[{...film('a',0),elo:1620,importedRating:5},{...film('b',0),elo:1300,importedRating:1}], history:[
    {aId:'b',bId:'a',winnerId:'a',loserId:'b',createdAt:10},
    {aId:'a',bId:'b',skipped:true,createdAt:20},
    {aId:'a',bId:'b',winnerId:'b',loserId:'a',createdAt:30},
  ]};
  const migrated = migrateSession(old);
  assert.equal(migrated.schemaVersion,2);
  assert.equal(migrated.history.length,3);
  assert.equal(migrated.films[0].games,2);
  assert.ok(!('elo' in migrated.films[0]));
  assert.equal(migrated.history[0].before.a.glicko,1730);
  assert.equal(migrated.history[0].before.a.rd,150);
  assert.deepEqual(migrated.history[1].before,{});
  const expectedFirst = recordComparison({...film('a',1730,150),importedRating:5},{...film('b',1270,150),importedRating:1},10);
  const undone = {...migrated.films[0],...migrated.history[2].before.a};
  assert.deepEqual(undone,expectedFirst.winner);
  assert.equal(migrateSession(migrated),migrated);
  assert.equal(old.films[0].elo,1620);
});

test('tier cutoffs use quota midpoints; only fully contained RD intervals settle', () => {
  const ranking = analyzeRanking([film('a',1800,100),film('b',1500,150),film('c',1200,100)],quotas);
  assert.equal(ranking.tiers[0].lower,1650);
  assert.equal(ranking.tiers[1].upper,1650);
  assert.equal(ranking.tiers[1].lower,1350);
  assert.equal(ranking.assignments.get('a').confirmed,true);
  assert.equal(ranking.assignments.get('b').confirmed,false); // touches both cuts
  assert.equal(ranking.activeTier.rating,4);
  assert.equal(ranking.assignments.get('c').confirmed,true);
  const narrower = analyzeRanking([film('a',1800,100),film('b',1500,149),film('c',1200,100)],quotas);
  assert.equal(narrower.tiers[1].finalized,true);
});

test('normal tier probability is distinct from interval settlement and averages correctly', () => {
  const ranking=analyzeRanking([film('a',1600,100),film('b',1400,100)],[{rating:5,quota:1},{rating:1,quota:1}]);
  assert.equal(ranking.assignments.get('a').confirmed,false);
  assert.ok(Math.abs(ranking.confidence - normalCdf(1)*100) < 0.1);
  assert.equal(ranking.tiers[0].progress,0);
});

test('five-star attention moves down and avoids 200 distant low-rated films', () => {
  const low=Array.from({length:200},(_,i)=>film(`low-${i}`,1000,150));
  const ranking=analyzeRanking([film('a',1900,100),film('b',1600,100),film('c',1590,100),...low],
    [{rating:5,quota:1},{rating:4,quota:1},{rating:3,quota:1},{rating:1,quota:200}]);
  assert.equal(ranking.tiers[0].finalized,true);
  assert.equal(ranking.activeTier.rating,4);
  assert.deepEqual(new Set([ranking.nextPair.left.id,ranking.nextPair.right.id]),new Set(['b','c']));
});

test('a wide RD keeps an earlier tier open despite a large mean-rating lead', () => {
  const ranking=analyzeRanking([film('a',1900,350),film('b',1500,100),film('c',1490,100)],quotas);
  assert.equal(ranking.activeTier.rating,5);
  assert.equal(ranking.assignments.get('a').confirmed,false);
  assert.ok([ranking.nextPair.left.id,ranking.nextPair.right.id].includes('a'));
});

test('skips and input order preserve ratings, probabilities, and settled intervals', () => {
  const items=Array.from({length:6},(_,i)=>film(`film-${i}`,1500,350));
  const bins=[{rating:5,quota:2},{rating:1,quota:4}];
  const initial=analyzeRanking(items,bins);
  const skipped=analyzeRanking(items,bins,[{aId:initial.nextPair.left.id,bId:initial.nextPair.right.id,skipped:true}]);
  assert.notDeepEqual(new Set([skipped.nextPair.left.id,skipped.nextPair.right.id]),new Set([initial.nextPair.left.id,initial.nextPair.right.id]));
  assert.deepEqual(skipped.assignments,initial.assignments);
  assert.deepEqual(analyzeRanking([...items].reverse(),bins).assignments,initial.assignments);
  assert.deepEqual(analyzeRanking(sortFilms(items),bins,[],{presorted:true}),initial);
});

test('single tier does not settle top-four order; ties, empty bins, and small sets work', () => {
  for(const count of [0,1,3,6]) {
    const items=Array.from({length:count},(_,i)=>film(`film-${i}`,2000-i*400,100));
    const ranking=analyzeRanking(items,[{rating:5,quota:0},{rating:4,quota:count}]);
    assert.equal(ranking.confidence,count?100:0);
    assert.equal(ranking.topFourFinal,true);
    assert.equal(ranking.nextPair,null);
    assert.equal(ranking.topFourCount,Math.min(4,count));
  }
  const tied=analyzeRanking([film('a',1500),film('b',1500)],[{rating:5,quota:2}]);
  assert.equal(tied.tiers[0].finalized,true);
  assert.equal(tied.topFourFinal,false);
  assert.ok(tied.nextPair);
});

test('quota changes and rating changes can reopen earlier tiers', () => {
  const items=[film('a',1900,100),film('b',1500,100),film('c',1490,100)];
  assert.equal(analyzeRanking(items,quotas).tiers[0].finalized,true);
  assert.equal(analyzeRanking(items,[{rating:5,quota:2},{rating:1,quota:1}]).tiers[0].finalized,false);
  assert.equal(analyzeRanking(items.map(f=>f.id==='a'?{...f,glicko:1510}:f),quotas).tiers[0].finalized,false);
});

test('large libraries score at most 144 pairs rather than a quadratic cross product', () => {
  const items=Array.from({length:10000},(_,i)=>film(`film-${i}`,2000-i/10,350));
  const ranking=analyzeRanking(items,[{rating:5,quota:5000},{rating:1,quota:5000}]);
  assert.ok(ranking.nextPair);
  assert.ok(ranking.candidateCount<=144);
});
