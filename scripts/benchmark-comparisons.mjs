import {analyzeRanking} from '../src/ranking.js';
import {recordComparison} from '../src/glicko.js';

// Previous closest-gap policy, evaluated with the same current confidence
// setting, cutoffs, Glicko updates, and deterministic simulated answers.
function nearestPair(ranking) {
  const {sorted,boundary}=ranking;
  if(!boundary)return null;
  const cut=(sorted[boundary-1].glicko+sorted[boundary].glicko)/2;
  const byDistance=(a,b)=>Math.abs(a.glicko-cut)/a.rd-Math.abs(b.glicko-cut)/b.rd;
  const left=sorted.slice(0,boundary).sort(byDistance).slice(0,12);
  const right=sorted.slice(boundary).sort(byDistance).slice(0,12);
  let best=null;
  for(const a of left)for(const b of right){const gap=(a.glicko-b.glicko)/Math.hypot(a.rd,b.rd);if(!best||gap<best.gap)best={left:a,right:b,gap};}
  return best;
}
function dataset(seed) {
  let state=seed;
  const random=()=>((state=Math.imul(state,1664525)+1013904223>>>0)/2**32);
  return Array.from({length:20},(_,i)=>{
    const truth=2000-i*45;
    const anchored=i%4===0;
    return {id:`film-${i}`,title:`Film ${i}`,truth,glicko:truth+(anchored?0:(random()-0.5)*220),rd:anchored?30:200,games:0,wins:0,losses:0};
  });
}
function run(items,policy,confidenceLevel) {
  let films=structuredClone(items);
  const history=[];
  const bins=[{rating:5,quota:4},{rating:1,quota:16}];
  for(let count=0;count<=500;count+=1){
    const ranking=analyzeRanking(films,bins,history,{confidenceLevel});
    if(ranking.tiers.every(tier=>tier.finalized)||count===500){
      const correct=ranking.sorted.slice(0,4).filter(film=>Number(film.id.slice(5))<4).length;
      return {comparisons:count,settled:ranking.tiers.every(tier=>tier.finalized),correctTopTierMembers:correct};
    }
    const pair=policy==='nearest'?nearestPair(ranking):ranking.nextPair;
    const winner=pair.left.truth>pair.right.truth?pair.left:pair.right;
    const loser=winner.id===pair.left.id?pair.right:pair.left;
    const result=recordComparison(winner,loser,count);
    films=films.map(film=>film.id===winner.id?result.winner:film.id===loser.id?result.loser:film);
    history.push(result.match);
  }
}
for(const seed of [1,2,3,4,5]) {
  const items=dataset(seed);
  console.log(JSON.stringify({seed,nearest95:run(items,'nearest',95),progress95:run(items,'progress',95),progress80:run(items,'progress',80)}));
}

