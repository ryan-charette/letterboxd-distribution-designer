import { performance } from 'node:perf_hooks';
import { analyzeRanking } from '../src/ranking.js';
const films = Array.from({length:2000}, (_, i) => ({id:`film-${i}`,title:`Film ${i}`,glicko:2000-i/2,rd:100,games:10}));
const quotas = Array.from({length:10}, (_, i) => ({rating:5-i/2,quota:200}));
analyzeRanking(films, quotas);
const times = [];
for(let i=0;i<15;i+=1) {
  const start = performance.now();
  analyzeRanking(films, quotas);
  times.push(performance.now()-start);
}
times.sort((a,b)=>a-b);
console.log(`${films.length} films: median ranking computation ${times[7].toFixed(2)} ms over 15 runs (excluding warm-up).`);
