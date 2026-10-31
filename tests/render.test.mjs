import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'vite';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { analyzeRanking } from '../src/ranking.js';

await build({ logLevel:'silent', build:{ssr:'src/App.jsx',outDir:'node_modules/.cache/render-tests',emptyOutDir:true} });
const {default:App,ResultsTable} = await import('../node_modules/.cache/render-tests/App.js');
test('initial app renders without browser state', () => {
  assert.match(renderToString(React.createElement(App)), /Tier confidence/);
});
test('a large result set renders only one page and exposes Glicko RD', () => {
  const films=Array.from({length:250},(_,i)=>({id:`film-${i}`,title:`Film ${i}`,glicko:2000-i,rd:100,games:0,wins:0,losses:0}));
  const ranking=analyzeRanking(films,[{rating:5,quota:250}]);
  const html=renderToString(React.createElement(ResultsTable,{ranking}));
  const body=html.match(/<tbody>([\s\S]*?)<\/tbody>/)[1];
  assert.equal((body.match(/<tr /g)||[]).length,100);
  assert.match(html,/Glicko ± RD/);
  assert.match(html,/Next/);
  assert.match(html,/Export CSV/);
  assert.ok(!body.includes('Film 100<'));
});
