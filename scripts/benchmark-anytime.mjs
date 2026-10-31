import {analyzeRanking} from '../src/ranking.js';
import {initialPreference,recordAnswer} from '../src/preference-model.js';
const seed=Number(process.argv[2]||1),scenario=process.argv[3]||'seeded';
const maxAnswers=Math.max(1,Math.min(3600,Number(process.argv[4]||3600)));
let state=seed;const random=()=>((state=Math.imul(state,1664525)+1013904223>>>0)/2**32);
const quotas=[10,30,70,140,250,250,140,70,30,10].map((quota,i)=>({rating:5-i*.5,quota}));
let films=[];let id=0;
const names=Array.from({length:1000},(_,i)=>i);for(let i=999;i>0;i--){const j=Math.floor(random()*(i+1));[names[i],names[j]]=[names[j],names[i]];}
for(const bin of quotas)for(let i=0;i<bin.quota;i++){
 const truth=(bin.rating-3)*1.5+(random()-.5)*.7;
 let importedRating=bin.rating;
 if(random()<(scenario==='weak'?0.4:0.15))importedRating=Math.max(.5,Math.min(5,importedRating+(random()<.5?-.5:.5)));
 if(scenario==='weak'&&random()<.05)importedRating=.5+Math.floor(random()*10)*.5;
 films.push({id:`film-${names[id]}`,title:`Film ${names[id++]}`,truth,trueTier:bin.rating,importedRating,...initialPreference({importedRating},scenario!=='unseeded')});
}
const trueOrder=[...films].sort((a,b)=>b.truth-a.truth),trueTop=new Set(trueOrder.slice(0,4).map(film=>film.id)),true20=new Set(trueOrder.slice(0,20).map(film=>film.id));
let history=[];let snapshots=[];
for(let count=0;count<=maxAnswers;count++){
 const ranking=analyzeRanking(films,quotas,history,{confidenceLevel:99,budgetMinutes:180});
 if([0,300,1200,3600,maxAnswers].includes(count)){
 const correct=films.filter(film=>ranking.assignments.get(film.id).rating===film.trueTier).length;
 const withinHalf=films.filter(film=>Math.abs(ranking.assignments.get(film.id).rating-film.trueTier)<=.5).length;
 const top4=ranking.sorted.slice(0,4).filter(film=>trueTop.has(film.id)).length;
 const top20=ranking.sorted.slice(0,20).filter(film=>true20.has(film.id)).length;
 const result={seed,scenario,count,actualAccuracy:correct/10,withinHalfStar:withinHalf/10,modelAccuracy:ranking.confidence,top4,top20,top4Model:ranking.topFourConfidence,coverage:films.filter(film=>film.games>0).length/10};
 snapshots.push(result);console.log(JSON.stringify(result));
 }
 if(count===maxAnswers||!ranking.nextPair)break;
 const {left,right}=ranking.nextPair;
 const p=.05+.9/(1+Math.exp(-(left.truth-right.truth)/.35));
 const winner=random()<p?left:right,loser=winner.id===left.id?right:left;
 const result=recordAnswer(films,history,winner.id,loser.id,count);
 films=result.films;history=result.history;
}
