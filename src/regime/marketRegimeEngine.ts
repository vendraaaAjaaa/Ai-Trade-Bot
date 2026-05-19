import type { Candle, TradingPair } from '../utils/types';
import type { RegimeAnalysis, MarketRegime } from '../utils/types2';
import { calcATR, calcEMA } from '../indicators/indicators';
import { createLogger } from '../utils/logger';
import { redis } from '../redis/client';

const log = createLogger('regime');

// Cache regime per pair for 2 minutes
const REGIME_CACHE_TTL = 120;
const regimeKey = (pair: string) => `regime:${pair}`;

export class MarketRegimeEngine {

  async analyze(pair: TradingPair, candles: Candle[]): Promise<RegimeAnalysis> {
    if (candles.length < 50) {
      return this.unknownRegime(pair);
    }

    // Check cache first
    const cached = await redis.getJson<RegimeAnalysis>(regimeKey(pair));
    if (cached && Date.now() - cached.timestamp < REGIME_CACHE_TTL * 1000) {
      return cached;
    }

    const result = this.compute(candles);
    await redis.setJson(regimeKey(pair), result, REGIME_CACHE_TTL);

    log.info({
      pair,
      regime: result.regime,
      confidence: result.confidence,
      tradingAllowed: result.tradingAllowed,
    }, 'Regime analyzed');

    return result;
  }

  private compute(candles: Candle[]): RegimeAnalysis {
    const closes = candles.map((c) => c.close);
    const last = candles[candles.length - 1]!;
    const price = last.close;

    // ---- EMA trend analysis ----
    const ema20 = calcEMA(closes, 20);
    const ema50 = calcEMA(closes, 50);
    const ema200 = calcEMA(closes, 200);
    const e20 = ema20[ema20.length - 1] ?? price;
    const e50 = ema50[ema50.length - 1] ?? price;
    const e200 = ema200[ema200.length - 1] ?? price;

    // EMA flattening: compare last 5 ema50 values
    const ema50Recent = ema50.slice(-5);
    const ema50Range = Math.max(...ema50Recent) - Math.min(...ema50Recent);
    const emaFlattening = ema50Range / price < 0.003; // less than 0.3% range = flat

    // ---- ATR analysis ----
    const atrArr = calcATR(candles, 14);
    const atr = atrArr[atrArr.length - 1] ?? 0;
    const atrPercent = (atr / price) * 100;

    // ATR compression: compare current ATR to its 20-period average
    const atrAvg = atrArr.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, atrArr.length);
    const atrCompressed = atr < atrAvg * 0.7;

    // ---- Wick ratio analysis ----
    const recentCandles = candles.slice(-20);
    const wickRatio = this.avgWickRatio(recentCandles);

    // ---- Trend strength (simplified ADX) ----
    const trendStrength = this.calcTrendStrength(candles);

    // ---- Fake breakout frequency ----
    const fakeBreakoutFrequency = this.calcFakeBreakoutFreq(candles.slice(-30));

    // ---- Volume trend ----
    const recentVolAvg = candles.slice(-10).reduce((s, c) => s + c.volume, 0) / 10;
    const longVolAvg = candles.slice(-50).reduce((s, c) => s + c.volume, 0) / 50;
    const lowVolume = recentVolAvg < longVolAvg * 0.6;

    // ---- Classify regime ----
    const bullishStack = e20 > e50 && e50 > e200;
    const bearishStack = e20 < e50 && e50 < e200;
    const highVolatility = atrPercent > 3.0;
    const lowLiquidity = lowVolume && atrCompressed;
    const isChoppy = this.isChoppy({ emaFlattening, atrCompressed, wickRatio, fakeBreakoutFrequency, trendStrength });
    const isManipulative = wickRatio > 0.65 && fakeBreakoutFrequency > 0.4;

    let regime: MarketRegime;
    let confidence = 0;
    let tradingAllowed = true;
    let description = '';

