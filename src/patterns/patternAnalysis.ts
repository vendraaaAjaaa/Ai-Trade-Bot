import type { Candle, PatternSnapshot } from '../utils/types';
import { createLogger } from '../utils/logger';

const log = createLogger('patterns');

// =============================================
// PATTERN ANALYSIS ENGINE
// =============================================

export function analyzePatterns(candles: Candle[]): PatternSnapshot {
  if (candles.length < 30) {
    return buildEmptySnapshot();
  }

  const isBreakout = detectBreakout(candles);
  const isFakeBreakout = detectFakeBreakout(candles);
  const { isBOS, isChOCH, structureLevel } = detectMarketStructure(candles);
  const { hasOrderBlock, orderBlockLevel } = detectOrderBlock(candles);
  const { hasFairValueGap, fvgHigh, fvgLow } = detectFairValueGap(candles);
  const isTrendContinuation = detectTrendContinuation(candles);
  const isReversal = detectReversal(candles);

  log.debug({
    isBreakout, isFakeBreakout, isBOS, isChOCH,
    hasOrderBlock, hasFairValueGap, isTrendContinuation, isReversal,
  }, 'Pattern analysis complete');

  return {
    isBreakout,
    isFakeBreakout,
    isBOS,
    isCHOCH: isChOCH,
    hasOrderBlock,
    hasFairValueGap,
    isTrendContinuation,
    isReversal,
    orderBlockLevel: orderBlockLevel ?? null,
    fvgHigh: fvgHigh ?? null,
    fvgLow: fvgLow ?? null,
    structureLevel: structureLevel ?? null,
  };
}

// Breakout: price closes above recent resistance with volume
function detectBreakout(candles: Candle[]): boolean {
  const lookback = 20;
  const recent = candles.slice(-lookback - 1);
  const current = recent[recent.length - 1]!;
  const history = recent.slice(0, -1);

  const resistance = Math.max(...history.map((c) => c.high));
  const avgVol = history.reduce((s, c) => s + c.volume, 0) / history.length;

  return current.close > resistance && current.volume > avgVol * 1.5;
}

// Fake breakout: broke level but reversed within same/next candle
function detectFakeBreakout(candles: Candle[]): boolean {
  if (candles.length < 22) return false;
  const lookback = 20;
  const prev = candles.slice(-lookback - 2, -2);
  const breakCandle = candles[candles.length - 2]!;
  const current = candles[candles.length - 1]!;

  const resistance = Math.max(...prev.map((c) => c.high));
  const support = Math.min(...prev.map((c) => c.low));

  // Upward fake: broke resistance, now closed back below
  const upFake =
    breakCandle.high > resistance &&
    breakCandle.close < resistance &&
    current.close < resistance;

  // Downward fake: broke support, now closed back above
  const downFake =
    breakCandle.low < support &&
    breakCandle.close > support &&
    current.close > support;

  return upFake || downFake;
}

// BOS (Break of Structure) and CHOCH (Change of Character)
function detectMarketStructure(candles: Candle[]): {
  isBOS: boolean;
  isChOCH: boolean;
  structureLevel: number | undefined;
} {
  if (candles.length < 30) return { isBOS: false, isChOCH: false, structureLevel: undefined };

  const swings = findSwingPoints(candles.slice(-30));
  if (swings.highs.length < 2 || swings.lows.length < 2) {
    return { isBOS: false, isChOCH: false, structureLevel: undefined };
  }

  const current = candles[candles.length - 1]!;

  // BOS: price breaks previous swing high in uptrend or previous swing low in downtrend
  const lastSwingHigh = swings.highs[swings.highs.length - 1]!;
  const prevSwingHigh = swings.highs[swings.highs.length - 2]!;
  const lastSwingLow = swings.lows[swings.lows.length - 1]!;
  const prevSwingLow = swings.lows[swings.lows.length - 2]!;

  const uptrend = lastSwingHigh > prevSwingHigh && lastSwingLow > prevSwingLow;
  const downtrend = lastSwingHigh < prevSwingHigh && lastSwingLow < prevSwingLow;

  const isBOS =
    (uptrend && current.close > lastSwingHigh) ||
    (downtrend && current.close < lastSwingLow);

  // CHOCH: break opposite to the current trend (early reversal signal)
  const isChOCH =
    (uptrend && current.close < lastSwingLow) ||
    (downtrend && current.close > lastSwingHigh);

  const structureLevel = isBOS
    ? uptrend ? lastSwingHigh : lastSwingLow
    : isChOCH
    ? uptrend ? lastSwingLow : lastSwingHigh
    : undefined;

  return { isBOS, isChOCH, structureLevel };
}

