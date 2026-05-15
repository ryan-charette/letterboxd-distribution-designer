import React, { useEffect, useMemo, useRef, useState } from "react";
import Papa from "papaparse";
import { motion, AnimatePresence } from "framer-motion";
import { Upload, Trophy, RotateCcw, Download, Shuffle, Star, BarChart3, Film, Settings2, Info, Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";

const STORAGE_KEY = "letterboxd-elo-rating-app-v1";
const INITIAL_ELO = 1500;

const DEFAULT_DISTRIBUTION = [
  { rating: "5", percentage: 2 },
  { rating: "4.5", percentage: 6 },
  { rating: "4", percentage: 15 },
  { rating: "3.5", percentage: 23 },
  { rating: "3", percentage: 22 },
  { rating: "2.5", percentage: 15 },
  { rating: "2", percentage: 9 },
  { rating: "1.5", percentage: 5 },
  { rating: "1", percentage: 2 },
  { rating: "0.5", percentage: 1 },
];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function hashString(input) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return Math.abs(hash >>> 0);
}

function deterministicJitter(key, salt = 0) {
  return (hashString(`${key}:${salt}`) % 1000) / 1000;
}

function stableId(parts) {
  return parts
    .filter(Boolean)
    .join("|")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function getValue(row, candidates) {
  const keys = Object.keys(row || {});
  for (const candidate of candidates) {
    const found = keys.find((key) => key.trim().toLowerCase() === candidate.toLowerCase());
    if (found && row[found] !== undefined && row[found] !== null) return String(row[found]).trim();
  }
  const fuzzy = keys.find((key) => candidates.some((candidate) => key.trim().toLowerCase().includes(candidate.toLowerCase())));
  if (fuzzy && row[fuzzy] !== undefined && row[fuzzy] !== null) return String(row[fuzzy]).trim();
  return "";
}

function parseRating(value) {
  if (!value) return null;
  const cleaned = String(value).trim();
  const numeric = Number(cleaned.replace("/5", "").replace("stars", "").trim());
  if (Number.isFinite(numeric) && numeric >= 0 && numeric <= 5) return numeric;

  // Handles star strings such as ★★★½ or ★★★★½.
  const fullStars = (cleaned.match(/★/g) || []).length;
  const half = /½|1\/2|\.5/.test(cleaned) ? 0.5 : 0;
  const starRating = fullStars + half;
  if (starRating > 0 && starRating <= 5) return starRating;
  return null;
}

function normalizeDistribution(distribution) {
  const cleaned = distribution
    .map((item) => ({
      rating: String(item.rating ?? "").trim(),
      percentage: Number(item.percentage),
    }))
    .filter((item) => item.rating && Number.isFinite(item.percentage) && item.percentage >= 0)
    .sort((a, b) => Number(b.rating) - Number(a.rating));

  return cleaned.length ? cleaned : DEFAULT_DISTRIBUTION;
}

function distributionTotal(distribution) {
  return normalizeDistribution(distribution).reduce((sum, item) => sum + Number(item.percentage || 0), 0);
}

function quotasFor(count, distribution) {
  const dist = normalizeDistribution(distribution);
  const total = distributionTotal(dist) || 100;
  const raw = dist.map((item) => ({
    ...item,
    rawQuota: (Number(item.percentage || 0) / total) * count,
  }));

  let quotas = raw.map((item) => ({
    ...item,
    quota: Math.floor(item.rawQuota),
    remainder: item.rawQuota - Math.floor(item.rawQuota),
  }));

  let remaining = count - quotas.reduce((sum, item) => sum + item.quota, 0);
  quotas = quotas.sort((a, b) => b.remainder - a.remainder || Number(b.rating) - Number(a.rating));
  for (let i = 0; i < quotas.length && remaining > 0; i += 1) {
    quotas[i].quota += 1;
    remaining -= 1;
  }

  return quotas.sort((a, b) => Number(b.rating) - Number(a.rating));
}

function sortedFilms(films) {
  return [...films]
    .filter((film) => !film.removed)
    .sort((a, b) => b.elo - a.elo || b.games - a.games || a.title.localeCompare(b.title));
}

function assignmentsFor(films, distribution) {
  const sorted = sortedFilms(films);
  const quotas = quotasFor(sorted.length, distribution);
  const assignments = new Map();
  let cursor = 0;

  for (const bucket of quotas) {
    for (let i = 0; i < bucket.quota && cursor < sorted.length; i += 1) {
      assignments.set(sorted[cursor].id, {
        rating: bucket.rating,
        rank: cursor + 1,
        bucketPercentage: bucket.percentage,
      });
      cursor += 1;
    }
  }

  return { sorted, quotas, assignments };
}

function expectedScore(a, b) {
  return 1 / (1 + 10 ** ((b.elo - a.elo) / 400));
}

function kFactor(film) {
  if (film.games < 5) return 48;
  if (film.games < 15) return 36;
  if (film.games < 35) return 28;
  return 20;
}

function pairKey(aId, bId) {
  return [aId, bId].sort().join("::");
}

function historyCounts(history) {
  const counts = new Map();
  for (const match of history) {
    const key = pairKey(match.aId, match.bId);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function nearestByElo(target, sorted, blockedIds = new Set()) {
  let best = null;
  let bestDistance = Infinity;
  for (const candidate of sorted) {
    if (candidate.id === target.id || blockedIds.has(candidate.id)) continue;
    const distance = Math.abs(candidate.elo - target.elo);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

function chooseNextPair(films, distribution, history) {
  const sorted = sortedFilms(films);
  if (sorted.length < 2) return null;

  const quotas = quotasFor(sorted.length, distribution);
  const counts = historyCounts(history);
  const boundaries = [];
  let cursor = 0;
  for (const bucket of quotas) {
    cursor += bucket.quota;
    if (cursor > 0 && cursor < sorted.length) boundaries.push(cursor);
  }

  const candidates = [];
  const windowSize = clamp(Math.ceil(sorted.length * 0.06), 2, 12);
  const salt = history.length;

  for (const boundary of boundaries) {
    const leftStart = Math.max(0, boundary - windowSize);
    const rightEnd = Math.min(sorted.length, boundary + windowSize);

    for (let i = leftStart; i < boundary; i += 1) {
      for (let j = boundary; j < rightEnd; j += 1) {
        const a = sorted[i];
        const b = sorted[j];
        const repeats = counts.get(pairKey(a.id, b.id)) || 0;
        if (repeats >= 3) continue;

        const eloDiff = Math.abs(a.elo - b.elo);
        const closeness = 1 - clamp(eloDiff / 450, 0, 1);
        const uncertainty = 1 / (1 + a.games) + 1 / (1 + b.games);
        const boundaryProximity =
          1 -
          clamp((Math.abs(i + 0.5 - boundary) + Math.abs(j + 0.5 - boundary)) / (2 * windowSize), 0, 1);
        const staleBonus = Math.min(a.lastPlayedAt || 0, b.lastPlayedAt || 0) ? 0 : 0.25;
        const score =
          boundaryProximity * 4 +
          closeness * 2.2 +
          uncertainty * 1.9 +
          staleBonus -
          repeats * 2.4 +
          deterministicJitter(`${a.id}-${b.id}`, salt) * 0.35;

        candidates.push({ a, b, reason: "boundary", boundary, score });
      }
    }
  }

  // Make sure every film gets enough signal before the app over-focuses on cut lines.
  const lowGameFilms = sorted.filter((film) => film.games < 3).slice(0, Math.min(30, sorted.length));
  for (const film of lowGameFilms) {
    const opponent = nearestByElo(film, sorted);
    if (!opponent) continue;
    const repeats = counts.get(pairKey(film.id, opponent.id)) || 0;
    if (repeats >= 2) continue;
    candidates.push({
      a: film,
      b: opponent,
      reason: "coverage",
      score: 7 + (3 - film.games) * 1.5 - repeats * 2 + deterministicJitter(`${film.id}-${opponent.id}`, salt) * 0.3,
    });
  }

  // Fallback: nearest-neighbor Elo comparisons across the whole table.
  if (!candidates.length) {
    for (let i = 0; i < sorted.length - 1; i += 1) {
      const a = sorted[i];
      const b = sorted[i + 1];
      const repeats = counts.get(pairKey(a.id, b.id)) || 0;
      candidates.push({
        a,
        b,
        reason: "nearest",
        score: 3 - repeats + deterministicJitter(`${a.id}-${b.id}`, salt) * 0.25,
      });
    }
  }

  candidates.sort((x, y) => y.score - x.score);
  const choice = candidates[0];
  if (!choice) return null;

  // Randomize left/right without changing the underlying pair.
  const flip = deterministicJitter(`${choice.a.id}-${choice.b.id}`, salt) > 0.5;
  return flip
    ? { left: choice.b, right: choice.a, reason: choice.reason, boundary: choice.boundary }
    : { left: choice.a, right: choice.b, reason: choice.reason, boundary: choice.boundary };
}

function computeReadiness(films, distribution, history) {
  const sorted = sortedFilms(films);
  if (sorted.length < 2) return { score: 100, coverage: 100, boundary: 100, unresolved: [] };

  const quotas = quotasFor(sorted.length, distribution);
  const boundaries = [];
  let cursor = 0;
  for (let i = 0; i < quotas.length; i += 1) {
    cursor += quotas[i].quota;
    if (cursor > 0 && cursor < sorted.length) {
      boundaries.push({ index: cursor, above: quotas[i].rating, below: quotas[i + 1]?.rating });
    }
  }

  const coverage = sorted.filter((film) => film.games >= 3).length / sorted.length;
  const windowSize = clamp(Math.ceil(sorted.length * 0.04), 2, 8);
  const unresolved = [];
  const boundaryScores = boundaries.map((boundary) => {
    const left = sorted.slice(Math.max(0, boundary.index - windowSize), boundary.index);
    const right = sorted.slice(boundary.index, Math.min(sorted.length, boundary.index + windowSize));
    const nearby = [...left, ...right];
    const avgGames = nearby.reduce((sum, film) => sum + film.games, 0) / Math.max(1, nearby.length);
    const gamesFactor = clamp(avgGames / 4, 0, 1);
    const gap = Math.max(0, (sorted[boundary.index - 1]?.elo || 0) - (sorted[boundary.index]?.elo || 0));
    const gapFactor = clamp(gap / 120, 0, 1);
    const score = gamesFactor * 0.62 + gapFactor * 0.38;
    if (score < 0.7) unresolved.push({ ...boundary, score, gap, avgGames });
    return score;
  });

  const boundary = boundaryScores.length
    ? boundaryScores.reduce((sum, score) => sum + score, 0) / boundaryScores.length
    : 1;
  const progressTowardUsefulSample = clamp(history.length / Math.max(8, Math.ceil(sorted.length * 3)), 0, 1);
  const score = (coverage * 0.32 + boundary * 0.48 + progressTowardUsefulSample * 0.2) * 100;

  return {
    score: Math.round(score),
    coverage: Math.round(coverage * 100),
    boundary: Math.round(boundary * 100),
    unresolved,
  };
}

function parseDistributionText(text) {
  const rows = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const parsed = [];
  for (const row of rows) {
    if (/rating/i.test(row) && /percentage/i.test(row)) continue;
    const parts = row.split(/[\t, ]+/).filter(Boolean);
    if (parts.length < 2) continue;
    const rating = parts[0].replace(/[★]/g, "").trim();
    const pct = Number(parts[1].replace("%", ""));
    if (rating && Number.isFinite(pct)) parsed.push({ rating, percentage: pct });
  }

  return parsed.length ? normalizeDistribution(parsed) : null;
}

function parseFilmsFromRows(rows, seedFromExistingRatings) {
  const seen = new Set();
  const films = [];

  rows.forEach((row, index) => {
    const title = getValue(row, ["Name", "Title", "Film", "Movie"]);
    if (!title) return;

    const year = getValue(row, ["Year", "Release Year"]);
    const uri = getValue(row, ["Letterboxd URI", "URI", "URL", "Link"]);
    const watchedDate = getValue(row, ["Watched Date", "Date"]);
    const ratingRaw = getValue(row, ["Rating", "Stars", "Score"]);
    const importedRating = parseRating(ratingRaw);
    const baseId = stableId([uri || title, year || "unknown"]);
    const id = baseId || `film-${index}`;
    if (seen.has(id)) return;
    seen.add(id);

    const seededElo = seedFromExistingRatings && importedRating
      ? INITIAL_ELO + (importedRating - 3) * 115
      : INITIAL_ELO;

    films.push({
      id,
      title,
      year,
      uri,
      watchedDate,
      importedRating,
      elo: Math.round(seededElo),
      games: 0,
      wins: 0,
      losses: 0,
      lastPlayedAt: null,
      removed: false,
    });
  });

  return films;
}

function filmLabel(film) {
  return film.year ? `${film.title} (${film.year})` : film.title;
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

function FilmChoiceCard({ film, assignment, onPick, side }) {
  return (
    <motion.div
      key={film.id}
      initial={{ opacity: 0, y: 16, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -12, scale: 0.98 }}
      transition={{ duration: 0.18 }}
      className="h-full"
    >
      <button
        onClick={() => onPick(film.id)}
        className="group h-full w-full rounded-3xl border bg-white p-0 text-left shadow-sm transition hover:-translate-y-1 hover:shadow-xl focus:outline-none focus:ring-4 focus:ring-slate-200"
      >
        <div className="flex h-full min-h-[300px] flex-col justify-between rounded-3xl bg-gradient-to-br from-white to-slate-50 p-6">
          <div>
            <div className="mb-4 flex items-center justify-between gap-3">
              <Badge variant="secondary" className="rounded-full px-3 py-1">
                {side}
              </Badge>
              <Badge className="rounded-full px-3 py-1" variant="outline">
                Current band: {assignment?.rating ?? "—"} ★
              </Badge>
            </div>
            <div className="mb-2 flex items-center gap-3 text-slate-500">
              <Film className="h-5 w-5" />
              <span className="text-sm font-medium uppercase tracking-wide">Pick the film you prefer</span>
            </div>
            <h2 className="text-3xl font-bold tracking-tight text-slate-950">{film.title}</h2>
            <p className="mt-2 text-sm font-medium text-slate-400">Press {side === "Choice A" ? "← left arrow" : "→ right arrow"}</p>
            <p className="mt-2 text-lg text-slate-500">{film.year || "Year unknown"}</p>
            {film.importedRating ? (
              <p className="mt-3 text-sm text-slate-500">Imported Letterboxd rating: {film.importedRating} ★</p>
            ) : null}
          </div>

          <div className="mt-8 grid grid-cols-3 gap-3 rounded-2xl bg-slate-100 p-3 text-center">
            <div>
              <div className="text-xs font-medium text-slate-500">Elo</div>
              <div className="text-lg font-semibold text-slate-900">{Math.round(film.elo)}</div>
            </div>
            <div>
              <div className="text-xs font-medium text-slate-500">Matches</div>
              <div className="text-lg font-semibold text-slate-900">{film.games}</div>
            </div>
            <div>
              <div className="text-xs font-medium text-slate-500">Rank</div>
              <div className="text-lg font-semibold text-slate-900">#{assignment?.rank ?? "—"}</div>
            </div>
          </div>
        </div>
      </button>
    </motion.div>
  );
}

function DistributionEditor({ distribution, setDistribution, filmCount }) {
  const [pasteText, setPasteText] = useState("");
  const quotas = useMemo(() => quotasFor(filmCount, distribution), [filmCount, distribution]);
  const total = distributionTotal(distribution);

  function updateRow(index, key, value) {
    setDistribution((current) =>
      normalizeDistribution(
        current.map((row, rowIndex) =>
          rowIndex === index ? { ...row, [key]: key === "percentage" ? Number(value) : value } : row,
        ),
      ),
    );
  }

  function addRow() {
    setDistribution((current) => normalizeDistribution([...current, { rating: "", percentage: 0 }]));
  }

  function removeRow(index) {
    setDistribution((current) => normalizeDistribution(current.filter((_, rowIndex) => rowIndex !== index)));
  }

  function applyPaste() {
    const parsed = parseDistributionText(pasteText);
    if (parsed) {
      setDistribution(parsed);
      setPasteText("");
    }
  }

  return (
    <Card className="rounded-3xl shadow-sm">
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2 text-xl">
              <Settings2 className="h-5 w-5" /> Rating distribution
            </CardTitle>
            <p className="mt-2 text-sm text-slate-500">
              Percentages are converted into quotas. Current total: <span className="font-semibold">{total.toFixed(1)}%</span>
            </p>
          </div>
          <Badge variant={Math.abs(total - 100) < 0.01 ? "default" : "secondary"} className="rounded-full">
            {Math.abs(total - 100) < 0.01 ? "Balanced" : "Auto-normalized"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="overflow-hidden rounded-2xl border">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Rating</th>
                <th className="px-4 py-3">Percentage</th>
                <th className="px-4 py-3">Quota</th>
                <th className="w-10 px-2 py-3" />
              </tr>
            </thead>
            <tbody>
              {distribution.map((row, index) => {
                const quota = quotas.find((item) => item.rating === row.rating)?.quota ?? 0;
                return (
                  <tr key={`${row.rating}-${index}`} className="border-t">
                    <td className="px-4 py-2">
                      <Input value={row.rating} onChange={(event) => updateRow(index, "rating", event.target.value)} />
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2">
                        <Input
                          type="number"
                          min="0"
                          step="0.1"
                          value={row.percentage}
                          onChange={(event) => updateRow(index, "percentage", event.target.value)}
                        />
                        <span className="text-slate-500">%</span>
                      </div>
                    </td>
                    <td className="px-4 py-2 font-medium text-slate-700">{filmCount ? quota : "—"}</td>
                    <td className="px-2 py-2">
                      <Button variant="ghost" size="icon" onClick={() => removeRow(index)} aria-label="Remove row">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={addRow}>Add rating</Button>
          <Button variant="outline" onClick={() => setDistribution(DEFAULT_DISTRIBUTION)}>Reset example</Button>
        </div>

        <div className="grid gap-3 md:grid-cols-[1fr_auto]">
          <Textarea
            value={pasteText}
            onChange={(event) => setPasteText(event.target.value)}
            placeholder={"Paste a table, e.g.\nRating Percentage\n5 2%\n4.5 6%"}
            className="min-h-[88px] rounded-2xl"
          />
          <Button onClick={applyPaste} disabled={!pasteText.trim()} className="self-end rounded-2xl">
            Apply pasted table
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ResultsTable({ films, distribution }) {
  const { sorted, assignments } = useMemo(() => assignmentsFor(films, distribution), [films, distribution]);

  function ratingChanged(film) {
    const assigned = Number(assignments.get(film.id)?.rating);
    return film.importedRating !== null && film.importedRating !== undefined && Number.isFinite(assigned) && assigned !== Number(film.importedRating);
  }

  function exportResults() {
    const rows = sorted.map((film) => ({
      Rank: assignments.get(film.id)?.rank,
      Title: film.title,
      Year: film.year,
      "Assigned Rating": assignments.get(film.id)?.rating,
      "Changed From Imported": ratingChanged(film) ? "Yes" : "No",
      Elo: Math.round(film.elo),
      Matches: film.games,
      Wins: film.wins,
      Losses: film.losses,
      "Imported Rating": film.importedRating ?? "",
      "Letterboxd URI": film.uri ?? "",
    }));
    downloadText("letterboxd-elo-ratings.csv", Papa.unparse(rows));
  }

  return (
    <Card className="rounded-3xl shadow-sm">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2 text-xl">
              <Trophy className="h-5 w-5" /> Current results
            </CardTitle>
            <p className="mt-2 text-sm text-slate-500">Ratings are assigned by Elo order using your target distribution.</p>
          </div>
          <Button onClick={exportResults} className="rounded-2xl">
            <Download className="mr-2 h-4 w-4" /> Export CSV
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="max-h-[520px] overflow-auto rounded-2xl border">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="sticky top-0 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Rank</th>
                <th className="px-4 py-3">Film</th>
                <th className="px-4 py-3">Assigned</th>
                <th className="px-4 py-3">Changed?</th>
                <th className="px-4 py-3">Elo</th>
                <th className="px-4 py-3">Matches</th>
                <th className="px-4 py-3">W-L</th>
                <th className="px-4 py-3">Imported</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((film) => {
                const assignment = assignments.get(film.id);
                const changed = ratingChanged(film);
                return (
                  <tr key={film.id} className={`border-t hover:bg-slate-50 ${changed ? "bg-amber-50/70" : ""}`}>
                    <td className="px-4 py-3 font-semibold">#{assignment?.rank}</td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-950">{film.title}</div>
                      <div className="text-xs text-slate-500">{film.year || "Year unknown"}</div>
                    </td>
                    <td className="px-4 py-3">
                      <Badge className={`rounded-full ${changed ? "bg-amber-600 text-white hover:bg-amber-600" : ""}`}>
                        {assignment?.rating} ★
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      {changed ? (
                        <Badge variant="secondary" className="rounded-full bg-amber-100 text-amber-900 hover:bg-amber-100">
                          Changed
                        </Badge>
                      ) : film.importedRating ? (
                        <span className="text-slate-400">No</span>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">{Math.round(film.elo)}</td>
                    <td className="px-4 py-3">{film.games}</td>
                    <td className="px-4 py-3">{film.wins}-{film.losses}</td>
                    <td className={`px-4 py-3 ${changed ? "font-semibold text-amber-900" : ""}`}>
                      {film.importedRating ? `${film.importedRating} ★` : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

export default function LetterboxdEloRatingApp() {
  const fileInputRef = useRef(null);
  const [films, setFilms] = useState([]);
  const [distribution, setDistribution] = useState(DEFAULT_DISTRIBUTION);
  const [history, setHistory] = useState([]);
  const [seedFromExistingRatings, setSeedFromExistingRatings] = useState(true);
  const [uploadError, setUploadError] = useState("");
  const [showResults, setShowResults] = useState(false);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (saved?.films?.length) setFilms(saved.films);
      if (saved?.distribution?.length) setDistribution(saved.distribution);
      if (saved?.history?.length) setHistory(saved.history);
      if (typeof saved?.seedFromExistingRatings === "boolean") setSeedFromExistingRatings(saved.seedFromExistingRatings);
    } catch {
      // Ignore incompatible saved state.
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ films, distribution, history, seedFromExistingRatings }),
      );
    } catch {
      // Local storage can be unavailable in private contexts.
    }
  }, [films, distribution, history, seedFromExistingRatings]);

  const { assignments, quotas, sorted } = useMemo(() => assignmentsFor(films, distribution), [films, distribution]);
  const nextPair = useMemo(() => chooseNextPair(films, distribution, history), [films, distribution, history]);
  const readiness = useMemo(() => computeReadiness(films, distribution, history), [films, distribution, history]);

  function handleFile(file) {
    setUploadError("");
    if (!file) return;

    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (result) => {
        if (result.errors?.length) {
          setUploadError(result.errors[0].message || "Could not parse that CSV.");
          return;
        }
        const parsedFilms = parseFilmsFromRows(result.data, seedFromExistingRatings);
        if (parsedFilms.length < 2) {
          setUploadError("I found fewer than 2 films. Check that the CSV has Letterboxd-style columns such as Name and Year.");
          return;
        }
        setFilms(parsedFilms);
        setHistory([]);
        setShowResults(false);
      },
      error: (error) => setUploadError(error.message || "Could not parse that CSV."),
    });
  }

  function handlePick(winnerId) {
    if (!nextPair) return;
    const loserId = winnerId === nextPair.left.id ? nextPair.right.id : nextPair.left.id;
    const now = Date.now();

    setFilms((current) => {
      const winner = current.find((film) => film.id === winnerId);
      const loser = current.find((film) => film.id === loserId);
      if (!winner || !loser) return current;

      const expectedWinner = expectedScore(winner, loser);
      const expectedLoser = expectedScore(loser, winner);
      const winnerK = kFactor(winner);
      const loserK = kFactor(loser);
      const winnerAfter = Math.round(winner.elo + winnerK * (1 - expectedWinner));
      const loserAfter = Math.round(loser.elo + loserK * (0 - expectedLoser));

      const updated = current.map((film) => {
        if (film.id === winnerId) {
          return {
            ...film,
            elo: winnerAfter,
            games: film.games + 1,
            wins: film.wins + 1,
            lastPlayedAt: now,
          };
        }
        if (film.id === loserId) {
          return {
            ...film,
            elo: loserAfter,
            games: film.games + 1,
            losses: film.losses + 1,
            lastPlayedAt: now,
          };
        }
        return film;
      });

      setHistory((currentHistory) => [
        ...currentHistory,
        {
          aId: nextPair.left.id,
          bId: nextPair.right.id,
          winnerId,
          loserId,
          before: {
            [winnerId]: { elo: winner.elo, games: winner.games, wins: winner.wins, losses: winner.losses, lastPlayedAt: winner.lastPlayedAt },
            [loserId]: { elo: loser.elo, games: loser.games, wins: loser.wins, losses: loser.losses, lastPlayedAt: loser.lastPlayedAt },
          },
          after: {
            [winnerId]: winnerAfter,
            [loserId]: loserAfter,
          },
          createdAt: now,
        },
      ]);

      return updated;
    });
  }

  useEffect(() => {
    function isTypingTarget(target) {
      if (!target) return false;
      const tagName = target.tagName?.toLowerCase();
      return tagName === "input" || tagName === "textarea" || tagName === "select" || target.isContentEditable;
    }

    function handleKeyDown(event) {
      if (!nextPair || isTypingTarget(event.target)) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        handlePick(nextPair.left.id);
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        handlePick(nextPair.right.id);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [nextPair]);

  function undoLast() {
    const last = history[history.length - 1];
    if (!last) return;
    setFilms((current) =>
      current.map((film) => {
        const previous = last.before?.[film.id];
        return previous ? { ...film, ...previous } : film;
      }),
    );
    setHistory((current) => current.slice(0, -1));
  }

  function resetAll() {
    setFilms([]);
    setHistory([]);
    setShowResults(false);
    setUploadError("");
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Ignore.
    }
  }

  function reshufflePair() {
    // Records a neutral skip for pair selection purposes without changing Elo.
    if (!nextPair) return;
    setHistory((current) => [
      ...current,
      {
        aId: nextPair.left.id,
        bId: nextPair.right.id,
        winnerId: null,
        loserId: null,
        before: {},
        after: {},
        skipped: true,
        createdAt: Date.now(),
      },
    ]);
  }

  const activeFilmCount = sorted.length;

  return (
    <main className="min-h-screen bg-slate-100 p-4 text-slate-950 md:p-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="overflow-hidden rounded-[2rem] bg-slate-950 p-8 text-white shadow-xl md:p-10">
          <div className="grid gap-8 lg:grid-cols-[1.25fr_0.75fr] lg:items-end">
            <div>
              <div className="mb-4 inline-flex items-center gap-2 rounded-full bg-white/10 px-4 py-2 text-sm text-white/80">
                <Star className="h-4 w-4" /> Letterboxd CSV → adaptive Elo ratings
              </div>
              <h1 className="text-4xl font-black tracking-tight md:text-6xl">Rate your films with fewer, better choices.</h1>
              <p className="mt-5 max-w-3xl text-lg leading-8 text-white/70">
                Upload a Letterboxd watched, ratings, or diary export. The app asks head-to-head preference questions, updates Elo, and maps the current Elo order into your target rating distribution.
              </p>
            </div>
            <div className="rounded-3xl bg-white/10 p-5 backdrop-blur">
              <div className="flex items-center gap-3">
                <BarChart3 className="h-6 w-6" />
                <div>
                  <p className="text-sm uppercase tracking-wide text-white/60">Session</p>
                  <p className="text-2xl font-bold">{activeFilmCount || 0} films · {history.filter((item) => !item.skipped).length} matches</p>
                </div>
              </div>
              <div className="mt-5">
                <div className="mb-2 flex justify-between text-sm text-white/70">
                  <span>Bucket clarity</span>
                  <span>{readiness.score}%</span>
                </div>
                <Progress value={readiness.score} className="h-3" />
              </div>
            </div>
          </div>
        </header>

        {!films.length ? (
          <div className="grid gap-6 lg:grid-cols-[0.95fr_1.05fr]">
            <Card className="rounded-3xl shadow-sm">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-xl">
                  <Upload className="h-5 w-5" /> Upload Letterboxd CSV
                </CardTitle>
                <p className="text-sm text-slate-500">
                  Works with exports that include columns like Name, Year, Letterboxd URI, and optionally Rating.
                </p>
              </CardHeader>
              <CardContent className="space-y-5">
                <div
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    handleFile(event.dataTransfer.files?.[0]);
                  }}
                  className="rounded-3xl border-2 border-dashed border-slate-300 bg-white p-8 text-center"
                >
                  <Upload className="mx-auto h-10 w-10 text-slate-400" />
                  <h2 className="mt-4 text-xl font-semibold">Drop your CSV here</h2>
                  <p className="mt-2 text-sm text-slate-500">or choose a file from your computer.</p>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".csv,text/csv"
                    className="hidden"
                    onChange={(event) => handleFile(event.target.files?.[0])}
                  />
                  <Button onClick={() => fileInputRef.current?.click()} className="mt-5 rounded-2xl">
                    Choose CSV
                  </Button>
                </div>

                <label className="flex cursor-pointer items-start gap-3 rounded-2xl bg-slate-50 p-4">
                  <input
                    type="checkbox"
                    checked={seedFromExistingRatings}
                    onChange={(event) => setSeedFromExistingRatings(event.target.checked)}
                    className="mt-1"
                  />
                  <span>
                    <span className="block font-medium">Seed Elo from imported ratings when present</span>
                    <span className="block text-sm text-slate-500">
                      Useful for a ratings.csv or diary.csv export. Watched.csv usually has no ratings, so every movie starts equal.
                    </span>
                  </span>
                </label>

                {uploadError ? <div className="rounded-2xl bg-red-50 p-4 text-sm text-red-700">{uploadError}</div> : null}

                <div className="rounded-2xl bg-slate-50 p-4 text-sm leading-6 text-slate-600">
                  <div className="mb-2 flex items-center gap-2 font-semibold text-slate-900">
                    <Info className="h-4 w-4" /> How pairings are chosen
                  </div>
                  The selector prioritizes films close to your rating cut lines, plus under-tested films. That means it focuses on questions like “is this a 4 or a 3.5?” rather than fully sorting every film from best to worst.
                </div>
              </CardContent>
            </Card>

            <DistributionEditor distribution={distribution} setDistribution={setDistribution} filmCount={0} />
          </div>
        ) : (
          <div className="space-y-6">
            <div className="grid gap-6 xl:grid-cols-[1.35fr_0.65fr]">
              <Card className="rounded-3xl shadow-sm">
                <CardHeader>
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <CardTitle className="flex items-center gap-2 text-xl">
                        <Shuffle className="h-5 w-5" /> Next head-to-head
                      </CardTitle>
                      <p className="mt-2 text-sm text-slate-500">
                        Pick the film you prefer. Use ← for the left movie and → for the right movie. Elo updates immediately; rating bands update after each choice.
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button variant="outline" onClick={undoLast} disabled={!history.length} className="rounded-2xl">
                        <RotateCcw className="mr-2 h-4 w-4" /> Undo
                      </Button>
                      <Button variant="outline" onClick={reshufflePair} disabled={!nextPair} className="rounded-2xl">
                        Skip pair
                      </Button>
                      <Button onClick={() => setShowResults((value) => !value)} className="rounded-2xl">
                        {showResults ? "Hide results" : "View results"}
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  {nextPair ? (
                    <AnimatePresence mode="wait">
                      <div key={`${nextPair.left.id}-${nextPair.right.id}-${history.length}`} className="grid gap-5 md:grid-cols-2">
                        <FilmChoiceCard
                          film={nextPair.left}
                          assignment={assignments.get(nextPair.left.id)}
                          onPick={handlePick}
                          side="Choice A"
                        />
                        <FilmChoiceCard
                          film={nextPair.right}
                          assignment={assignments.get(nextPair.right.id)}
                          onPick={handlePick}
                          side="Choice B"
                        />
                      </div>
                    </AnimatePresence>
                  ) : (
                    <div className="rounded-3xl bg-slate-50 p-8 text-center">
                      <Trophy className="mx-auto h-10 w-10 text-slate-400" />
                      <h2 className="mt-4 text-2xl font-bold">Not enough films to compare.</h2>
                    </div>
                  )}
                </CardContent>
              </Card>

              <div className="space-y-6">
                <Card className="rounded-3xl shadow-sm">
                  <CardHeader>
                    <CardTitle className="text-xl">Progress</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-5">
                    <div>
                      <div className="mb-2 flex justify-between text-sm text-slate-500">
                        <span>Overall clarity</span>
                        <span>{readiness.score}%</span>
                      </div>
                      <Progress value={readiness.score} className="h-3" />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="rounded-2xl bg-slate-50 p-4">
                        <div className="text-2xl font-bold">{history.filter((item) => !item.skipped).length}</div>
                        <div className="text-sm text-slate-500">Elo matches</div>
                      </div>
                      <div className="rounded-2xl bg-slate-50 p-4">
                        <div className="text-2xl font-bold">{readiness.coverage}%</div>
                        <div className="text-sm text-slate-500">3+ match coverage</div>
                      </div>
                    </div>
                    <div className="rounded-2xl bg-amber-50 p-4 text-sm leading-6 text-amber-900">
                      <span className="font-semibold">Good stopping rule:</span> when clarity feels high, export. Keep comparing only if the cut lines still contain films you are unsure about.
                    </div>
                    {readiness.unresolved.length ? (
                      <div className="space-y-2">
                        <div className="text-sm font-semibold text-slate-700">Cut lines needing more signal</div>
                        {readiness.unresolved.slice(0, 4).map((item) => (
                          <div key={`${item.above}-${item.below}`} className="flex items-center justify-between rounded-2xl bg-slate-50 px-4 py-3 text-sm">
                            <span>{item.above}★ / {item.below}★</span>
                            <span className="text-slate-500">gap {Math.round(item.gap)}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="rounded-2xl bg-emerald-50 p-4 text-sm text-emerald-800">
                        The current rating boundaries look reasonably stable.
                      </div>
                    )}
                  </CardContent>
                </Card>

                <Card className="rounded-3xl shadow-sm">
                  <CardHeader>
                    <CardTitle className="text-xl">Current quotas</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2">
                      {quotas.map((bucket) => (
                        <div key={bucket.rating} className="grid grid-cols-[58px_1fr_52px] items-center gap-3 text-sm">
                          <div className="font-semibold">{bucket.rating}★</div>
                          <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                            <div
                              className="h-full rounded-full bg-slate-900"
                              style={{ width: `${activeFilmCount ? (bucket.quota / activeFilmCount) * 100 : 0}%` }}
                            />
                          </div>
                          <div className="text-right text-slate-500">{bucket.quota}</div>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              </div>
            </div>

            <div className="grid gap-6 lg:grid-cols-[0.72fr_1.28fr]">
              <DistributionEditor distribution={distribution} setDistribution={setDistribution} filmCount={activeFilmCount} />
              <ResultsTable films={films} distribution={distribution} />
            </div>

            {showResults ? <ResultsTable films={films} distribution={distribution} /> : null}

            <div className="flex flex-wrap justify-between gap-3 rounded-3xl bg-white p-4 shadow-sm">
              <Button variant="outline" onClick={() => fileInputRef.current?.click()} className="rounded-2xl">
                Upload different CSV
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(event) => handleFile(event.target.files?.[0])}
              />
              <Button variant="destructive" onClick={resetAll} className="rounded-2xl">
                Reset app
              </Button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
