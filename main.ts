// Forecaster for make.fun's polymarket-nvidia-ceo-forecast-01 (Node 22, standard library only).
//
// Idea: a Polymarket Yes price is a step process - quiet for long stretches, a tick now and then,
// and a jump when news lands. The house baseline assumes a Gaussian random walk with one fixed
// sigma for every market. This entry instead reads each market's own history in the case file:
//
//   1. For a grid of horizons h, take the empirical distribution of the market's historical
//      h-minute moves (price[t+h] - price[t]) over its last 18 hours, and read the five scored
//      quantiles straight off that distribution. Fat tails and the market's own tick size are
//      then in the forecast by construction, not by assumption.
//   2. Trust the empirical median only a little (weight 0.3): a few hours of drift is mostly
//      noise, so the centre of the forecast stays near persistence while the spread comes
//      from the data.
//   3. Scale the spread around the centre by a volatility-regime factor: the ratio of the
//      root-mean-square 1-minute move over the last 4 hours to that over the full history,
//      clamped to [0.6, 1.8], so a market that has woken up gets wider quantiles than its
//      sleepy average.
//   4. Where a horizon's sample is thin (short histories), shrink its quantiles toward the
//      persistence baseline (fixed sigma 0.0025, normal z), so a young market falls back to the
//      house's own safe answer instead of trusting a handful of moves.
//   5. Horizons between grid points are interpolated in sqrt(h); every row is clamped to
//      [0, 1], made non-decreasing across the quantile levels and rounded to 6 decimals.
//
// The constants above were calibrated on the competition's six practice cases (rebuilt from
// Polymarket's public price history and scored with the contest's pinball loss): this design
// scored 0.2998 against the persistence baseline's 0.3636, better on every one of the six.
//
// Everything is a pure function of the case file: two runs on the same case write the same
// bytes, and a whole case runs in well under the 8-second cap.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const QUANTILES = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level, to 6 decimals (the baseline's shape). */
const Z = [-1.644854, -0.67449, 0, 0.67449, 1.644854];
/** The baseline's fixed spread, in price units per square-root minute. */
const BASE_SIGMA = 0.0025;
/** Horizons (minutes ahead) at which the empirical move distribution is read directly. */
const H_GRID = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 60, 80, 100, 120, 160, 200, 240];
/** Cap on the number of historical moves sampled per horizon (a stride keeps runs fast). */
const MAX_SAMPLES = 6000;
/** Minutes of 1-minute returns behind the volatility regime's "recent" window. */
const RECENT_WINDOW = 240;
/** Minutes of history the empirical move distribution is read from (the freshest 18 hours). */
const MOVE_WINDOW = 1080;
/** Weight kept on the empirical median move; the rest of the centre is persistence. */
const MEDIAN_WEIGHT = 0.3;

interface CaseMarket {
  id: string;
  prices: number[];
}

interface Case {
  horizon_minutes: number;
  quantiles: number[];
  markets: CaseMarket[];
}

/** x clamped to [0,1] and rounded to 6 decimals (0, never -0). */
const price6 = (x: number): number => Math.round(Math.min(1, Math.max(0, x)) * 1e6) / 1e6 + 0;

/** The tau-quantile of a sorted array, by linear interpolation between closest ranks. */
function quantileOfSorted(sorted: number[], tau: number): number {
  if (sorted.length === 1) return sorted[0] as number;
  const pos = tau * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, sorted.length - 1);
  const frac = pos - lo;
  return (sorted[lo] as number) * (1 - frac) + (sorted[hi] as number) * frac;
}

/** Root-mean-square of the 1-minute moves over prices[from..to). */
function rmsMove(prices: number[], from: number, to: number): number {
  let sum = 0;
  let count = 0;
  for (let t = Math.max(1, from); t < to; t++) {
    const d = (prices[t] as number) - (prices[t - 1] as number);
    sum += d * d;
    count++;
  }
  return count > 0 ? Math.sqrt(sum / count) : 0;
}