// Order Block: last bearish candle before bullish impulse (bullish OB) or vice versa
function detectOrderBlock(candles: Candle[]): {
  hasOrderBlock: boolean;
  orderBlockLevel: number | undefined;
} {
  if (candles.length < 10) return { hasOrderBlock: false, orderBlockLevel: undefined };
  const current = candles[candles.length - 1]!;
  const lookback = candles.slice(-15, -1);

  // Find strong impulse candles
  const avgRange = lookback.reduce((s, c) => s + (c.high - c.low), 0) / lookback.length;

  for (let i = lookback.length - 1; i >= 1; i--) {
    const c = lookback[i]!;
    const prev = lookback[i - 1]!;
    const range = c.high - c.low;
    const isBullishImpulse = c.close > c.open && range > avgRange * 1.5;
    const isBearishImpulse = c.close < c.open && range > avgRange * 1.5;

    // Bullish OB: current price comes back to last bearish candle before bullish impulse
    if (isBullishImpulse && prev.close < prev.open) {
      const obZoneLow = prev.low;
      const obZoneHigh = prev.high;
      if (current.low <= obZoneHigh && current.close >= obZoneLow) {
        return { hasOrderBlock: true, orderBlockLevel: (obZoneHigh + obZoneLow) / 2 };
      }
    }

    // Bearish OB: current price comes back to last bullish candle before bearish impulse
    if (isBearishImpulse && prev.close > prev.open) {
      const obZoneLow = prev.low;
      const obZoneHigh = prev.high;
      if (current.high >= obZoneLow && current.close <= obZoneHigh) {
        return { hasOrderBlock: true, orderBlockLevel: (obZoneHigh + obZoneLow) / 2 };
      }
    }
  }

  return { hasOrderBlock: false, orderBlockLevel: undefined };
}

// Fair Value Gap: 3-candle pattern where middle candle creates a gap
function detectFairValueGap(candles: Candle[]): {
  hasFairValueGap: boolean;
  fvgHigh: number | undefined;
  fvgLow: number | undefined;
} {
  if (candles.length < 3) return { hasFairValueGap: false, fvgHigh: undefined, fvgLow: undefined };
  const current = candles[candles.length - 1]!;

  for (let i = candles.length - 3; i >= Math.max(0, candles.length - 15); i--) {
    const c1 = candles[i]!;
    const c2 = candles[i + 1]!;
    const c3 = candles[i + 2]!;

    // Bullish FVG: gap between c1 high and c3 low
    if (c3.low > c1.high) {
      const fvgHigh = c3.low;
      const fvgLow = c1.high;
      // Check if current price is in/near FVG
      if (current.close >= fvgLow * 0.999 && current.close <= fvgHigh * 1.001) {
        return { hasFairValueGap: true, fvgHigh, fvgLow };
      }
    }

    // Bearish FVG: gap between c1 low and c3 high
    if (c1.low > c3.high) {
      const fvgHigh = c1.low;
      const fvgLow = c3.high;
      if (current.close >= fvgLow * 0.999 && current.close <= fvgHigh * 1.001) {
        return { hasFairValueGap: true, fvgHigh, fvgLow };
      }
    }
  }

  return { hasFairValueGap: false, fvgHigh: undefined, fvgLow: undefined };
}

// Trend continuation: higher highs + higher lows (bullish) or lower lows + lower highs (bearish)
function detectTrendContinuation(candles: Candle[]): boolean {
  const swings = findSwingPoints(candles.slice(-20));
  if (swings.highs.length < 3 || swings.lows.length < 3) return false;

  const hhBull = swings.highs[swings.highs.length - 1]! > swings.highs[swings.highs.length - 2]!;
  const hlBull = swings.lows[swings.lows.length - 1]! > swings.lows[swings.lows.length - 2]!;

  const llBear = swings.lows[swings.lows.length - 1]! < swings.lows[swings.lows.length - 2]!;
  const lhBear = swings.highs[swings.highs.length - 1]! < swings.highs[swings.highs.length - 2]!;

  return (hhBull && hlBull) || (llBear && lhBear);
}

// Reversal: divergence + extreme RSI + opposite structure break
function detectReversal(candles: Candle[]): boolean {
  if (candles.length < 10) return false;
  const last5 = candles.slice(-5);
  const isEngulfing =
    last5[last5.length - 2] !== undefined &&
    Math.abs(last5[last5.length - 1]!.close - last5[last5.length - 1]!.open) >
      Math.abs(last5[last5.length - 2]!.close - last5[last5.length - 2]!.open) * 1.5;

  const hasDoji = last5.some((c) => {
    const body = Math.abs(c.close - c.open);
    const range = c.high - c.low;
    return range > 0 && body / range < 0.1;
  });

  return isEngulfing || hasDoji;
}

function findSwingPoints(candles: Candle[]): { highs: number[]; lows: number[] } {
  const highs: number[] = [];
  const lows: number[] = [];

  for (let i = 2; i < candles.length - 2; i++) {
    const c = candles[i]!;
    const isSwingHigh =
      c.high > candles[i - 1]!.high &&
      c.high > candles[i - 2]!.high &&
      c.high > candles[i + 1]!.high &&
      c.high > candles[i + 2]!.high;

    const isSwingLow =
      c.low < candles[i - 1]!.low &&
      c.low < candles[i - 2]!.low &&
      c.low < candles[i + 1]!.low &&
      c.low < candles[i + 2]!.low;

    if (isSwingHigh) highs.push(c.high);
    if (isSwingLow) lows.push(c.low);
  }

  return { highs, lows };
}

function buildEmptySnapshot(): PatternSnapshot {
  return {
    isBreakout: false, isFakeBreakout: false, isBOS: false, isCHOCH: false,
    hasOrderBlock: false, hasFairValueGap: false, isTrendContinuation: false,
    isReversal: false, orderBlockLevel: null, fvgHigh: null, fvgLow: null,
    structureLevel: null,
  };
}
