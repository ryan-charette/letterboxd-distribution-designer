import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

const numberFormatter = new Intl.NumberFormat();
const STAR = "\u2605";
const HALF = "\u00bd";
const STORAGE_KEY = "letterboxd-distribution-elo-state-v1";
const INITIAL_ELO = 1500;
const CURVE_W = 640;
const CURVE_H = 300;
const BAR_W = 640;
const BAR_H = 300;
const CONTROL_POINT_COUNT = 17;
const CURVE_Y_MAX = 3.4;
const MIN_DENSITY = 0.02;
const SOFT_SELECT_RADIUS = 2.8;
const MIN_POINT_GAP = 0.012;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizePoints(points) {
  let area = 0;
  for (let i = 0; i < points.length - 1; i += 1) {
    area += ((points[i].y + points[i + 1].y) / 2) * (points[i + 1].x - points[i].x);
  }
  const safeArea = area || 1;
  return points.map((point) => ({ ...point, y: Math.max(MIN_DENSITY, point.y / safeArea) }));
}

function smoothPoints(points, passes = 1) {
  let ys = points.map((point) => point.y);
  for (let pass = 0; pass < passes; pass += 1) {
    const prev = ys.slice();
    ys = prev.map((value, index) => {
      if (index === 0) return prev[index] * 0.8 + prev[index + 1] * 0.2;
      if (index === prev.length - 1) return prev[index] * 0.8 + prev[index - 1] * 0.2;
      return prev[index - 1] * 0.18 + prev[index] * 0.64 + prev[index + 1] * 0.18;
    });
  }
  return points.map((point, index) => ({ ...point, y: Math.max(MIN_DENSITY, ys[index]) }));
}

function makePreset(kind, count = CONTROL_POINT_COUNT) {
  const points = Array.from({ length: count }, (_, index) => {
    const x = index / (count - 1);
    let y = 0;

    if (kind === "bimodal") {
      y =
        0.72 * Math.exp(-0.5 * ((x - 0.28) / 0.11) ** 2) +
        1.0 * Math.exp(-0.5 * ((x - 0.72) / 0.12) ** 2) +
        0.04;
    } else if (kind === "left") {
      y =
        1.1 * Math.exp(-0.5 * ((x - 0.34) / 0.14) ** 2) +
        0.2 * Math.exp(-0.5 * ((x - 0.7) / 0.26) ** 2) +
        0.035;
    } else if (kind === "right") {
      y =
        1.1 * Math.exp(-0.5 * ((x - 0.66) / 0.14) ** 2) +
        0.2 * Math.exp(-0.5 * ((x - 0.3) / 0.26) ** 2) +
        0.035;
    } else {
      y = 1.02 * Math.exp(-0.5 * ((x - 0.5) / 0.17) ** 2) + 0.03;
    }

    return { x, y };
  });

  return normalizePoints(points);
}

function evaluateDensity(points, x) {
  const sorted = [...points].sort((a, b) => a.x - b.x);
  if (x <= sorted[0].x) return sorted[0].y;
  if (x >= sorted[sorted.length - 1].x) return sorted[sorted.length - 1].y;

  for (let i = 0; i < sorted.length - 1; i += 1) {
    const left = sorted[i];
    const right = sorted[i + 1];
    if (x >= left.x && x <= right.x) {
      const span = right.x - left.x || 1;
      const t = (x - left.x) / span;
      return left.y * (1 - t) + right.y * t;
    }
  }

  return sorted[sorted.length - 1].y;
}

function repartitionPointXs(points, anchorIndex) {
  const next = points.map((point) => ({ ...point }));
  const lastIndex = next.length - 1;

  if (anchorIndex <= 0) {
    next[0].x = 0;
    for (let i = 1; i <= lastIndex; i += 1) {
      next[i].x = i / lastIndex;
    }
    return next;
  }

  if (anchorIndex >= lastIndex) {
    for (let i = 0; i < lastIndex; i += 1) {
      next[i].x = i / lastIndex;
    }
    next[lastIndex].x = 1;
    return next;
  }

  const anchor = next[anchorIndex];
  anchor.x = clamp(
    anchor.x,
    anchorIndex * MIN_POINT_GAP,
    1 - (lastIndex - anchorIndex) * MIN_POINT_GAP,
  );

  for (let i = 0; i < anchorIndex; i += 1) {
    next[i].x = (anchor.x * i) / anchorIndex;
  }
  next[anchorIndex].x = anchor.x;
  for (let i = anchorIndex + 1; i <= lastIndex; i += 1) {
    next[i].x = anchor.x + ((1 - anchor.x) * (i - anchorIndex)) / (lastIndex - anchorIndex);
  }

  next[0].x = 0;
  next[lastIndex].x = 1;
  return next;
}

function sampleDensity(points, sampleCount = 260) {
  return Array.from({ length: sampleCount }, (_, index) => {
    const x = index / (sampleCount - 1);
    return { x, y: evaluateDensity(points, x) };
  });
}

function smoothSvgPath(points) {
  if (!points.length) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;

  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i += 1) {
    const midX = (points[i].x + points[i + 1].x) / 2;
    const midY = (points[i].y + points[i + 1].y) / 2;
    d += ` Q ${points[i].x} ${points[i].y} ${midX} ${midY}`;
  }
  const last = points[points.length - 1];
  d += ` T ${last.x} ${last.y}`;
  return d;
}