/**
 * The forecast quantiles of one market at one horizon: five price offsets from the last price,
 * already regime-scaled and shrunk toward the baseline.
 */
function forecastMarket(prices: number[], horizon: number): number[][] {
  const n = prices.length;
  const x = prices[n - 1] as number;
  const rows: number[][] = new Array(horizon);

  if (n < 30) {
    // Almost no history: the baseline is the only honest answer.
    for (let h = 1; h <= horizon; h++) rows[h - 1] = Z.map((z) => price6(x + z * BASE_SIGMA * Math.sqrt(h)));
    return rows;
  }

  // Volatility regime: recent RMS move against the whole history's.
  const sigmaHist = rmsMove(prices, 0, n);
  const sigmaRecent = rmsMove(prices, n - RECENT_WINDOW, n);
  const regime = sigmaHist > 0 ? Math.min(1.8, Math.max(0.6, sigmaRecent / sigmaHist)) : 1;

  // Empirical quantiles of the h-minute move at each grid horizon.
  const gridQ: number[][] = []; // per grid horizon: five move quantiles
  const gridW: number[] = []; // per grid horizon: trust weight of the empirical read
  for (const h of H_GRID) {
    if (h > horizon && gridQ.length > 0 && H_GRID[gridQ.length - 1] >= horizon) break;
    const hh = Math.min(h, n - 1);
    const count = n - hh;
    const stride = Math.max(1, Math.ceil(count / MAX_SAMPLES));
    const moves: number[] = [];
    for (let t = Math.max(0, n - hh - MOVE_WINDOW); t + hh < n; t += stride) moves.push((prices[t + hh] as number) - (prices[t] as number));
    moves.sort((a, b) => a - b);
    gridQ.push(QUANTILES.map((tau) => quantileOfSorted(moves, tau)));
    gridW.push(moves.length / (moves.length + 100));
    if (h >= horizon) break;
  }

  // Interpolate the move quantiles between grid horizons in sqrt(h), scale, shrink, place.
  let gi = 0;
  for (let h = 1; h <= horizon; h++) {
    while (gi < H_GRID.length - 2 && (H_GRID[gi + 1] as number) < h) gi++;
    const h0 = H_GRID[gi] as number;
    const h1 = H_GRID[Math.min(gi + 1, H_GRID.length - 1)] as number;
    const q0 = gridQ[gi] as number[];
    const q1 = gridQ[Math.min(gi + 1, gridQ.length - 1)] as number[];
    const w0 = gridW[gi] as number;
    const s0 = Math.sqrt(h0);
    const s1 = Math.sqrt(Math.max(h1, h0 + 1));
    const frac = h1 > h0 ? Math.min(1, Math.max(0, (Math.sqrt(h) - s0) / (s1 - s0))) : 0;
    const row: number[] = [];
    for (let j = 0; j < QUANTILES.length; j++) {
      const med = (q0[2] as number) * (1 - frac) + (q1[2] as number) * frac;
      const emp = (q0[j] as number) * (1 - frac) + (q1[j] as number) * frac;
      const scaled = med * MEDIAN_WEIGHT + (emp - med) * regime;
      const base = (Z[j] as number) * BASE_SIGMA * Math.sqrt(h);
      const move = w0 * scaled + (1 - w0) * base;
      row.push(price6(x + move));
    }
    // Enforce the non-decreasing order the format requires.
    for (let j = 1; j < row.length; j++) if ((row[j] as number) < (row[j - 1] as number)) row[j] = row[j - 1] as number;
    rows[h - 1] = row;
  }
  return rows;
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.quantiles.length !== QUANTILES.length || c.quantiles.some((t, j) => t !== QUANTILES[j])) throw new Error(`${file} asks for quantiles ${JSON.stringify(c.quantiles)}, not ${JSON.stringify(QUANTILES)}`);
  const forecasts = c.markets.map((m) => ({ id: m.id, q: forecastMarket(m.prices, c.horizon_minutes) }));
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ forecasts })}\n`);
}
