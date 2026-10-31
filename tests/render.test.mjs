import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'vite';
import React from 'react';
import { renderToString } from 'react-dom/server';
import {analyzeRanking} from '../src/ranking.js';
import {initialPreference} from '../src/preference-model.js';
import theme from '../tailwind.config.js';
await build({logLevel:'silent',build:{ssr:'src/App.jsx',outDir:'node_modules/.cache/render-tests',emptyOutDir:true}});
const {default:App,ResultsTable,ConfidenceControl}=await import('../node_modules/.cache/render-tests/App.js');
test('initial app renders the anytime controls and verified brand palette',()=>{
 const html=renderToString(React.createElement(App));
 assert.match(html,/Time budget/);assert.match(html,/Target model tier accuracy/);
 assert.equal(theme.theme.extend.colors.brand[400],'#00e054');
 assert.equal(theme.theme.extend.colors['brand-blue'],'#40bcf4');
 assert.equal(theme.theme.extend.colors['brand-orange'],'#ff8000');
 assert.equal(theme.theme.extend.colors.slate[950],'#14181c');
});
test('results paginate while exposing provisional probabilities',()=>{
 const films=Array.from({length:250},(_,i)=>({id:`film-${i}`,title:`Film ${i}`,...initialPreference({importedRating:3})}));
 const ranking=analyzeRanking(films,[{rating:5,quota:125},{rating:1,quota:125}]);
 const html=renderToString(React.createElement(ResultsTable,{ranking}));
 const body=html.match(/<tbody>([\s\S]*?)<\/tbody>/)[1];
 assert.equal((body.match(/<tr /g)||[]).length,100);
 assert.match(html,/Expected rank/);assert.match(html,/Export CSV/);assert.match(html,/Provisional/);
});
test('budget and quality targets are different controls with honest descriptions',()=>{
 const html=renderToString(React.createElement(ConfidenceControl,{confidenceLevel:90,budgetMinutes:60,onChange:()=>{},onBudgetChange:()=>{}}));
 assert.match(html,/1200/);assert.match(html,/min="5"/);assert.match(html,/max="180"/);
 assert.match(html,/not guarantees/);assert.match(html,/Export useful results at any time/);
});

test('exports wait for a deferred curve update to finish',()=>{
 const films=Array.from({length:4},(_,i)=>({id:`film-${i}`,title:`Film ${i}`,...initialPreference({importedRating:3})}));
 const ranking=analyzeRanking(films,[{rating:5,quota:4}]);
 const html=renderToString(React.createElement(ResultsTable,{ranking,pending:true}));
 assert.match(html,/<button[^>]*disabled=""[^>]*>Updating estimates…<\/button>/);
});
