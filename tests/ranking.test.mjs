import test from 'node:test';
import assert from 'node:assert/strict';
import {initialPreference,updatePair,observation,recordAnswer,rebuildPreferences,refitPreferences,migrateSession} from '../src/preference-model.js';
import {analyzeRanking,sortFilms} from '../src/ranking.js';
const film=(id,stars=null,seeded=true)=>({id,title:id,importedRating:stars,...initialPreference({importedRating:stars},seeded)});
const quotas=[{rating:5,quota:2},{rating:1,quota:2}];
const library=()=>[film('a',5),film('b',4.5),film('c',2),film('d',1)];

test('a noisy likelihood gives both answers nonzero probability and updates softly',()=>{
 const a={...film('a'),mu:3,variance:.1},b={...film('b'),mu:-3,variance:.1};
 const p=observation(a,b).probability;
 assert.ok(p>.9&&p<.951);
 const [loser,winner]=updatePair(a,b,0);
 assert.ok(loser.mu<a.mu&&winner.mu>b.mu);
 assert.ok(Math.abs(loser.mu-a.mu)<.1);
 assert.ok(loser.variance>0&&winner.variance>0);
 assert.equal(a.mu,3);
});

test('contradictory answers and cycles remain valid evidence rather than hard constraints',()=>{
 let state={films:[film('a'),film('b'),film('c')],history:[]};
 for(const [winner,loser] of [['a','b'],['b','c'],['c','a'],['b','a']])state=recordAnswer(state.films,state.history,winner,loser,1);
 assert.equal(state.history.length,4);
 assert.ok(state.films.every(f=>Number.isFinite(f.mu)&&f.variance>0));
 const ranking=analyzeRanking(state.films,[{rating:5,quota:1},{rating:1,quota:2}]);
 assert.ok(ranking.nextPair);
});

test('global refits can reverse an early mistaken answer',()=>{
 const films=[film('a',3),film('b',3)];
 const wrong=[{winnerId:'a',loserId:'b'}];
 const corrected=[...wrong,...Array.from({length:20},()=>({winnerId:'b',loserId:'a'}))];
 const first=refitPreferences(films,wrong),last=refitPreferences(films,corrected);
 assert.ok(first[0].mu>first[1].mu);
 assert.ok(last[1].mu>last[0].mu);
});

test('repeated questions do not provide unlimited independent certainty',()=>{
 const films=[film('a',3),film('b',3)];
 const repeated=refitPreferences(films,Array.from({length:100},()=>({winnerId:'a',loserId:'b'})));
 assert.ok(repeated[0].variance>.08);
});

test('undo/replay and legacy migration preserve the actual answers',()=>{
 const films=library();
 const first=recordAnswer(films,[],'a','b',10);
 const second=recordAnswer(first.films,first.history,'c','d',20);
 const undone=rebuildPreferences(second.films,second.history.slice(0,-1));
 assert.deepEqual(undone,first);
 const legacy={schemaVersion:2,confidenceLevel:95,films:films.map(f=>({...f,glicko:1500,rd:100})),history:[...second.history,{aId:'a',bId:'c',skipped:true}]};
 const migrated=migrateSession(legacy);
 assert.equal(migrated.schemaVersion,3);
 assert.equal(migrated.history.length,3);
 assert.deepEqual(migrated.films,second.films);
 assert.equal(migrated.qualityTarget,undefined);
 assert.equal(migrateSession(migrated),migrated);
});

test('posterior ranking probabilities conserve quotas and expected-loss identities',()=>{
 const films=library(),ranking=analyzeRanking(films,quotas);
 const expected=[...ranking.assignments.values()].reduce((sum,a)=>sum+1-a.probability,0);
 assert.equal(ranking.expectedMisplacements,expected);
 assert.ok(Math.abs(ranking.confidence-(1-expected/films.length)*100)<.06);
 assert.equal(ranking.tiers.reduce((sum,t)=>sum+t.quota,0),4);
 for(const a of ranking.assignments.values())assert.ok(a.probability>=0&&a.probability<=1&&a.topFourProbability>=0&&a.topFourProbability<=1);
 assert.equal(ranking.topFourConfidence,100);
});

