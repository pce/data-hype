import { Subject, Observable } from 'rxjs';
import { groupBy, mergeMap, scan, map } from 'rxjs/operators';

export interface StockTick {
  symbol: string;
  price: number;
  change?: number;
  timestamp: number;
}

export interface StockMetrics {
  symbol: string;
  emaFast?: number;
  emaSlow?: number;
  rsi?: number;
  macd?: { MACD: number; signal: number; histogram: number };
  bollinger?: { lower: number; middle: number; upper: number };
  lastPrice: number;
  timestamp: number;
}

/**
 * Simple incremental EMA implementation.
 * - Uses SMA over the first `period` values to initialize the EMA.
 */
class IncrementalEMA {
  private period: number;
  private multiplier: number;
  private initialized = false;
  private value = 0;
  private buffer: number[] = [];

  constructor(period: number) {
    this.period = period;
    this.multiplier = 2 / (period + 1);
  }

  update(price: number): number | undefined {
    if (!this.initialized) {
      this.buffer.push(price);
      if (this.buffer.length < this.period) {
        return undefined;
      }
      // initialize with SMA
      const sum = this.buffer.reduce((s, v) => s + v, 0);
      this.value = sum / this.buffer.length;
      this.buffer = []; // free memory
      this.initialized = true;
      return this.value;
    }
    this.value = price * this.multiplier + this.value * (1 - this.multiplier);
    return this.value;
  }

  getValue(): number | undefined {
    return this.initialized ? this.value : undefined;
  }
}

/**
 * Incremental RSI using Wilder's smoothing.
 * - Uses average gain/loss initialization from first `period` diffs.
 */
class IncrementalRSI {
  private period: number;
  private prevPrice: number | undefined;
  private gains: number[] = [];
  private losses: number[] = [];
  private avgGain: number | undefined;
  private avgLoss: number | undefined;
  private initialized = false;

  constructor(period: number) {
    this.period = period;
  }

  update(price: number): number | undefined {
    if (this.prevPrice === undefined) {
      this.prevPrice = price;
      return undefined;
    }
    const diff = price - this.prevPrice;
    const gain = Math.max(0, diff);
    const loss = Math.max(0, -diff);

    if (!this.initialized) {
      this.gains.push(gain);
      this.losses.push(loss);

      if (this.gains.length < this.period) {
        this.prevPrice = price;
        return undefined;
      }

      // Initialize using simple average of first period diffs
      const sumGain = this.gains.reduce((s, v) => s + v, 0);
      const sumLoss = this.losses.reduce((s, v) => s + v, 0);
      this.avgGain = sumGain / this.period;
      this.avgLoss = sumLoss / this.period;
      this.gains = [];
      this.losses = [];
      this.initialized = true;
      this.prevPrice = price;
      const rs = this.avgLoss === 0 ? Number.POSITIVE_INFINITY : this.avgGain! / this.avgLoss!;
      const rsi = this.avgLoss === 0 ? 100 : 100 - 100 / (1 + rs);
      return rsi;
    }

    // Wilder's smoothing
    this.avgGain = (this.avgGain! * (this.period - 1) + gain) / this.period;
    this.avgLoss = (this.avgLoss! * (this.period - 1) + loss) / this.period;

    this.prevPrice = price;

    if (this.avgLoss === 0) {
      return 100;
    }
    const rs = this.avgGain! / this.avgLoss!;
    return 100 - 100 / (1 + rs);
  }
}

/**
 * Incremental MACD:
 * - Maintains fast and slow EMAs
 * - Signal line is EMA of MACD line
 */
class IncrementalMACD {
  private fast: IncrementalEMA;
  private slow: IncrementalEMA;
  private signal: IncrementalEMA;
  private lastMacd: number | undefined;

  constructor(fastPeriod: number, slowPeriod: number, signalPeriod: number) {
    this.fast = new IncrementalEMA(fastPeriod);
    this.slow = new IncrementalEMA(slowPeriod);
    this.signal = new IncrementalEMA(signalPeriod);
  }