function getScreenPoints(samples, width, height, padding, yMax = CURVE_Y_MAX) {
  const plotWidth = width - padding * 2;
  const plotHeight = height - padding * 2;

  return samples.map((sample) => ({
    x: padding + sample.x * plotWidth,
    y: height - padding - (clamp(sample.y, 0, yMax) / yMax) * plotHeight,
  }));
}

function getBinProbabilities(points, binCount, sampleCount = 1400) {
  const raw = Array(binCount).fill(0);
  let total = 0;

  for (let i = 0; i < sampleCount; i += 1) {
    const x = i / (sampleCount - 1);
    const y = evaluateDensity(points, x);
    total += y;
    const binIndex = Math.min(binCount - 1, Math.floor(x * binCount));
    raw[binIndex] += y;
  }

  const safeTotal = total || 1;
  return raw.map((value) => value / safeTotal);
}

function largestRemainderRound(probabilities, total) {
  const raw = probabilities.map((probability) => probability * total);
  const counts = raw.map((value) => Math.floor(value));
  let remaining = total - counts.reduce((sum, value) => sum + value, 0);

  const order = raw
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder);

  let cursor = 0;
  while (remaining > 0 && order.length) {
    counts[order[cursor % order.length].index] += 1;
    cursor += 1;
    remaining -= 1;
  }

  return counts;
}

function scoreToStars(score) {
  const halves = Math.round(score * 2);
  const fullStars = Math.floor(halves / 2);
  const hasHalf = halves % 2 === 1;
  return `${STAR.repeat(fullStars)}${hasHalf ? HALF : ""}` || HALF;
}

function getDiscreteRating(index, binCount) {
  return binCount === 10 ? (index + 1) / 2 : index + 1;
}

function binLabel(index, binCount) {
  return scoreToStars(getDiscreteRating(index, binCount));
}

function ratingText(value) {
  if (value === null || value === undefined || value === "") return "";
  return `${Number(value).toFixed(Number(value) % 1 === 0 ? 0 : 1)} ${STAR}`;
}

function distributionFromProbabilities(probabilities, binCount) {
  return probabilities
    .map((probability, index) => ({
      rating: String(getDiscreteRating(index, binCount)),
      percentage: probability * 100,
    }))
    .sort((a, b) => Number(b.rating) - Number(a.rating));
}

function normalizeDistribution(distribution) {
  const cleaned = distribution
    .map((item) => ({
      rating: String(item.rating ?? "").trim(),
      percentage: Number(item.percentage),
    }))
    .filter((item) => item.rating && Number.isFinite(item.percentage) && item.percentage >= 0)
    .sort((a, b) => Number(b.rating) - Number(a.rating));

  return cleaned;
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

  const fuzzy = keys.find((key) =>
    candidates.some((candidate) => key.trim().toLowerCase().includes(candidate.toLowerCase())),
  );
  if (fuzzy && row[fuzzy] !== undefined && row[fuzzy] !== null) return String(row[fuzzy]).trim();
  return "";
}

function parseRating(value) {
  if (!value) return null;
  const cleaned = String(value).trim();
  const numeric = Number(cleaned.replace("/5", "").replace(/stars?/i, "").trim());
  if (Number.isFinite(numeric) && numeric >= 0 && numeric <= 5) return numeric;

  const fullStars = (cleaned.match(/\u2605/g) || []).length;
  const half = /\u00bd|1\/2|\.5/.test(cleaned) ? 0.5 : 0;
  const starRating = fullStars + half;
  if (starRating > 0 && starRating <= 5) return starRating;
  return null;
}

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        field += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      row.push(field);
      field = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(field);
      if (row.some((cell) => cell.trim() !== "")) rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  row.push(field);
  if (row.some((cell) => cell.trim() !== "")) rows.push(row);
  if (!rows.length) return [];

  const headers = rows[0].map((header) => header.replace(/^\uFEFF/, "").trim());
  return rows.slice(1).map((cells) =>
    headers.reduce((record, header, index) => {
      record[header || `Column ${index + 1}`] = cells[index] ?? "";
      return record;
    }, {}),
  );
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

    const seededElo =
      seedFromExistingRatings && importedRating ? INITIAL_ELO + (importedRating - 3) * 115 : INITIAL_ELO;

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
      score:
        7 +
        (3 - film.games) * 1.5 -
        repeats * 2 +
        deterministicJitter(`${film.id}-${opponent.id}`, salt) * 0.3,
    });
  }

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

  const flip = deterministicJitter(`${choice.a.id}-${choice.b.id}`, salt) > 0.5;
  return flip
    ? { left: choice.b, right: choice.a, reason: choice.reason, boundary: choice.boundary }
    : { left: choice.a, right: choice.b, reason: choice.reason, boundary: choice.boundary };
}

