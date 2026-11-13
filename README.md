# NVIDIA CEO forecaster — empirical move quantiles

An entry for make.fun's bounty **"Forecast Polymarket's next NVIDIA CEO prices minute by
minute, 4 hours ahead"** (polymarket-nvidia-ceo-forecast-01).

`main.ts` (Node 22, standard library only) reads one case file — every trading market of
Polymarket's "Next CEO of NVIDIA?" event with its Yes price at each of the 4,320 minutes up
to a checkpoint — and writes, for each market and each of the 240 minutes after the
checkpoint, the 5%, 25%, 50%, 75% and 95% quantiles of that minute's price.

## How it forecasts

A Polymarket Yes price is a step process: quiet for long stretches, a tick now and then, a
jump when news lands. Instead of the persistence baseline's one fixed Gaussian sigma for
every market, this program reads each market's own recent behaviour:

1. For a grid of horizons, the empirical distribution of the market's historical h-minute
   moves over its freshest 18 hours gives the five quantiles directly — fat tails and the
   market's own tick size included by construction.
2. The empirical median is trusted only a little (weight 0.3); a few hours of drift is
   mostly noise, so the centre stays near persistence.
3. The spread is scaled by a volatility-regime factor — the last 4 hours' RMS 1-minute
   move against the full history's, clamped to [0.6, 1.8].
4. Thin samples shrink toward the persistence baseline (sigma 0.0025, normal z), so a
   young market falls back to the safe answer.
5. Horizons between grid points are interpolated in sqrt(h); rows are clamped to [0, 1],
   kept non-decreasing and rounded to 6 decimals.

The program is a pure function of its case file: two runs on the same case are byte-for-byte
identical, and a case runs in a fraction of the 8-second cap.

## Calibration

The constants were calibrated on the competition's six practice cases, rebuilt from
Polymarket's public price history and scored with the contest's pinball loss: **0.2872**
against the persistence baseline's **0.3636**, better on every one of the six cases.
A final per-level calibration of each row's spread around its own median is included:
the upside quantiles of these step prices run systematically wide on the practice cases
(a spike up is usually given back), while the 5% tail runs narrow.

## Run

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Reads every `<id>.in` in the input directory and writes `<id>.out` beside the requested
outputs, in the exact format the contest grades.

## License

MIT — see `LICENSE`.