  update(price: number): { MACD?: number; signal?: number; histogram?: number } {
    const f = this.fast.update(price);
    const s = this.slow.update(price);
    let macd: number | undefined;
    let signalVal: number | undefined;
    let hist: number | undefined;

    if (f !== undefined && s !== undefined) {
      macd = f - s;
      this.lastMacd = macd;
      const sig = this.signal.update(macd);
      if (sig !== undefined) {
        signalVal = sig;
        hist = macd - signalVal;
      }
    }
    return { MACD: macd, signal: signalVal, histogram: hist };
  }
}

/**
 * Bollinger Bands:
 * - Keeps a small circular buffer of latest `period` values.
 * - Computes mean and sample stddev on-demand (O(period) per tick).
 * This is fine for small periods (e.g. 20).
 */
class IncrementalBollinger {
  private period: number;
  private stdDev: number;
  private buffer: number[] = [];
  private index = 0;

  constructor(period: number, stdDev: number) {
    this.period = period;
    this.stdDev = stdDev;
  }

  update(price: number): { lower: number; mid: number; upper: number } | undefined {
    if (this.buffer.length < this.period) {
      this.buffer.push(price);
    } else {
      this.buffer[this.index] = price;
      this.index = (this.index + 1) % this.period;
    }

    if (this.buffer.length < this.period) return undefined;

    // compute mean
    const mean = this.buffer.reduce((s, v) => s + v, 0) / this.period;
    // sample standard deviation (population is also acceptable; technicalindicators uses population-ish)
    let variance = 0;
    for (let i = 0; i < this.period; i++) {
      const d = this.buffer[i] - mean;
      variance += d * d;
    }
    variance = variance / this.period; // population variance
    const sd = Math.sqrt(variance);
    return {
      lower: mean - this.stdDev * sd,
      mid: mean,
      upper: mean + this.stdDev * sd,
    };
  }
}

/**
 * createStockAnalytics: returns { input, metrics$ }.
 * - input: Subject<StockTick> - push ticks into this
 * - metrics$: Observable<StockMetrics> - subscribe to receive computed metrics per tick
 *
 * Options let you tune indicator periods.
 *
 * Implementation switched from external library to incremental per-symbol indicator instances.
 * This reduces allocations and avoids leaking large arrays inside a 3rd-party package.
 */