function computeReadiness(films, distribution, history) {
  const sorted = sortedFilms(films);
  if (sorted.length < 2) return { score: 0, coverage: 0, boundary: 0, unresolved: [] };

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

function csvEscape(value) {
  const text = String(value ?? "");
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function unparseCsv(rows) {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const lines = [
    headers.map(csvEscape).join(","),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(",")),
  ];
  return lines.join("\r\n");
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

function filmLabel(film) {
  return film.year ? `${film.title} (${film.year})` : film.title;
}

function StatPill({ label, children }) {
  return (
    <div className="rounded-lg border border-slate-700/70 bg-slate-900/80 px-3 py-2 shadow-lg shadow-black/20">
      <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">{label}</div>
      <div className="mt-1 text-sm font-semibold text-slate-100">{children}</div>
    </div>
  );
}

function ControlButton({ active = false, children, onClick, disabled = false }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-45 ${
        active
          ? "border-lime-500/80 bg-lime-500/15 text-lime-100"
          : "border-slate-700/80 bg-slate-900/70 text-slate-300 hover:border-slate-600 hover:bg-slate-800/80"
      }`}
    >
      {children}
    </button>
  );
}

function ProgressBar({ value, color = "bg-lime-400" }) {
  return (
    <div className="h-2 overflow-hidden rounded bg-slate-800">
      <div className={`h-full rounded ${color}`} style={{ width: `${clamp(value, 0, 100)}%` }} />
    </div>
  );
}

function UploadPanel({ onChooseFile, onDropFile, seedFromExistingRatings, setSeedFromExistingRatings, uploadError }) {
  return (
    <section className="rounded-lg border border-slate-800 bg-[#11161d] p-5 shadow-2xl shadow-black/25">
      <div className="mb-4 flex items-center justify-between gap-4">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-500">Import</div>
          <h2 className="mt-1 text-lg font-semibold text-slate-100">Letterboxd CSV</h2>
        </div>
        <ControlButton onClick={onChooseFile}>Choose CSV</ControlButton>
      </div>

      <div
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          onDropFile(event.dataTransfer.files?.[0]);
        }}
        className="grid min-h-36 place-items-center rounded-lg border border-dashed border-slate-700 bg-slate-950/40 p-6 text-center"
      >
        <div>
          <div className="text-sm font-semibold text-slate-200">Drop watched.csv, ratings.csv, or diary.csv</div>
          <div className="mt-2 text-xs text-slate-500">Columns like Name, Year, Rating, and Letterboxd URI are detected.</div>
        </div>
      </div>

      <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-lg border border-slate-800 bg-slate-950/30 p-3 text-sm text-slate-300">
        <input
          type="checkbox"
          checked={seedFromExistingRatings}
          onChange={(event) => setSeedFromExistingRatings(event.target.checked)}
          className="mt-1 h-4 w-4 accent-lime-400"
        />
        <span>
          <span className="block font-semibold text-slate-100">Seed Elo from imported ratings</span>
          <span className="mt-1 block text-xs leading-5 text-slate-500">Ratings and diary exports start closer to your current order.</span>
        </span>
      </label>

      {uploadError ? (
        <div className="mt-4 rounded-lg border border-red-900/80 bg-red-950/40 px-4 py-3 text-sm text-red-200">
          {uploadError}
        </div>
      ) : null}
    </section>
  );
}

function FilmChoiceCard({ film, assignment, onPick, side }) {
  return (
    <button
      type="button"
      onClick={() => onPick(film.id)}
      className="min-h-64 w-full rounded-lg border border-slate-800 bg-slate-950/40 p-5 text-left shadow-lg shadow-black/15 transition hover:-translate-y-0.5 hover:border-lime-500/50 hover:bg-slate-950/65 focus:outline-none focus:ring-2 focus:ring-lime-400/50"
    >
      <div className="flex h-full flex-col justify-between">
        <div>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <span className="rounded bg-slate-800 px-2.5 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-slate-300">
              {side}
            </span>
            <span className="rounded bg-lime-400/10 px-2.5 py-1 text-xs font-semibold text-lime-100">
              {ratingText(assignment?.rating) || "Unassigned"}
            </span>
          </div>
          <h3 className="text-2xl font-semibold tracking-tight text-slate-50">{film.title}</h3>
          <p className="mt-2 text-sm text-slate-500">{film.year || "Year unknown"}</p>
          {film.importedRating ? (
            <p className="mt-3 text-sm text-slate-400">Imported {ratingText(film.importedRating)}</p>
          ) : null}
        </div>

        <div className="mt-8 grid grid-cols-3 gap-2 text-center">
          <div className="rounded bg-slate-900/90 px-3 py-2">
            <div className="text-[10px] uppercase tracking-[0.16em] text-slate-500">Elo</div>
            <div className="mt-1 text-sm font-semibold text-slate-100">{Math.round(film.elo)}</div>
          </div>
          <div className="rounded bg-slate-900/90 px-3 py-2">
            <div className="text-[10px] uppercase tracking-[0.16em] text-slate-500">Matches</div>
            <div className="mt-1 text-sm font-semibold text-slate-100">{film.games}</div>
          </div>
          <div className="rounded bg-slate-900/90 px-3 py-2">
            <div className="text-[10px] uppercase tracking-[0.16em] text-slate-500">Rank</div>
            <div className="mt-1 text-sm font-semibold text-slate-100">#{assignment?.rank ?? "-"}</div>
          </div>
        </div>
      </div>
    </button>
  );
}

function ResultsTable({ films, distribution }) {
  const { sorted, assignments } = useMemo(() => assignmentsFor(films, distribution), [films, distribution]);

  function ratingChanged(film) {
    const assigned = Number(assignments.get(film.id)?.rating);
    return (
      film.importedRating !== null &&
      film.importedRating !== undefined &&
      Number.isFinite(assigned) &&
      assigned !== Number(film.importedRating)
    );
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
    downloadText("letterboxd-updated-ratings.csv", unparseCsv(rows));
  }

  return (
    <section className="rounded-lg border border-slate-800 bg-[#11161d] p-5 shadow-2xl shadow-black/25">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-500">Results</div>
          <h2 className="mt-1 text-lg font-semibold text-slate-100">Updated Letterboxd ratings</h2>
        </div>
        <ControlButton onClick={exportResults} disabled={!sorted.length}>Export CSV</ControlButton>
      </div>

      <div className="max-h-[520px] overflow-auto rounded-lg border border-slate-800">
        <table className="w-full min-w-[820px] text-sm">
          <thead className="sticky top-0 bg-slate-950 text-left text-xs uppercase tracking-[0.16em] text-slate-500">
            <tr>
              <th className="px-4 py-3">Rank</th>
              <th className="px-4 py-3">Film</th>
              <th className="px-4 py-3">Assigned</th>
              <th className="px-4 py-3">Changed</th>
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
                <tr key={film.id} className={`border-t border-slate-800 ${changed ? "bg-amber-950/30" : ""}`}>
                  <td className="px-4 py-3 font-semibold text-slate-200">#{assignment?.rank}</td>
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-100">{film.title}</div>
                    <div className="text-xs text-slate-500">{film.year || "Year unknown"}</div>
                  </td>
                  <td className="px-4 py-3">
                    <span className="rounded bg-lime-400/10 px-2.5 py-1 text-xs font-semibold text-lime-100">
                      {ratingText(assignment?.rating)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-400">{changed ? "Yes" : film.importedRating ? "No" : "-"}</td>
                  <td className="px-4 py-3 text-slate-300">{Math.round(film.elo)}</td>
                  <td className="px-4 py-3 text-slate-300">{film.games}</td>
                  <td className="px-4 py-3 text-slate-300">
                    {film.wins}-{film.losses}
                  </td>
                  <td className={`px-4 py-3 ${changed ? "font-semibold text-amber-100" : "text-slate-400"}`}>
                    {film.importedRating ? ratingText(film.importedRating) : "-"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function App() {
  const [points, setPoints] = useState(() => makePreset("normal"));
  const [allowHalfStars, setAllowHalfStars] = useState(true);
  const binCount = allowHalfStars ? 10 : 5;
  const [sampleSize, setSampleSize] = useState(100);
  const [hoveredBin, setHoveredBin] = useState(null);
  const [presetName, setPresetName] = useState("normal");
  const [activePointIndex, setActivePointIndex] = useState(null);
  const [films, setFilms] = useState([]);
  const [history, setHistory] = useState([]);
  const [seedFromExistingRatings, setSeedFromExistingRatings] = useState(true);
  const [uploadError, setUploadError] = useState("");

  const curveRef = useRef(null);
  const draggingPointRef = useRef(null);
  const fileInputRef = useRef(null);

  const densitySamples = useMemo(() => sampleDensity(points, 280), [points]);
  const probabilities = useMemo(() => getBinProbabilities(points, binCount), [points, binCount]);
  const distribution = useMemo(() => distributionFromProbabilities(probabilities, binCount), [probabilities, binCount]);
  const { assignments, quotas, sorted } = useMemo(() => assignmentsFor(films, distribution), [films, distribution]);
  const nextPair = useMemo(() => chooseNextPair(films, distribution, history), [films, distribution, history]);
  const readiness = useMemo(() => computeReadiness(films, distribution, history), [films, distribution, history]);
  const distributionMovieCount = sorted.length || Math.max(0, Number(sampleSize) || 0);
  const counts = useMemo(
    () => largestRemainderRound(probabilities, distributionMovieCount),
    [probabilities, distributionMovieCount],
  );

  const dominantBin = counts.indexOf(Math.max(...counts));
  const rawActiveBin = hoveredBin ?? dominantBin;
  const activeBin = clamp(rawActiveBin, 0, binCount - 1);
  const totalCount = counts.reduce((sum, value) => sum + value, 0);
  const matchCount = history.filter((item) => !item.skipped).length;
  const activeFilmCount = sorted.length;

  const expectedMean = useMemo(() => {
    return probabilities.reduce((sum, probability, index) => {
      const center = ((index + 0.5) / binCount) * 5;
      return sum + center * probability;
    }, 0);
  }, [probabilities, binCount]);

  const curvePadding = 26;
  const curvePoints = useMemo(
    () => getScreenPoints(densitySamples, CURVE_W, CURVE_H, curvePadding, CURVE_Y_MAX),
    [densitySamples],
  );
  const curveLinePath = useMemo(() => smoothSvgPath(curvePoints), [curvePoints]);
  const curveAreaPath = useMemo(() => {
    if (!curvePoints.length) return "";
    const first = curvePoints[0];
    const last = curvePoints[curvePoints.length - 1];
    const baselineY = CURVE_H - curvePadding;
    return `${curveLinePath} L ${last.x} ${baselineY} L ${first.x} ${baselineY} Z`;
  }, [curveLinePath, curvePoints]);

  const barPadding = { top: 52, right: 28, bottom: 26, left: 28 };
  const barPlotWidth = BAR_W - barPadding.left - barPadding.right;
  const barPlotHeight = BAR_H - barPadding.top - barPadding.bottom;
  const barGap = Math.max(4, Math.min(8, 24 / Math.max(1, binCount / 2)));
  const barWidth = (barPlotWidth - (binCount - 1) * barGap) / binCount;
  const maxProbability = Math.max(...probabilities, 0.001);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (saved?.points?.length) setPoints(saved.points);
      if (typeof saved?.allowHalfStars === "boolean") setAllowHalfStars(saved.allowHalfStars);
      if (saved?.presetName) setPresetName(saved.presetName);
      if (Number.isFinite(saved?.sampleSize)) setSampleSize(saved.sampleSize);
      if (saved?.films?.length) setFilms(saved.films);
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
        JSON.stringify({
          points,
          allowHalfStars,
          presetName,
          sampleSize,
          films,
          history,
          seedFromExistingRatings,
        }),
      );
    } catch {
      // Local storage can be unavailable in private contexts.
    }
  }, [points, allowHalfStars, presetName, sampleSize, films, history, seedFromExistingRatings]);

  function applyPreset(kind) {
    setPresetName(kind);
    setPoints(makePreset(kind));
    setActivePointIndex(null);
  }

  function getSvgCoords(clientX, clientY) {
    if (!curveRef.current) return null;
    const rect = curveRef.current.getBoundingClientRect();
    return {
      x: ((clientX - rect.left) / rect.width) * CURVE_W,
      y: ((clientY - rect.top) / rect.height) * CURVE_H,
    };
  }

  function getPointScreenPosition(point) {
    return {
      x: curvePadding + point.x * (CURVE_W - curvePadding * 2),
      y: CURVE_H - curvePadding - (clamp(point.y, 0, CURVE_Y_MAX) / CURVE_Y_MAX) * (CURVE_H - curvePadding * 2),
    };
  }

  function findNearestControlPoint(clientX, clientY) {
    const coords = getSvgCoords(clientX, clientY);
    if (!coords) return null;

    let closest = null;
    let closestDistance = Infinity;

    points.forEach((point, index) => {
      const screenPoint = getPointScreenPosition(point);
      const distance = Math.hypot(screenPoint.x - coords.x, screenPoint.y - coords.y);
      if (distance < closestDistance) {
        closest = index;
        closestDistance = distance;
      }
    });

    return closestDistance <= 24 ? closest : null;
  }

  function updateActiveBinFromCurve(clientX) {
    if (!curveRef.current) return;
    const rect = curveRef.current.getBoundingClientRect();
    const x = clamp((clientX - rect.left) / rect.width, 0, 0.999999);
    setHoveredBin(Math.floor(x * binCount));
  }

  function moveControlPoint(pointIndex, clientX, clientY) {
    const coords = getSvgCoords(clientX, clientY);
    if (!coords) return;

    const x = clamp((coords.x - curvePadding) / (CURVE_W - curvePadding * 2), 0, 1);
    const y = clamp(coords.y, curvePadding, CURVE_H - curvePadding);
    const newDensity = Math.max(
      MIN_DENSITY,
      ((CURVE_H - curvePadding - y) / (CURVE_H - curvePadding * 2)) * CURVE_Y_MAX,
    );

    setPresetName("custom");
    setPoints((prev) => {
      const currentPoint = prev[pointIndex] ?? { x, y: newDensity };
      const deltaY = newDensity - currentPoint.y;

      const edited = prev.map((point, index) => {
        if (index === pointIndex) {
          return {
            ...point,
            x,
            y: newDensity,
          };
        }

        const distance = Math.abs(index - pointIndex);
        const influence = Math.exp(-(distance * distance) / (2 * SOFT_SELECT_RADIUS * SOFT_SELECT_RADIUS));
        const softenedInfluence = influence * 0.9;

        return {
          ...point,
          y: clamp(point.y + deltaY * softenedInfluence, MIN_DENSITY, CURVE_Y_MAX),
        };
      });

      return repartitionPointXs(edited, pointIndex);
    });
  }

  function handlePointerDown(event) {
    updateActiveBinFromCurve(event.clientX);
    const pointIndex = findNearestControlPoint(event.clientX, event.clientY);
    if (pointIndex === null) return;

    draggingPointRef.current = pointIndex;
    setActivePointIndex(pointIndex);
    curveRef.current?.setPointerCapture?.(event.pointerId);
    moveControlPoint(pointIndex, event.clientX, event.clientY);
  }

  function handlePointerMove(event) {
    updateActiveBinFromCurve(event.clientX);

    if (draggingPointRef.current !== null) {
      moveControlPoint(draggingPointRef.current, event.clientX, event.clientY);
      return;
    }

    setActivePointIndex(findNearestControlPoint(event.clientX, event.clientY));
  }

  function stopDragging(event) {
    draggingPointRef.current = null;
    curveRef.current?.releasePointerCapture?.(event.pointerId);
  }

  async function handleFile(file) {
    setUploadError("");
    if (!file) return;

    try {
      const text = await file.text();
      const rows = parseCsvRows(text);
      const parsedFilms = parseFilmsFromRows(rows, seedFromExistingRatings);
      if (parsedFilms.length < 2) {
        setUploadError("Fewer than 2 films were found. Check that the CSV includes a Name or Title column.");
        return;
      }
      setFilms(parsedFilms);
      setHistory([]);
      setSampleSize(parsedFilms.length);
    } catch (error) {
      setUploadError(error?.message || "Could not parse that CSV.");
    }
  }

  const handlePick = useCallback(
    (winnerId) => {
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
              [winnerId]: {
                elo: winner.elo,
                games: winner.games,
                wins: winner.wins,
                losses: winner.losses,
                lastPlayedAt: winner.lastPlayedAt,
              },
              [loserId]: {
                elo: loser.elo,
                games: loser.games,
                wins: loser.wins,
                losses: loser.losses,
                lastPlayedAt: loser.lastPlayedAt,
              },
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
    },
    [nextPair],
  );

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
  }, [handlePick, nextPair]);

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

  function reshufflePair() {
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

  function clearImportedFilms() {
    setFilms([]);
    setHistory([]);
    setUploadError("");
  }

  const activeBarCenter = barPadding.left + activeBin * (barWidth + barGap) + barWidth / 2;
  const activePercent = Math.round(probabilities[activeBin] * 100);
  const activeCount = counts[activeBin];
  const activeHeight = (probabilities[activeBin] / maxProbability) * barPlotHeight;
  const tooltipY = barPadding.top + (barPlotHeight - activeHeight) - 18;
  const activeTooltipText = `${numberFormatter.format(activeCount)} ${binLabel(activeBin, binCount)} (${activePercent}%)`;
  const tooltipWidth = Math.max(112, activeTooltipText.length * 7.2 + 24);
  const tooltipHeight = 36;

  return (
    <div className="min-h-screen bg-[#0b1016] px-4 py-6 text-slate-100 md:px-6 md:py-8">
      <input
        ref={fileInputRef}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={(event) => {
          handleFile(event.target.files?.[0]);
          event.target.value = "";
        }}
      />

      <div className="mx-auto max-w-7xl">
        <header className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.28em] text-lime-400/80">
              Letterboxd Ratings Lab
            </div>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-50 md:text-4xl">
              Shape the curve, then rank the films.
            </h1>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatPill label="Curve">{presetName === "custom" ? "Custom" : presetName}</StatPill>
            <StatPill label="Average">{expectedMean.toFixed(2)} {STAR}</StatPill>
            <StatPill label="Films">{numberFormatter.format(activeFilmCount || totalCount)}</StatPill>
            <StatPill label="Matches">{numberFormatter.format(matchCount)}</StatPill>
          </div>
        </header>

        <div className="mb-6 grid gap-6 xl:grid-cols-[1.24fr_0.76fr]">
          <section className="rounded-lg border border-slate-800 bg-[#11161d] p-5 shadow-2xl shadow-black/25">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-500">Curve editor</div>
                <h2 className="mt-1 text-lg font-semibold text-slate-100">Target rating distribution</h2>
              </div>
              <div className="flex flex-wrap gap-2">
                <ControlButton active={presetName === "normal"} onClick={() => applyPreset("normal")}>
                  Normal
                </ControlButton>
                <ControlButton active={presetName === "left"} onClick={() => applyPreset("left")}>
                  Left skew
                </ControlButton>
                <ControlButton active={presetName === "right"} onClick={() => applyPreset("right")}>
                  Right skew
                </ControlButton>
                <ControlButton active={presetName === "bimodal"} onClick={() => applyPreset("bimodal")}>
                  Bimodal
                </ControlButton>
                <ControlButton
                  onClick={() => {
                    setPresetName("custom");
                    setPoints((prev) => smoothPoints(prev, 2));
                  }}
                >
                  Smooth
                </ControlButton>
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-[1fr_220px]">
              <div className="rounded-lg border border-slate-800/90 bg-[#0d1319] p-3">
                <svg
                  ref={curveRef}
                  viewBox={`0 0 ${CURVE_W} ${CURVE_H}`}
                  className="w-full cursor-default touch-none select-none"
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={stopDragging}
                  onPointerLeave={(event) => {
                    stopDragging(event);
                    setHoveredBin(null);
                    setActivePointIndex(null);
                  }}
                  onPointerCancel={stopDragging}
                >
                  <defs>
                    <linearGradient id="curveFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#a3e635" stopOpacity="0.44" />
                      <stop offset="100%" stopColor="#a3e635" stopOpacity="0.05" />
                    </linearGradient>
                    <linearGradient id="glowStroke" x1="0" y1="0" x2="1" y2="0">
                      <stop offset="0%" stopColor="#64748b" />
                      <stop offset="50%" stopColor="#bef264" />
                      <stop offset="100%" stopColor="#64748b" />
                    </linearGradient>
                  </defs>

                  <rect x="0" y="0" width={CURVE_W} height={CURVE_H} rx="8" fill="#0d1319" />
                  <line
                    x1={curvePadding}
                    x2={CURVE_W - curvePadding}
                    y1={CURVE_H - curvePadding}
                    y2={CURVE_H - curvePadding}
                    stroke="#334155"
                    strokeWidth="1.5"
                  />
                  <line
                    x1={curvePadding}
                    x2={CURVE_W - curvePadding}
                    y1={curvePadding}
                    y2={curvePadding}
                    stroke="#1f2937"
                    strokeWidth="1"
                  />

                  <rect
                    x={curvePadding + (activeBin / binCount) * (CURVE_W - curvePadding * 2)}
                    y={curvePadding}
                    width={(CURVE_W - curvePadding * 2) / binCount}
                    height={CURVE_H - curvePadding * 2}
                    fill="#bef264"
                    opacity="0.08"
                  />

                  <path d={curveAreaPath} fill="url(#curveFill)" />
                  <path
                    d={curveLinePath}
                    fill="none"
                    stroke="url(#glowStroke)"
                    strokeWidth="4"
                    strokeLinecap="round"
                  />
                  <path d={curveLinePath} fill="none" stroke="#f8fafc" strokeOpacity="0.5" strokeWidth="1.4" />

                  {points.map((point, index) => {
                    const screenPoint = getPointScreenPosition(point);
                    const inHighlightedBin = point.x >= activeBin / binCount && point.x <= (activeBin + 1) / binCount;
                    const isActivePoint = index === activePointIndex;

                    return (
                      <g key={index} className="cursor-grab active:cursor-grabbing">
                        <circle cx={screenPoint.x} cy={screenPoint.y} r="15" fill="transparent" />
                        <circle
                          cx={screenPoint.x}
                          cy={screenPoint.y}
                          r={isActivePoint ? 7 : inHighlightedBin ? 5.5 : 4.5}
                          fill={isActivePoint ? "#bef264" : inHighlightedBin ? "#e5e7eb" : "#94a3b8"}
                          stroke={isActivePoint ? "#365314" : "#111827"}
                          strokeWidth="2"
                          opacity="0.96"
                        />
                      </g>
                    );
                  })}

                  <text x={curvePadding} y={20} fill="#64748b" fontSize="11" letterSpacing="2">
                    LOW RATINGS
                  </text>
                  <text x={CURVE_W - curvePadding - 88} y={20} fill="#64748b" fontSize="11" letterSpacing="2">
                    HIGH RATINGS
                  </text>
                  <text x={curvePadding} y={CURVE_H - 8} fill="#bef264" fontSize="20">
                    {STAR}
                  </text>
                  <text x={CURVE_W - curvePadding - 64} y={CURVE_H - 8} fill="#bef264" fontSize="20">
                    {STAR.repeat(5)}
                  </text>
                </svg>
              </div>

              <div className="space-y-3">
                <label className="flex items-center gap-3 rounded-lg border border-slate-800 bg-slate-950/30 px-4 py-3 text-sm text-slate-300">
                  <input
                    type="checkbox"
                    checked={allowHalfStars}
                    onChange={(event) => setAllowHalfStars(event.target.checked)}
                    className="h-4 w-4 accent-lime-400"
                  />
                  <span>Half-star steps</span>
                </label>

                <label className="block rounded-lg border border-slate-800 bg-slate-950/30 px-4 py-3 text-sm text-slate-300">
                  <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                    Preview count
                  </span>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={sampleSize}
                    onChange={(event) => setSampleSize(Math.max(0, Number(event.target.value) || 0))}
                    className="w-full rounded border border-slate-700 bg-slate-900/90 px-3 py-2 text-sm text-slate-100 outline-none ring-0 focus:border-lime-500/70"
                  />
                </label>

                <div className="rounded-lg border border-slate-800 bg-slate-950/30 px-4 py-3">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                    Selected rating
                  </div>
                  <div className="mt-1 text-lg font-semibold text-slate-100">{binLabel(activeBin, binCount)}</div>
                  <div className="mt-2 text-sm text-slate-400">
                    {numberFormatter.format(activeCount)} films, {(probabilities[activeBin] * 100).toFixed(1)}%
                  </div>
                </div>

                <div className="rounded-lg border border-slate-800 bg-slate-950/30 px-4 py-3">
                  <div className="mb-2 flex justify-between text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                    <span>Clarity</span>
                    <span>{readiness.score}%</span>
                  </div>
                  <ProgressBar value={readiness.score} />
                </div>
              </div>
            </div>
          </section>

          <UploadPanel
            onChooseFile={() => fileInputRef.current?.click()}
            onDropFile={handleFile}
            seedFromExistingRatings={seedFromExistingRatings}
            setSeedFromExistingRatings={setSeedFromExistingRatings}
            uploadError={uploadError}
          />
        </div>

        <div className="mb-6 grid gap-6 xl:grid-cols-2">
          <section className="rounded-lg border border-slate-800 bg-[#11161d] p-5 shadow-2xl shadow-black/25">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <div className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-500">Distribution</div>
                <h2 className="mt-1 text-lg font-semibold text-slate-100">Curve quotas</h2>
              </div>
              <div className="text-sm text-slate-400">{numberFormatter.format(totalCount)} films</div>
            </div>

            <div className="relative rounded-lg border border-slate-800/90 bg-[#0d1319] p-3">
              <svg
                viewBox={`0 0 ${BAR_W} ${BAR_H}`}
                className="w-full overflow-visible"
                onMouseLeave={() => setHoveredBin(null)}
              >
                <rect x="0" y="0" width={BAR_W} height={BAR_H} rx="8" fill="#0d1319" />

                <text x={barPadding.left} y="34" fill="#cbd5e1" fontSize="18" fontWeight="700" letterSpacing="3">
                  RATINGS
                </text>
                <text x={BAR_W - barPadding.right} y="34" fill="#94a3b8" fontSize="16" textAnchor="end">
                  {numberFormatter.format(totalCount)}
                </text>
                <line
                  x1={barPadding.left}
                  x2={BAR_W - barPadding.right}
                  y1="52"
                  y2="52"
                  stroke="#475569"
                  strokeOpacity="0.55"
                  strokeWidth="1.6"
                />

                {probabilities.map((probability, index) => {
                  const height = (probability / maxProbability) * barPlotHeight;
                  const x = barPadding.left + index * (barWidth + barGap);
                  const y = barPadding.top + (barPlotHeight - height);
                  const isActive = index === activeBin;
                  const count = counts[index];

                  return (
                    <g
                      key={index}
                      onMouseEnter={() => setHoveredBin(index)}
                      onMouseMove={() => setHoveredBin(index)}
                      className="cursor-pointer"
                    >
                      <rect
                        x={x}
                        y={y}
                        rx="4"
                        width={barWidth}
                        height={height}
                        fill={isActive ? "#bef264" : "#64748b"}
                      />
                      <text
                        x={x + barWidth / 2}
                        y={Math.max(72, y - 8)}
                        textAnchor="middle"
                        fill={isActive ? "#ecfccb" : "#94a3b8"}
                        fontSize="10"
                        fontWeight="600"
                      >
                        {count}
                      </text>
                    </g>
                  );
                })}

                <line
                  x1={barPadding.left}
                  x2={BAR_W - barPadding.right}
                  y1={BAR_H - barPadding.bottom}
                  y2={BAR_H - barPadding.bottom}
                  stroke="#475569"
                  strokeOpacity="0.55"
                  strokeWidth="2"
                />
                <text x={barPadding.left} y={BAR_H - 8} fill="#bef264" fontSize="20">
                  {STAR}
                </text>
                <text x={BAR_W - barPadding.right - 64} y={BAR_H - 8} fill="#bef264" fontSize="20">
                  {STAR.repeat(5)}
                </text>
                <g transform={`translate(${activeBarCenter}, ${Math.max(8, tooltipY)})`} className="pointer-events-none">
                  <rect
                    x={-tooltipWidth / 2}
                    y={0}
                    width={tooltipWidth}
                    height={tooltipHeight}
                    rx="8"
                    fill="#334155"
                  />
                  <polygon points={`-6,${tooltipHeight - 2} 6,${tooltipHeight - 2} 0,${tooltipHeight + 8}`} fill="#334155" />
                  <text x="0" y="23" textAnchor="middle" fill="#f8fafc" fontSize="13" fontWeight="700">
                    {activeTooltipText}
                  </text>
                </g>
              </svg>
            </div>
          </section>

          <section className="rounded-lg border border-slate-800 bg-[#11161d] p-5 shadow-2xl shadow-black/25">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-500">Current quotas</div>
                <h2 className="mt-1 text-lg font-semibold text-slate-100">Ratings from the curve</h2>
              </div>
              <div className="text-sm text-slate-400">{binCount} steps</div>
            </div>
            <div className="grid gap-2">
              {quotas.map((bucket) => (
                <div key={bucket.rating} className="grid grid-cols-[64px_1fr_56px] items-center gap-3 text-sm">
                  <div className="font-semibold text-slate-200">{ratingText(bucket.rating)}</div>
                  <div className="h-2 overflow-hidden rounded bg-slate-800">
                    <div
                      className="h-full rounded bg-lime-400"
                      style={{ width: `${activeFilmCount ? (bucket.quota / activeFilmCount) * 100 : bucket.percentage}%` }}
                    />
                  </div>
                  <div className="text-right text-slate-400">
                    {activeFilmCount ? bucket.quota : `${bucket.percentage.toFixed(1)}%`}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>

        {films.length ? (
          <div className="space-y-6">
            <div className="grid gap-6 xl:grid-cols-[1.35fr_0.65fr]">
              <section className="rounded-lg border border-slate-800 bg-[#11161d] p-5 shadow-2xl shadow-black/25">
                <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-500">Compare</div>
                    <h2 className="mt-1 text-lg font-semibold text-slate-100">Next head-to-head</h2>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <ControlButton onClick={undoLast} disabled={!history.length}>Undo</ControlButton>
                    <ControlButton onClick={reshufflePair} disabled={!nextPair}>Skip pair</ControlButton>
                    <ControlButton onClick={() => fileInputRef.current?.click()}>Upload different CSV</ControlButton>
                  </div>
                </div>

                {nextPair ? (
                  <div key={`${nextPair.left.id}-${nextPair.right.id}-${history.length}`} className="grid gap-4 md:grid-cols-2">
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
                ) : (
                  <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-8 text-center text-slate-400">
                    Not enough films to compare.
                  </div>
                )}
              </section>

              <aside className="space-y-6">
                <section className="rounded-lg border border-slate-800 bg-[#11161d] p-5 shadow-2xl shadow-black/25">
                  <div className="mb-4 flex items-center justify-between gap-4">
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-500">Session</div>
                      <h2 className="mt-1 text-lg font-semibold text-slate-100">{numberFormatter.format(activeFilmCount)} films</h2>
                    </div>
                    <ControlButton onClick={clearImportedFilms}>Clear</ControlButton>
                  </div>
                  <div className="space-y-4">
                    <div>
                      <div className="mb-2 flex justify-between text-sm text-slate-400">
                        <span>Overall clarity</span>
                        <span>{readiness.score}%</span>
                      </div>
                      <ProgressBar value={readiness.score} />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="rounded-lg border border-slate-800 bg-slate-950/30 px-4 py-3">
                        <div className="text-2xl font-semibold text-slate-100">{matchCount}</div>
                        <div className="text-xs text-slate-500">Elo matches</div>
                      </div>
                      <div className="rounded-lg border border-slate-800 bg-slate-950/30 px-4 py-3">
                        <div className="text-2xl font-semibold text-slate-100">{readiness.coverage}%</div>
                        <div className="text-xs text-slate-500">3+ match coverage</div>
                      </div>
                    </div>
                    {readiness.unresolved.length ? (
                      <div className="rounded-lg border border-amber-900/70 bg-amber-950/25 p-4 text-sm text-amber-100">
                        <div className="font-semibold">Low-signal cut lines</div>
                        <div className="mt-2 space-y-1 text-amber-100/80">
                          {readiness.unresolved.slice(0, 4).map((item) => (
                            <div key={`${item.above}-${item.below}`} className="flex justify-between gap-3">
                              <span>
                                {ratingText(item.above)} / {ratingText(item.below)}
                              </span>
                              <span>gap {Math.round(item.gap)}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <div className="rounded-lg border border-emerald-900/70 bg-emerald-950/25 p-4 text-sm text-emerald-100">
                        Rating boundaries look stable.
                      </div>
                    )}
                  </div>
                </section>
              </aside>
            </div>

            <ResultsTable films={films} distribution={distribution} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
