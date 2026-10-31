import { performance } from 'node:perf_hooks';
import { analyzeRanking,sortFilms } from '../src/ranking.js';
import { initialPreference } from '../src/preference-model.js';
const count=1000;
const films=Array.from({length:count},(_,i)=>({id:`film-${i}`,title:`Film ${i}`,...initialPreference({importedRating:.5+(i%10)*.5})}));
const quotas=Array.from({length:10},(_,i)=>({rating:5-i*.5,quota:100}));
function median(times){return times.sort((a,b)=>a-b)[Math.floor(times.length/2)].toFixed(2);}
const cold=[];
for(let i=0;i<7;i++){const start=performance.now();analyzeRanking(films,quotas);cold.push(performance.now()-start);}
const sorted=sortFilms(films);analyzeRanking(sorted,quotas,[],{presorted:true});const warm=[];
for(let i=0;i<15;i++){const start=performance.now();analyzeRanking(sorted,quotas,[],{presorted:true});warm.push(performance.now()-start);}
console.log(JSON.stringify({films:count,newPosteriorMedianMs:median(cold),cachedCurveEditMedianMs:median(warm)}));
