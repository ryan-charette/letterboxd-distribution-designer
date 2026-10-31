import { selectProgressPair } from '../src/pairing.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeRanking, sortFilms, normalCdf, intervalMultiplier, normalizeConfidence } from '../src/ranking.js';
import { initialGlicko, updateGlicko, recordComparison, migrateSession, expectedGlickoScore } from '../src/glicko.js';
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
  const ranking = analyzeRanking([film('a',1800,50),film('b',1500,100),film('c',1200,50)],quotas);
  assert.equal(ranking.tiers[0].lower,1650);
  assert.equal(ranking.tiers[1].upper,1650);
  assert.equal(ranking.tiers[1].lower,1350);
  assert.equal(ranking.assignments.get('a').confirmed,true);
  assert.equal(ranking.assignments.get('b').confirmed,false); // selected 95% interval crosses both cuts
  assert.equal(ranking.activeTier.rating,4);
  assert.equal(ranking.assignments.get('c').confirmed,true);
  const narrower = analyzeRanking([film('a',1800,50),film('b',1500,75),film('c',1200,50)],quotas);
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
  const ranking=analyzeRanking([film('a',2100,100),film('b',1600,100),film('c',1590,100),...low],
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

test('large libraries use a bounded shortlist with at most 16 two-outcome lookaheads', () => {
  const items=Array.from({length:10000},(_,i)=>film(`film-${i}`,2000-i/10,350));
  const ranking=analyzeRanking(items,[{rating:5,quota:5000},{rating:1,quota:5000}]);
  assert.ok(ranking.nextPair);
  assert.ok(ranking.candidateCount<=528);
  assert.ok(ranking.lookaheadCount<=16);
});

test('confidence levels produce standard central intervals, default to 95%, and clamp safely', () => {
  assert.ok(Math.abs(intervalMultiplier(95)-1.959964)<0.00001);
  assert.ok(Math.abs(intervalMultiplier(90)-1.644854)<0.00001);
  assert.ok(Math.abs(intervalMultiplier(99)-2.575829)<0.00001);
  assert.equal(normalizeConfidence(undefined),95);
  assert.equal(normalizeConfidence(NaN),95);
  assert.equal(normalizeConfidence(0),50);
  assert.equal(normalizeConfidence(100),99);
});

test('lower confidence can settle sooner without changing ratings or estimated accuracy', () => {
  const items=[film('a',1650,100),film('b',1350,100)];
  const before=structuredClone(items);
  const bins=[{rating:5,quota:1},{rating:1,quota:1}];
  const low=analyzeRanking(items,bins,[],{confidenceLevel:68});
  const high=analyzeRanking(items,bins,[],{confidenceLevel:95});
  assert.equal(low.tiers[0].finalized,true);
  assert.equal(high.tiers[0].finalized,false);
  assert.equal(low.confidence,high.confidence);
  assert.equal(low.assignments.get('a').intervalLower>high.assignments.get('a').intervalLower,true);
  assert.deepEqual(items,before);
  const restored=analyzeRanking(items,bins,[],{confidenceLevel:95});
  assert.deepEqual(restored,high);
});

test('a nearby low-RD anchor remains available alongside uncertain challengers', () => {
  const items=[film('a-target',1500,350),film('b-uncertain',1450,350),film('c-anchor',1500,30)];
  const before=structuredClone(items);
  const ranking=analyzeRanking(items,[{rating:5,quota:1},{rating:1,quota:2}]);
  assert.ok([ranking.nextPair.left.id,ranking.nextPair.right.id].includes('c-anchor'));
  assert.ok(ranking.expectedProgress>0);
  assert.deepEqual(items,before);
});

test('lookahead previews both outcomes from unchanged inputs and uses Glicko weights', () => {
  const a=film('a',1500,350);const b=film('b',1500,30);
  const inputs=[a,b];const before=structuredClone(inputs);const previews=[];
  const result=selectProgressPair(inputs,1,[],{
    multiplier:intervalMultiplier(95),focusIds:new Set(['a','b']),
    scoreOrder:order=>{previews.push(structuredClone(order));return {settled:Number(order[0].id==='a'&&order[0].glicko>1500),clarity:0};},
  });
  assert.equal(result.lookaheadCount,1);
  assert.equal(previews.length,3);
  assert.ok(Math.abs(result.expectedSettled-expectedGlickoScore(a,b))<1e-12);
  assert.deepEqual(inputs,before);
  for(const order of previews.slice(1)) {
    assert.ok(order[0].glicko>=order[1].glicko);
    assert.ok(order.find(film=>film.id==='a').rd<a.rd);
  }
});

test('the Glicko predictive probability matches the published uncertain-opponent example', () => {
  const probability=expectedGlickoScore(film('a',1400,80),film('b',1500,150));
  assert.ok(Math.abs(probability-0.376)<0.001);
  assert.ok(Math.abs(probability+expectedGlickoScore(film('b',1500,150),film('a',1400,80))-1)<1e-12);
});

test('the saved confidence preference survives migration without replaying Glicko history', () => {
  const saved={schemaVersion:2,confidenceLevel:80,films:[film('a',1600,100)],history:[]};
  assert.equal(migrateSession(saved),saved);
  assert.equal(migrateSession(saved).confidenceLevel,80);
  assert.equal(normalizeConfidence(migrateSession({...saved,confidenceLevel:undefined}).confidenceLevel),95);
});
