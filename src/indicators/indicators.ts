import type { Candle, IndicatorSnapshot } from '../utils/types';

// =============================================
// TECHNICAL INDICATORS ENGINE
// =============================================

export function calcEMA(closes: number[], period: number): number[] {
  if (closes.length < period) return [];
  const k = 2 / (period + 1);
  const result: number[] = [];
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result.push(ema);
  for (let i = period; i < closes.length; i++) {
    ema = (closes[i]! - ema) * k + ema;
    result.push(ema);
  }
  return result;
}

export function calcSMA(data: number[], period: number): number[] {
  const result: number[] = [];
  for (let i = period - 1; i < data.length; i++) {
    const sum = data.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
    result.push(sum / period);
  }
  return result;
}

export function calcRSI(closes: number[], period = 14): number[] {
  if (closes.length < period + 1) return [];
  const result: number[] = [];
  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  const rsi0 = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  result.push(rsi0);

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
    const rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    result.push(rsi);
  }
  return result;
}

export interface MACDResult {
  macd: number[];
  signal: number[];
  histogram: number[];
}

export function calcMACD(
  closes: number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): MACDResult {
  const fastEMA = calcEMA(closes, fastPeriod);
  const slowEMA = calcEMA(closes, slowPeriod);

  const offset = slowPeriod - fastPeriod;
  const macdLine: number[] = [];

  for (let i = 0; i < slowEMA.length; i++) {
    macdLine.push(fastEMA[i + offset]! - slowEMA[i]!);
  }

  const signalLine = calcEMA(macdLine, signalPeriod);
  const histogram: number[] = [];

  const sigOffset = macdLine.length - signalLine.length;
  for (let i = 0; i < signalLine.length; i++) {
    histogram.push(macdLine[i + sigOffset]! - signalLine[i]!);
  }

  return { macd: macdLine, signal: signalLine, histogram };
}

export function calcATR(candles: Candle[], period = 14): number[] {
  if (candles.length < period + 1) return [];
  const trueRanges: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const curr = candles[i]!;
    const prev = candles[i - 1]!;
    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close),
    );
    trueRanges.push(tr);
  }

  const result: number[] = [];
  let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result.push(atr);

  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]!) / period;
    result.push(atr);
  }
  return result;
}

export function calcVWAP(candles: Candle[]): number[] {
  const result: number[] = [];
  let cumTPV = 0;
  let cumVol = 0;

  for (const c of candles) {
    const typicalPrice = (c.high + c.low + c.close) / 3;
    cumTPV += typicalPrice * c.volume;
    cumVol += c.volume;
    result.push(cumVol > 0 ? cumTPV / cumVol : typicalPrice);
  }
  return result;
}

export type DivergenceType = 'bullish' | 'bearish' | 'none';

export function detectRSIDivergence(
  closes: number[],
  rsiValues: number[],
  lookback = 5,
): DivergenceType {
  if (closes.length < lookback * 2 || rsiValues.length < lookback * 2) return 'none';

  const priceSlice = closes.slice(-lookback * 2);
  const rsiSlice = rsiValues.slice(-lookback * 2);

  const prevLowIdx = priceSlice.slice(0, lookback).reduce((minI, v, i, arr) => v < arr[minI]! ? i : minI, 0);
  const currLowIdx = lookback + priceSlice.slice(lookback).reduce((minI, v, i, arr) => v < arr[minI]! ? i : minI, 0);

  const prevHighIdx = priceSlice.slice(0, lookback).reduce((maxI, v, i, arr) => v > arr[maxI]! ? i : maxI, 0);
  const currHighIdx = lookback + priceSlice.slice(lookback).reduce((maxI, v, i, arr) => v > arr[maxI]! ? i : maxI, 0);

  // Bullish: lower price low but higher RSI low
  if (
    priceSlice[currLowIdx]! < priceSlice[prevLowIdx]! &&
    rsiSlice[currLowIdx]! > rsiSlice[prevLowIdx]!
  ) {
    return 'bullish';
  }

  // Bearish: higher price high but lower RSI high
  if (
    priceSlice[currHighIdx]! > priceSlice[prevHighIdx]! &&
    rsiSlice[currHighIdx]! < rsiSlice[prevHighIdx]!
  ) {
    return 'bearish';
  }

  return 'none';
}

export function detectTrend(ema20: number, ema50: number, ema200: number): 'bullish' | 'bearish' | 'ranging' {
  if (ema20 > ema50 && ema50 > ema200) return 'bullish';
  if (ema20 < ema50 && ema50 < ema200) return 'bearish';
  return 'ranging';
}

export function computeIndicators(candles: Candle[]): IndicatorSnapshot | null {
  if (candles.length < 210) return null;
  const closes = candles.map((c) => c.close);

  const ema20Arr = calcEMA(closes, 20);
  const ema50Arr = calcEMA(closes, 50);
  const ema200Arr = calcEMA(closes, 200);
  const rsiArr = calcRSI(closes, 14);
  const macdResult = calcMACD(closes);
  const atrArr = calcATR(candles, 14);
  const vwapArr = calcVWAP(candles);

  const ema20 = ema20Arr[ema20Arr.length - 1] ?? 0;
  const ema50 = ema50Arr[ema50Arr.length - 1] ?? 0;
  const ema200 = ema200Arr[ema200Arr.length - 1] ?? 0;
  const rsi = rsiArr[rsiArr.length - 1] ?? 50;
  const macdHistogram = macdResult.histogram[macdResult.histogram.length - 1] ?? 0;
  const macdLine = macdResult.macd[macdResult.macd.length - 1] ?? 0;
  const signalLine = macdResult.signal[macdResult.signal.length - 1] ?? 0;
  const atr = atrArr[atrArr.length - 1] ?? 0;
  const vwap = vwapArr[vwapArr.length - 1] ?? closes[closes.length - 1] ?? 0;

  const rsiDivergence = detectRSIDivergence(closes, rsiArr);
  const trend = detectTrend(ema20, ema50, ema200);

  return {
    ema20, ema50, ema200, vwap, rsi, macdHistogram, macdLine, signalLine,
    atr, rsiDivergence, trend,
  };
}