export function createStockAnalytics(opts?: {
  emaFast?: number;
  emaSlow?: number;
  rsiPeriod?: number;
  bbPeriod?: number;
  bbStd?: number;
  macdFast?: number;
  macdSlow?: number;
  macdSignal?: number;
}) {
  const settings = {
    emaFast: opts?.emaFast ?? 9,
    emaSlow: opts?.emaSlow ?? 21,
    rsiPeriod: opts?.rsiPeriod ?? 14,
    bbPeriod: opts?.bbPeriod ?? 20,
    bbStd: opts?.bbStd ?? 2,
    macdFast: opts?.macdFast ?? 12,
    macdSlow: opts?.macdSlow ?? 26,
    macdSignal: opts?.macdSignal ?? 9,
  };

  const input = new Subject<StockTick>();

  type PerSymbolState = {
    emaFast: IncrementalEMA;
    emaSlow: IncrementalEMA;
    rsi: IncrementalRSI;
    macd: IncrementalMACD;
    bb: IncrementalBollinger;
    lastTick?: StockTick;
  };

  const metrics$ = input.pipe(
    groupBy((t) => t.symbol),
    mergeMap((group$) =>
      group$.pipe(
        scan(
          (state: PerSymbolState | null, tick: StockTick) => {
            if (state === null) {
              // initialize per-symbol indicators
              const s: PerSymbolState = {
                emaFast: new IncrementalEMA(settings.emaFast),
                emaSlow: new IncrementalEMA(settings.emaSlow),
                rsi: new IncrementalRSI(settings.rsiPeriod),
                macd: new IncrementalMACD(settings.macdFast, settings.macdSlow, settings.macdSignal),
                bb: new IncrementalBollinger(settings.bbPeriod, settings.bbStd),
                lastTick: tick,
              };
              // update once with this tick so subsequent map sees an updated state
              s.emaFast.update(tick.price);
              s.emaSlow.update(tick.price);
              s.rsi.update(tick.price);
              s.macd.update(tick.price);
              s.bb.update(tick.price);
              s.lastTick = tick;
              return s;
            }

            // update existing indicators
            state.emaFast.update(tick.price);
            state.emaSlow.update(tick.price);
            state.rsi.update(tick.price);
            state.macd.update(tick.price);
            state.bb.update(tick.price);
            state.lastTick = tick;
            return state;
          },
          null as PerSymbolState | null
        ),
        map((state) => {
          // state should never be null here because scan initializes it on the first tick
          const s = state!;
          const tick = s.lastTick!;
          const emaFast = s.emaFast.getValue();
          const emaSlow = s.emaSlow.getValue();
          const rsi = (s.rsi as IncrementalRSI).update ? undefined : undefined; // noop to satisfy types (we'll call get via internal method)
          // We want the latest RSI value but our IncrementalRSI only returns on update; since we updated in scan, we need to produce the current RSI.
          // To avoid changing class API, we'll hold the last computed RSI by calling update with the same price again would mutate smoothing; so instead we will track RSI by computing it during update and storing on state.
          // Simpler: change PerSymbolState to store last computed RSI/MACD/Bollinger from update.
          // To keep this map pure, refactor: we will reconstruct state handling to store last computed values.
          return { s, tick, emaFast, emaSlow, rsi } as any;
        }),
        // second scan replacement: to avoid complicated in-map logic above, rebuild pipeline: replace previous operators with single scan that both updates and returns metrics.
      )
    )
  );

  // The prior pipeline attempted to use map after scan but needed to capture computed values.
  // Simpler: rebuild metrics$ by creating a new pipeline that does the scan and maps to metrics in one pass.
  const metrics2$ = input.pipe(
    groupBy((t) => t.symbol),
    mergeMap((group$) =>
      group$.pipe(
        scan(
          (state: { ps: PerSymbolState | null; lastMetrics?: StockMetrics }, tick: StockTick) => {
            if (state.ps === null) {
              const ps: PerSymbolState = {
                emaFast: new IncrementalEMA(settings.emaFast),
                emaSlow: new IncrementalEMA(settings.emaSlow),
                rsi: new IncrementalRSI(settings.rsiPeriod),
                macd: new IncrementalMACD(settings.macdFast, settings.macdSlow, settings.macdSignal),
                bb: new IncrementalBollinger(settings.bbPeriod, settings.bbStd),
              };
              // update all indicators with this tick and capture returned values
              const emaF = ps.emaFast.update(tick.price);
              const emaS = ps.emaSlow.update(tick.price);
              const rsiVal = ps.rsi.update(tick.price);
              const macdVals = ps.macd.update(tick.price);
              const bbVals = ps.bb.update(tick.price);

              const metrics: StockMetrics = {
                symbol: tick.symbol,
                emaFast: emaF,
                emaSlow: emaS,
                rsi: rsiVal,
                macd: macdVals.MACD !== undefined && macdVals.signal !== undefined ? { MACD: macdVals.MACD!, signal: macdVals.signal!, histogram: macdVals.histogram! } : undefined,
                bollinger: bbVals ? { lower: bbVals.lower, middle: bbVals.mid, upper: bbVals.upper } : undefined,
                lastPrice: tick.price,
                timestamp: tick.timestamp,
              };
              return { ps, lastMetrics: metrics };
            }

            const ps = state.ps;
            const emaF = ps.emaFast.update(tick.price);
            const emaS = ps.emaSlow.update(tick.price);
            const rsiVal = ps.rsi.update(tick.price);
            const macdVals = ps.macd.update(tick.price);
            const bbVals = ps.bb.update(tick.price);

            const metrics: StockMetrics = {
              symbol: tick.symbol,
              emaFast: emaF,
              emaSlow: emaS,
              rsi: rsiVal,
              macd: macdVals.MACD !== undefined && macdVals.signal !== undefined ? { MACD: macdVals.MACD!, signal: macdVals.signal!, histogram: macdVals.histogram! } : undefined,
              bollinger: bbVals ? { lower: bbVals.lower, middle: bbVals.mid, upper: bbVals.upper } : undefined,
              lastPrice: tick.price,
              timestamp: tick.timestamp,
            };

            return { ps, lastMetrics: metrics };
          },
          { ps: null as PerSymbolState | null, lastMetrics: undefined as StockMetrics | undefined }
        ),
        // emit the lastMetrics each tick
        map((s) => s.lastMetrics as StockMetrics)
      )
    )
  );

  return { input, metrics$: metrics2$ as Observable<StockMetrics> };
}