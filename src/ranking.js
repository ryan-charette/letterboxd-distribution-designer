import { observation, pairKey } from './preference-model.js';
export const DEFAULT_CONFIDENCE=90;
export const normalizeConfidence=value=>Number.isFinite(value)?Math.max(70,Math.min(99,value)):DEFAULT_CONFIDENCE;
export const sortFilms=films=>films.filter(film=>!film.removed).sort((a,b)=>b.mu-a.mu||a.title.localeCompare(b.title)||a.id.localeCompare(b.id));
const pct=x=>Math.round(x*1000)/10;
const SAMPLES=64;
// Common random numbers prevent confidence from changing merely on reload/skip.
function source(id){let seed=2166136261;for(const ch of id)seed=Math.imul(seed^ch.charCodeAt(0),16777619);seed=seed>>>0||1;return()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return((seed>>>0)+0.5)/4294967296;};}
const sampleCache = new WeakMap();
function posteriorOrders(sorted) {
  if(sampleCache.has(sorted))return sampleCache.get(sorted);
  const sources=sorted.map(film=>source(film.id));
  const orders=[];
  for(let sample=0;sample<SAMPLES;sample++) {
    orders.push(Int32Array.from(sorted.map((film,index)=>({index,score:film.mu+Math.sqrt(film.variance)*Math.sqrt(-2*Math.log(sources[index]()))*Math.cos(2*Math.PI*sources[index]())})).sort((a,b)=>b.score-a.score).map(item=>item.index)));
  }
  sampleCache.set(sorted,orders);
  return orders;
}
function selectPair(sorted, assignments, history, count) {
  if(sorted.length<2)return null;
  const played=new Map(),recent=new Map();
  history.forEach((match,i)=>{
    const key=pairKey(match.aId,match.bId);
    if(!match.skipped)played.set(key,(played.get(key)||0)+1);
    recent.set(key,i);
  });
  const favorites=Math.max(12,Math.min(100,Math.ceil(sorted.length*0.12)));
  const coldStart=sorted.some(film=>film.priorVariance>1&&film.games===0);
  const exploration=coldStart?count%2===0:count%10>=8;
  const favoriteTurn=coldStart?count%2===1:count%10<5;
  const optimisticRank=new Map([...sorted].sort((a,b)=>(b.mu+Math.sqrt(b.variance))-(a.mu+Math.sqrt(a.variance))).map((film,index)=>[film.id,index]));
  let targets;
  if(exploration) {
    targets=[...sorted].sort((a,b)=>a.games-b.games||a.mu-b.mu).slice(0,8);
  } else {
    targets=sorted.map((film,i)=>{
      const assignment=assignments.get(film.id);
      const relevance=favoriteTurn?Math.exp(-optimisticRank.get(film.id)/favorites):1+2*(assignment.rating/5)**2;
      const ambiguity=favoriteTurn?4*assignment.topFourProbability*(1-assignment.topFourProbability)+0.2*(1-assignment.probability):1-assignment.probability;
      return {film,priority:relevance*(0.04+ambiguity)*Math.sqrt(film.variance)/(1+0.15*film.games)};
    }).sort((a,b)=>b.priority-a.priority).slice(0,12).map(item=>item.film);
  }
  let best=null;
  for(const target of targets) {
    const opponents=sorted.filter(film=>film.id!==target.id).map(film=>({film,distance:Math.abs(film.mu-target.mu)})).sort((a,b)=>a.distance-b.distance||a.film.variance-b.film.variance).slice(0,24);
    for(const {film:opponent} of opponents) {
      const key=pairKey(target.id,opponent.id);
      const repeats=played.get(key)||0;
      if(history.length-(recent.get(key)??-100000)<Math.min(30,sorted.length*2))continue;
      const {information}=observation(target,opponent);
      const a=assignments.get(target.id),b=assignments.get(opponent.id);
      const tierBenefit=0.1+(1-a.probability)+(1-b.probability)+Number(a.rating!==b.rating)*0.5;
      const topBenefit=0.1+4*a.topFourProbability*(1-a.topFourProbability)+4*b.topFourProbability*(1-b.topFourProbability);
      const benefit=favoriteTurn?topBenefit+0.15*tierBenefit:tierBenefit;
      const anchor=1+0.1/(0.1+opponent.variance);
      const score=information*(target.variance+opponent.variance)*benefit*anchor/(1+repeats)**2;
      if(!best||score>best.score)best={left:target,right:opponent,score};
    }
  }
  // Very small libraries may exhaust the recency window; permit a revisit.
  if(!best){const index=count%(sorted.length-1);best={left:sorted[index],right:sorted[index+1]};}
  return count%2?{left:best.right,right:best.left}:best;
}
export function analyzeRanking(films, quotas, history=[], {presorted=false,confidenceLevel=DEFAULT_CONFIDENCE,budgetMinutes=60}={}) {
  const sorted=presorted?films:sortFilms(films);
  const assignments=new Map(),tiers=[],tierAtRank=[];
  let cursor=0;
  for(const bucket of quotas){if(!bucket.quota)continue;const start=cursor;cursor+=bucket.quota;const index=tiers.length;tiers.push({...bucket,start,end:cursor});for(let i=start;i<cursor;i++){tierAtRank[i]=index;assignments.set(sorted[i].id,{rank:i+1,rating:bucket.rating,hits:0,topHits:0,positionHits:0,rankSum:0,starError:0,tierHits:new Uint16Array(quotas.filter(bin=>bin.quota).length),ranks:[]});}}
  for(const order of posteriorOrders(sorted)) {
    order.forEach((index,rank)=>{
      const assignment=assignments.get(sorted[index].id);
      assignment.tierHits[tierAtRank[rank]]++;
      assignment.ranks.push(rank+1);
      if(tierAtRank[rank]===tierAtRank[index])assignment.hits++;
      if(rank<4)assignment.topHits++;
      if(rank===index)assignment.positionHits++;
      assignment.rankSum+=rank+1;
      assignment.starError+=Math.abs(tiers[tierAtRank[rank]].rating-assignment.rating);
    });
  }
  const target=normalizeConfidence(confidenceLevel)/100;
  let expectedMisplacements=0;
  for(const assignment of assignments.values()) {
    assignment.tierProbabilities=tiers.map((tier,index)=>({rating:tier.rating,probability:assignment.tierHits[index]/SAMPLES}));
    assignment.ranks.sort((a,b)=>a-b);
    assignment.rankLow=assignment.ranks[Math.floor(.05*(SAMPLES-1))];
    assignment.rankHigh=assignment.ranks[Math.ceil(.95*(SAMPLES-1))];
    assignment.probability=assignment.hits/SAMPLES;
    assignment.confidence=pct(assignment.probability);
    assignment.topFourProbability=assignment.topHits/SAMPLES;
    assignment.topFourConfidence=pct(assignment.topFourProbability);
    assignment.positionConfidence=pct(assignment.positionHits/SAMPLES);
    assignment.expectedRank=Math.round(assignment.rankSum/SAMPLES*10)/10;
    assignment.expectedStarError=assignment.starError/SAMPLES;
    assignment.confirmed=assignment.probability>=target;
    expectedMisplacements+=1-assignment.probability;
    for(const key of ['hits','topHits','positionHits','rankSum','starError','tierHits','ranks'])delete assignment[key];
  }
  for(const tier of tiers){tier.expectedMisplacements=sorted.slice(tier.start,tier.end).reduce((sum,film)=>sum+1-assignments.get(film.id).probability,0);tier.progress=pct(1-tier.expectedMisplacements/tier.quota);tier.finalized=tier.progress>=target*100;}
  const top=sorted.slice(0,4);
  const expectedTopFourMissing=top.reduce((sum,film)=>sum+1-assignments.get(film.id).topFourProbability,0);
  const topFourConfidence=top.length?pct(1-expectedTopFourMissing/top.length):100;
  const count=history.filter(match=>!match.skipped).length;
  const confidence=sorted.length?pct(1-expectedMisplacements/sorted.length):0;
  const expectedStarError=sorted.length?[...assignments.values()].reduce((sum,a)=>sum+a.expectedStarError,0)/sorted.length:0;
  const budget=Math.max(1,Math.round((Number.isFinite(budgetMinutes)?Math.max(5,Math.min(180,budgetMinutes)):60)*20));
  const targetReached=sorted.length>0&&1-expectedMisplacements/sorted.length>=target&&expectedTopFourMissing<=top.length*(1-target);
  const budgetReached=count>=budget;
  const nextPair=targetReached||budgetReached?null:selectPair(sorted,assignments,history,count);
  const stage=budgetReached?'Time budget reached. Export your current ranking or increase the budget.':targetReached?'Your model accuracy targets are reached. Results are ready to export.':`Improving favorites and tier placements. About ${Math.round(expectedMisplacements)} films may be in a different tier under the model.`;
  return {sorted,quotas,assignments,tiers,confidence,confidenceLevel:target*100,expectedMisplacements,expectedStarError,expectedTopFourMissing,topFourConfidence,topFourFinal:topFourConfidence>=target*100,topFourCount:top.length,confirmedCount:sorted.filter(film=>assignments.get(film.id).confirmed).length,nextPair,stage,targetReached,budgetReached,comparisonCount:count,comparisonBudget:budget,remainingMinutes:Math.max(0,(budget-count)/20)};
}