    if (isManipulative) {
      regime = 'manipulative';
      confidence = 75;
      tradingAllowed = false;
      description = 'High wick ratio and frequent fake breakouts indicate market manipulation.';
    } else if (highVolatility && !bullishStack && !bearishStack) {
      regime = 'news_volatility';
      confidence = 70;
      tradingAllowed = false;
      description = 'Extreme volatility without directional structure — likely news event.';
    } else if (lowLiquidity) {
      regime = 'low_liquidity';
      confidence = 65;
      tradingAllowed = false;
      description = 'Low volume with compressed ATR — insufficient liquidity.';
    } else if (isChoppy) {
      regime = 'choppy';
      confidence = 70;
      tradingAllowed = false;
      description = 'ATR compression, flat EMAs, and weak delta — choppy market conditions.';
    } else if (highVolatility && (bullishStack || bearishStack)) {
      regime = 'high_volatility';
      confidence = 65;
      tradingAllowed = true; // allowed but with reduced size
      description = `High volatility ${bullishStack ? 'bullish' : 'bearish'} trend — trade with caution.`;
    } else if (bullishStack && trendStrength > 40) {
      regime = 'trending_up';
      confidence = Math.min(95, 50 + trendStrength);
      tradingAllowed = true;
      description = `Strong bullish trend (EMA stack confirmed, strength: ${trendStrength.toFixed(0)}).`;
    } else if (bearishStack && trendStrength > 40) {
      regime = 'trending_down';
      confidence = Math.min(95, 50 + trendStrength);
      tradingAllowed = true;
      description = `Strong bearish trend (EMA stack confirmed, strength: ${trendStrength.toFixed(0)}).`;
    } else {
      regime = 'ranging';
      confidence = 60;
      tradingAllowed = true; // Allow ranging with reduced position size & caution
      description = 'Market is ranging — trade with caution, reduced position size recommended.';
    }

    return {
      regime, confidence, trendStrength, isChoppy, isManipulative,
      atrPercent, emaFlattening, wickRatio, fakeBreakoutFrequency,
      tradingAllowed, description, timestamp: Date.now(),
    };
  }

  private isChoppy(params: {
    emaFlattening: boolean;
    atrCompressed: boolean;
    wickRatio: number;
    fakeBreakoutFrequency: number;
    trendStrength: number;
  }): boolean {
    let choppyScore = 0;
    if (params.emaFlattening) choppyScore += 2;
    if (params.atrCompressed) choppyScore += 2;
    if (params.wickRatio > 0.5) choppyScore += 1;
    if (params.fakeBreakoutFrequency > 0.3) choppyScore += 2;
    if (params.trendStrength < 25) choppyScore += 2;
    return choppyScore >= 5;
  }

  private avgWickRatio(candles: Candle[]): number {
    const ratios = candles.map((c) => {
      const range = c.high - c.low;
      if (range === 0) return 0;
      const body = Math.abs(c.close - c.open);
      const wicks = range - body;
      return wicks / range;
    });
    return ratios.reduce((a, b) => a + b, 0) / ratios.length;
  }

  private calcTrendStrength(candles: Candle[]): number {
    // Simplified directional movement strength
    const closes = candles.slice(-20).map((c) => c.close);
    let upMoves = 0;
    let downMoves = 0;
    for (let i = 1; i < closes.length; i++) {
      if (closes[i]! > closes[i - 1]!) upMoves++;
      else downMoves++;
    }
    const total = upMoves + downMoves;
    if (total === 0) return 0;
    const dominance = Math.max(upMoves, downMoves) / total; // 0.5=neutral, 1.0=perfect trend
    return (dominance - 0.5) * 200; // scale 0-100
  }

  private calcFakeBreakoutFreq(candles: Candle[]): number {
    if (candles.length < 10) return 0;
    const highs = candles.slice(0, -1).map((c) => c.high);
    const lows = candles.slice(0, -1).map((c) => c.low);
    const swingHigh = Math.max(...highs);
    const swingLow = Math.min(...lows);
    let fakeCount = 0;

    for (let i = 1; i < candles.length; i++) {
      const c = candles[i]!;
      const brokeHigh = c.high > swingHigh && c.close < swingHigh;
      const brokeLow = c.low < swingLow && c.close > swingLow;
      if (brokeHigh || brokeLow) fakeCount++;
    }
    return fakeCount / candles.length;
  }

  private unknownRegime(pair: string): RegimeAnalysis {
    return {
      regime: 'unknown', confidence: 0, trendStrength: 0, isChoppy: true,
      isManipulative: false, atrPercent: 0, emaFlattening: true,
      wickRatio: 0, fakeBreakoutFrequency: 0, tradingAllowed: false,
      description: 'Insufficient data for regime classification.',
      timestamp: Date.now(),
    };
  }

  async getCached(pair: TradingPair): Promise<RegimeAnalysis | null> {
    return redis.getJson<RegimeAnalysis>(regimeKey(pair));
  }
}

export const marketRegimeEngine = new MarketRegimeEngine();
