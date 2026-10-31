// Approximate Bayesian Bradley–Terry preferences with a lapse mixture.
// Answers remain soft evidence, including cycles and occasional accidental picks.
export const MODEL_VERSION = 3;
export const TEMPERATURE = 0.5;
export const LAPSE_RATE = 0.1; // 10% random answers, hence a 5% upset floor.
const sigmoid = x => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, x))));
export function observation(a, b) {
  const scale = Math.sqrt(TEMPERATURE ** 2 + Math.PI * (a.variance + b.variance) / 8);
  const s = sigmoid((a.mu - b.mu) / scale);
  const probability = LAPSE_RATE / 2 + (1 - LAPSE_RATE) * s;
  const derivative = (1 - LAPSE_RATE) * s * (1 - s) / scale;
  return { probability, derivative, information: derivative ** 2 / (probability * (1 - probability)) };
}
export function initialPreference(film, seeded = true) {
  const hasRating = seeded && Number(film.importedRating) > 0;
  const priorMean = hasRating ? (Number(film.importedRating) - 3) * 1.5 : 0;
  const priorVariance = hasRating ? 0.4 ** 2 : 1.5 ** 2;
  return { mu: priorMean, variance: priorVariance, priorMean, priorVariance, games: 0, wins: 0, losses: 0, lastPlayedAt: null };
}
export const pairKey = (a,b) => [a,b].sort().join('::');
export function updatePair(a, b, score = 1, weight = 1) {
  const { probability, derivative, information } = observation(a, b);
  const gradient = weight * (score - probability) * derivative / (probability * (1 - probability));
  const info = weight * information;
  const denominator = 1 + info * (a.variance + b.variance);
  return [
    { ...a, mu: a.mu + a.variance * gradient / denominator, variance: Math.max(0.025, a.variance - a.variance ** 2 * info / denominator) },
    { ...b, mu: b.mu - b.variance * gradient / denominator, variance: Math.max(0.025, b.variance - b.variance ** 2 * info / denominator) },
  ];
}

// Periodic global refits let later answers repair earlier mistakes through the
// comparison graph. Priors are applied once; history is not counted twice.
export function refitPreferences(films, history) {
  const byId = new Map(films.map((film,index) => [film.id,index]));
  const edges = new Map();
  for (const match of history) {
    if (match.skipped || !byId.has(match.winnerId) || !byId.has(match.loserId)) continue;
    const key = pairKey(match.winnerId,match.loserId);
    if (!edges.has(key)) {
      const [a,b] = [match.winnerId,match.loserId].sort();
      edges.set(key,{a:byId.get(a),b:byId.get(b),wins:0,count:0});
    }
    const edge=edges.get(key);
    edge.wins += films[edge.a].id===match.winnerId?1:0;
    edge.count += 1;
  }
  const fitted = films.map(film => ({...film,mu:film.priorMean}));
  const gradients = new Float64Array(films.length);
  const precision = new Float64Array(films.length);
  for(let iteration=0;iteration<24;iteration+=1) {
    fitted.forEach((film,i)=>{
      gradients[i]=(film.priorMean-film.mu)/film.priorVariance;
      precision[i]=1/film.priorVariance;
    });
    for(const edge of edges.values()) {
      const a=fitted[edge.a],b=fitted[edge.b];
      const s=sigmoid((a.mu-b.mu)/TEMPERATURE);
      const p=LAPSE_RATE/2+(1-LAPSE_RATE)*s;
      const derivative=(1-LAPSE_RATE)*s*(1-s)/TEMPERATURE;
      // Repeated identical questions are correlated evidence, not free certainty.
      const weight=Math.sqrt(edge.count);
      const gradient=weight*(edge.wins/edge.count-p)*derivative/(p*(1-p));
      const info=weight*derivative**2/(p*(1-p));
      gradients[edge.a]+=gradient;gradients[edge.b]-=gradient;
      precision[edge.a]+=info;precision[edge.b]+=info;
    }
    fitted.forEach((film,i)=>{film.mu+=0.5*Math.max(-0.5,Math.min(0.5,gradients[i]/precision[i]));});
  }
  return fitted.map((film,i)=>({...film,variance:Math.min(film.priorVariance,Math.max(0.025,1.25/precision[i]))}));
}
export function recordAnswer(films, history, winnerId, loserId, createdAt = Date.now()) {
  const a=films.find(film=>film.id===winnerId),b=films.find(film=>film.id===loserId);
  if(!a||!b||a.id===b.id)return {films,history};
  const key=pairKey(a.id,b.id);
  const repeats=history.filter(match=>!match.skipped&&pairKey(match.winnerId,match.loserId)===key).length;
  const [winner,loser]=updatePair(a,b,1,1/Math.sqrt(1+repeats));
  winner.games+=1;winner.wins+=1;winner.lastPlayedAt=createdAt;
  loser.games+=1;loser.losses+=1;loser.lastPlayedAt=createdAt;
  const nextHistory=[...history,{aId:a.id,bId:b.id,winnerId:a.id,loserId:b.id,createdAt}];
  let updated=films.map(film=>film.id===a.id?winner:film.id===b.id?loser:film);
  const count=nextHistory.filter(match=>!match.skipped).length;
  if(count%25===0)updated=refitPreferences(updated,nextHistory);
  return {films:updated,history:nextHistory};
}
export function rebuildPreferences(films, history, seeded = true) {
  const initial=films.map(({elo,glicko,rd,...film})=>{
    const prior=initialPreference(film,seeded);
    if(Number.isFinite(film.priorMean)&&Number.isFinite(film.priorVariance)&&film.priorVariance>0) {
      prior.mu=prior.priorMean=film.priorMean;
      prior.variance=prior.priorVariance=film.priorVariance;
    }
    return {...film,...prior};
  });
  const ids=new Set(initial.map(film=>film.id));
  const valid=history.filter(match=>match.skipped||(ids.has(match.winnerId)&&ids.has(match.loserId)&&match.winnerId!==match.loserId)).map(match=>match.skipped
    ? {aId:match.aId,bId:match.bId,skipped:true,createdAt:match.createdAt}
    : {aId:match.aId??match.winnerId,bId:match.bId??match.loserId,winnerId:match.winnerId,loserId:match.loserId,createdAt:match.createdAt});
  const answers=valid.filter(match=>!match.skipped).length;
  const prefixAnswers=answers-answers%25;
  const byId=new Map(initial.map(film=>[film.id,film]));
  let answerCount=0,prefixEnd=0;
  for(let i=0;i<valid.length&&answerCount<prefixAnswers;i++) {
    const match=valid[i];prefixEnd=i+1;
    if(match.skipped)continue;
    const winner=byId.get(match.winnerId),loser=byId.get(match.loserId);
    winner.games++;winner.wins++;winner.lastPlayedAt=match.createdAt;
    loser.games++;loser.losses++;loser.lastPlayedAt=match.createdAt;
    answerCount++;
  }
  const prefix=valid.slice(0,prefixEnd);
  let state={films:prefixAnswers?refitPreferences(initial,prefix):initial,history:prefix};
  for(const match of valid.slice(prefixEnd)) {
    if(match.skipped){state.history.push(match);continue;}
    state=recordAnswer(state.films,state.history,match.winnerId,match.loserId,match.createdAt);
  }
  return state;
}

export function migrateSession(saved) {
  if(!saved||saved.schemaVersion===MODEL_VERSION)return saved;
  return {...saved,...rebuildPreferences(saved.films||[],saved.history||[],saved.seedFromExistingRatings!==false),schemaVersion:MODEL_VERSION};
}