test('skip, rerender, and curve edits cannot create rating evidence',()=>{
 const films=library(),before=structuredClone(films),ordered=sortFilms(films);
 const ranking=analyzeRanking(ordered,quotas,[],{presorted:true});
 const skipped=analyzeRanking(ordered,quotas,[{aId:'a',bId:'b',skipped:true}],{presorted:true});
 assert.deepEqual(skipped.assignments,ranking.assignments);
 assert.equal(skipped.comparisonCount,0);
 analyzeRanking(ordered,[{rating:5,quota:1},{rating:1,quota:3}],[],{presorted:true});
 assert.deepEqual(films,before);
});

test('the default hour and maximum three-hour budgets cap answers honestly',()=>{
 const films=['a','b','c','d'].map(id=>film(id,3));
 const history=Array.from({length:1200},()=>({winnerId:'a',loserId:'b'}));
 const hour=analyzeRanking(films,quotas,history);
 assert.equal(hour.comparisonBudget,1200);
 assert.equal(hour.budgetReached,true);
 assert.equal(hour.nextPair,null);
 assert.equal(hour.targetReached,false);
 const extended=analyzeRanking(films,quotas,history,{budgetMinutes:180});
 assert.equal(extended.comparisonBudget,3600);
 assert.equal(extended.budgetReached,false);
 assert.ok(extended.nextPair);
});

test('a model quality target stops on aggregate expected loss, not every film',()=>{
 const films=[film('a',5),film('b',4),film('c',2),film('d',1)];
 const ranking=analyzeRanking(films,quotas,[],{confidenceLevel:70});
 assert.equal(ranking.targetReached,true);
 assert.equal(ranking.nextPair,null);
 assert.equal(ranking.comparisonCount,0);
});

test('an exploration turn includes a neglected low-rated film',()=>{
 const films=Array.from({length:100},(_,i)=>({...film(`film-${i}`,i<20?5:1),games:i<99?5:0}));
 const history=Array.from({length:8},()=>({aId:'film-0',bId:'film-1',winnerId:'film-0',loserId:'film-1'}));
 const ranking=analyzeRanking(films,[{rating:5,quota:20},{rating:1,quota:80}],history,{confidenceLevel:99});
 assert.ok([ranking.nextPair.left.id,ranking.nextPair.right.id].includes('film-99'));
});

test('partial results exist immediately and tiny libraries behave sensibly',()=>{
 for(const n of [0,1,2]){
 const films=library().slice(0,n),ranking=analyzeRanking(films,[{rating:5,quota:n}]);
 assert.equal(ranking.assignments.size,n);
 assert.ok(Number.isFinite(ranking.expectedMisplacements));
 if(n<2)assert.equal(ranking.nextPair,null);
 }
});

test('replay remains exact across global refit boundaries and preserves original priors',()=>{
 let state={films:library(),history:[]};let saved;
 for(let i=0;i<52;i++){
  const winner=i%2?'a':'b',loser=i%2?'c':'d';
  state=recordAnswer(state.films,state.history,winner,loser,i);
  if(i===49)saved=structuredClone(state);
 }
 const restored=rebuildPreferences(state.films,state.history.slice(0,50),false);
 assert.deepEqual(restored,saved);
});

test('full tier distributions and model rank ranges are valid',()=>{
 const ranking=analyzeRanking(library(),quotas);
 for(const assignment of ranking.assignments.values()){
  assert.equal(assignment.tierProbabilities.reduce((sum,t)=>sum+t.probability,0),1);
  assert.ok(assignment.rankLow>=1&&assignment.rankHigh<=4&&assignment.rankLow<=assignment.rankHigh);
 }
});

test('migration drops obsolete full snapshots and replays skips compactly',()=>{
 const films=library();
 const history=[{aId:'a',bId:'b',winnerId:'a',loserId:'b',createdAt:1,before:{huge:'obsolete'},after:{}},{aId:'c',bId:'d',skipped:true,createdAt:2,before:{huge:'obsolete'},after:{}}];
 const result=rebuildPreferences(films,history);
 assert.ok(result.history.every(match=>!('before' in match)&&!('after' in match)));
 assert.deepEqual(rebuildPreferences(result.films,result.history),result);
});
