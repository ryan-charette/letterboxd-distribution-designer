import React, { useMemo, useRef, useState } from "react";

const numberFormatter = new Intl.NumberFormat();
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
    1 - (lastIndex - anchorIndex) * MIN_POINT_GAP
  );

  // Keep the selected point exactly where the user dragged it, then evenly space
  // the handles on each side. This prevents bunching on one side and sparse,
  // jagged sections on the other.
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
  return `${"★".repeat(fullStars)}${hasHalf ? "½" : ""}` || "½";
}

function getDiscreteRating(index, binCount) {
  return binCount === 10 ? (index + 1) / 2 : index + 1;
}

function binLabel(index, binCount) {
  return scoreToStars(getDiscreteRating(index, binCount));
}

function StatPill({ label, children }) {
  return (
    <div className="rounded-2xl border border-slate-700/70 bg-slate-900/80 px-3 py-2 shadow-lg shadow-black/20">
      <div className="text-[10px] uppercase tracking-[0.24em] text-slate-500">{label}</div>
      <div className="mt-1 text-sm font-semibold text-slate-100">{children}</div>
    </div>
  );
}

function ControlButton({ active = false, children, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full border px-3 py-1.5 text-xs font-medium tracking-wide transition ${
        active
          ? "border-slate-500 bg-slate-700/80 text-slate-50"
          : "border-slate-700/80 bg-slate-900/70 text-slate-300 hover:border-slate-600 hover:bg-slate-800/80"
      }`}
    >
      {children}
    </button>
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

  const curveRef = useRef(null);
  const draggingPointRef = useRef(null);

  const densitySamples = useMemo(() => sampleDensity(points, 280), [points]);
  const probabilities = useMemo(() => getBinProbabilities(points, binCount), [points, binCount]);
  const counts = useMemo(
    () => largestRemainderRound(probabilities, Math.max(0, Number(sampleSize) || 0)),
    [probabilities, sampleSize]
  );

  const dominantBin = counts.indexOf(Math.max(...counts));
  const rawActiveBin = hoveredBin ?? dominantBin;
  const activeBin = clamp(rawActiveBin, 0, binCount - 1);
  const totalCount = counts.reduce((sum, value) => sum + value, 0);

  const expectedMean = useMemo(() => {
    return probabilities.reduce((sum, probability, index) => {
      const center = ((index + 0.5) / binCount) * 5;
      return sum + center * probability;
    }, 0);
  }, [probabilities, binCount]);

  const curvePadding = 26;
  const curvePoints = useMemo(
    () => getScreenPoints(densitySamples, CURVE_W, CURVE_H, curvePadding, CURVE_Y_MAX),
    [densitySamples]
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
      ((CURVE_H - curvePadding - y) / (CURVE_H - curvePadding * 2)) * CURVE_Y_MAX
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

  const activeBarCenter = barPadding.left + activeBin * (barWidth + barGap) + barWidth / 2;
  const activePercent = Math.round(probabilities[activeBin] * 100);
  const activeCount = counts[activeBin];
  const activeHeight = (probabilities[activeBin] / maxProbability) * barPlotHeight;
  const tooltipY = barPadding.top + (barPlotHeight - activeHeight) - 18;
  const activeTooltipText = `${numberFormatter.format(activeCount)} ${binLabel(activeBin, binCount)} ratings (${activePercent}%)`;
  const tooltipWidth = Math.max(132, activeTooltipText.length * 7.2 + 28);
  const tooltipHeight = 38;

  return (
    <div className="min-h-screen bg-[#0b1016] px-5 py-8 text-slate-100">
      <div className="mx-auto max-w-7xl">
        <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.32em] text-slate-500">
              Letterboxd Distribution Designer
            </div>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-50">
              Design your perfect Letterboxd ratings chart
            </h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-400">
              Drag the dots on the curve to choose which ratings should be common. Move a peak left or right to shift your favorite rating range; the other handles rebalance around it. The bars update live,
              showing how many movies land at each rating.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatPill label="Shape">{presetName === "custom" ? "Custom" : presetName}</StatPill>
            <StatPill label="Average rating">{expectedMean.toFixed(2)}★</StatPill>
            <StatPill label="Rating steps">{binCount}</StatPill>
            <StatPill label="Movies">{numberFormatter.format(totalCount)}</StatPill>
          </div>
        </div>

        <div className="mb-6 rounded-[28px] border border-slate-800 bg-[#11161d] p-4 shadow-2xl shadow-black/30">
          <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
            <div className="rounded-[24px] border border-slate-800/90 bg-slate-950/30 p-4">
              <div className="flex flex-wrap items-center gap-2">
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
                <ControlButton onClick={() => applyPreset("normal")}>Reset</ControlButton>
              </div>

              <div className="mt-5 flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                <label className="flex items-center gap-3 rounded-2xl border border-slate-800 bg-slate-950/30 px-4 py-3 text-xs font-medium uppercase tracking-[0.22em] text-slate-500">
                  <input
                    type="checkbox"
                    checked={allowHalfStars}
                    onChange={(event) => setAllowHalfStars(event.target.checked)}
                    className="h-4 w-4 accent-slate-300"
                  />
                  <span>Allow half-star ratings</span>
                </label>

                <label className="flex flex-col gap-2 text-xs font-medium uppercase tracking-[0.22em] text-slate-500">
                  Number of movies
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={sampleSize}
                    onChange={(event) => setSampleSize(Math.max(0, Number(event.target.value) || 0))}
                    className="w-40 rounded-xl border border-slate-700 bg-slate-900/90 px-3 py-2 text-sm text-slate-100 outline-none ring-0"
                  />
                </label>

                <div className="max-w-xs rounded-2xl border border-slate-800 bg-slate-950/30 px-4 py-3 text-sm leading-6 text-slate-400">
                  <div className="text-xs font-medium uppercase tracking-[0.22em] text-slate-500">Move the curve</div>
                  <div className="mt-1">
                    Drag a dot up or down to change how common that rating is. Drag it left or right to shift that part of the curve. The handles on each side automatically spread themselves out, so the curve stays smooth.
                  </div>
                </div>
              </div>
            </div>

            <div className="rounded-[24px] border border-slate-800/90 bg-slate-950/30 p-4">
              <div className="text-xs font-semibold uppercase tracking-[0.28em] text-slate-500">How to Use</div>
              <div className="mt-3 space-y-3 text-sm leading-6 text-slate-400">
                <p>
                  Obsessed with having a pretty rating distribution on Letterboxd? Same. Start with a preset, then drag the dots around until the curve matches your taste.
                </p>
                <p>
                  Taller parts of the curve mean you hand out that rating more often. Shorter parts mean those ratings are rarer. The bars translate the shape into actual movie counts.
                </p>
                <p className="text-slate-300">
                  Enter your number of movies, keep half-stars on for the classic Letterboxd feel, and tune the curve until it looks just right.
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="grid gap-6 xl:grid-cols-2">
          <section className="rounded-[30px] border border-slate-800 bg-[#11161d] p-5 shadow-2xl shadow-black/25">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <div className="text-xs font-semibold uppercase tracking-[0.28em] text-slate-500">Curve editor</div>
                <div className="mt-1 text-lg font-semibold text-slate-100">Drag the dots around to shape your ratings</div>
              </div>
              <div className="text-sm text-slate-400">Rating: {binLabel(activeBin, binCount)}</div>
            </div>

            <div className="rounded-[26px] border border-slate-800/90 bg-[#0d1319] p-3">
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
                    <stop offset="0%" stopColor="#94a3b8" stopOpacity="0.55" />
                    <stop offset="100%" stopColor="#94a3b8" stopOpacity="0.06" />
                  </linearGradient>
                  <linearGradient id="glowStroke" x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0%" stopColor="#7f8ea7" />
                    <stop offset="50%" stopColor="#d3d9e5" />
                    <stop offset="100%" stopColor="#7f8ea7" />
                  </linearGradient>
                </defs>

                <rect x="0" y="0" width={CURVE_W} height={CURVE_H} rx="24" fill="#0d1319" />
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
                  fill="#a7b2c6"
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
                <path d={curveLinePath} fill="none" stroke="#edf2f7" strokeOpacity="0.6" strokeWidth="1.4" />

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
                        fill={isActivePoint ? "#65d23a" : inHighlightedBin ? "#e5e7eb" : "#94a3b8"}
                        stroke={isActivePoint ? "#e5f9dd" : "#111827"}
                        strokeWidth="2"
                        opacity="0.96"
                      />
                    </g>
                  );
                })}

                <text x={curvePadding} y={20} fill="#64748b" fontSize="11" letterSpacing="2.2">
                  RATING SHAPE
                </text>
                <text x={curvePadding} y={CURVE_H - 8} fill="#65d23a" fontSize="20">
                  ★
                </text>
                <text x={CURVE_W - curvePadding - 56} y={CURVE_H - 8} fill="#65d23a" fontSize="20">
                  ★★★★★
                </text>
              </svg>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <div className="rounded-2xl border border-slate-800/90 bg-slate-950/30 px-4 py-3">
                <div className="text-[10px] uppercase tracking-[0.24em] text-slate-500">Selected rating</div>
                <div className="mt-1 text-sm font-semibold text-slate-100">{binLabel(activeBin, binCount)}</div>
              </div>
              <div className="rounded-2xl border border-slate-800/90 bg-slate-950/30 px-4 py-3">
                <div className="text-[10px] uppercase tracking-[0.24em] text-slate-500">Share of movies</div>
                <div className="mt-1 text-sm font-semibold text-slate-100">{(probabilities[activeBin] * 100).toFixed(1)}%</div>
              </div>
              <div className="rounded-2xl border border-slate-800/90 bg-slate-950/30 px-4 py-3">
                <div className="text-[10px] uppercase tracking-[0.24em] text-slate-500">Movies at this rating</div>
                <div className="mt-1 text-sm font-semibold text-slate-100">{numberFormatter.format(activeCount)}</div>
              </div>
            </div>
          </section>

          <section className="rounded-[30px] border border-slate-800 bg-[#11161d] p-5 shadow-2xl shadow-black/25">
            <div className="relative rounded-[26px] border border-slate-800/90 bg-[#0d1319] p-3">
              <svg
                viewBox={`0 0 ${BAR_W} ${BAR_H}`}
                className="w-full overflow-visible"
                onMouseLeave={() => setHoveredBin(null)}
              >
                <rect x="0" y="0" width={BAR_W} height={BAR_H} rx="24" fill="#0d1319" />

                <text
                  x={barPadding.left}
                  y="34"
                  fill="#c4cfdf"
                  fontSize="18"
                  fontWeight="700"
                  letterSpacing="4"
                >
                  RATINGS
                </text>
                <text
                  x={BAR_W - barPadding.right}
                  y="34"
                  fill="#8ea0bb"
                  fontSize="16"
                  textAnchor="end"
                  letterSpacing="2"
                >
                  {numberFormatter.format(totalCount)}
                </text>
                <line
                  x1={barPadding.left}
                  x2={BAR_W - barPadding.right}
                  y1="52"
                  y2="52"
                  stroke="#617086"
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
                        fill={isActive ? "#a3adbd" : "#56657e"}
                      />
                      <text
                        x={x + barWidth / 2}
                        y={Math.max(72, y - 8)}
                        textAnchor="middle"
                        fill={isActive ? "#edf2f7" : "#94a3b8"}
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
                  stroke="#5d7087"
                  strokeOpacity="0.55"
                  strokeWidth="2"
                />
                <text x={barPadding.left} y={BAR_H - 8} fill="#65d23a" fontSize="20">
                  ★
                </text>
                <text x={BAR_W - barPadding.right - 56} y={BAR_H - 8} fill="#65d23a" fontSize="20">
                  ★★★★★
                </text>
                <g transform={`translate(${activeBarCenter}, ${Math.max(8, tooltipY)})`} className="pointer-events-none">
                  <rect
                    x={-tooltipWidth / 2}
                    y={0}
                    width={tooltipWidth}
                    height={tooltipHeight}
                    rx="14"
                    fill="#5e7088"
                  />
                  <polygon points={`-6,${tooltipHeight - 2} 6,${tooltipHeight - 2} 0,${tooltipHeight + 8}`} fill="#5e7088" />
                  <text
                    x="0"
                    y="24"
                    textAnchor="middle"
                    fill="#f1f5f9"
                    fontSize="13"
                    fontWeight="700"
                  >
                    {activeTooltipText}
                  </text>
                </g>
              </svg>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <div className="rounded-2xl border border-slate-800/90 bg-slate-950/30 px-4 py-3">
                <div className="text-[10px] uppercase tracking-[0.24em] text-slate-500">Most common rating</div>
                <div className="mt-1 text-sm font-semibold text-slate-100">{binLabel(dominantBin, binCount)}</div>
              </div>
              <div className="rounded-2xl border border-slate-800/90 bg-slate-950/30 px-4 py-3">
                <div className="text-[10px] uppercase tracking-[0.24em] text-slate-500">Most movies</div>
                <div className="mt-1 text-sm font-semibold text-slate-100">{numberFormatter.format(counts[dominantBin])}</div>
              </div>
              <div className="rounded-2xl border border-slate-800/90 bg-slate-950/30 px-4 py-3">
                <div className="text-[10px] uppercase tracking-[0.24em] text-slate-500">Largest share</div>
                <div className="mt-1 text-sm font-semibold text-slate-100">{(probabilities[dominantBin] * 100).toFixed(1)}%</div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
