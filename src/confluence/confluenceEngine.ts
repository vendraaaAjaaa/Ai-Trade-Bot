import type {
  TradingPair, TradeDirection, Candle, Timeframe,
  ConfluenceScore, ConfluenceFactor, TradingSignal, SignalStrength,
  IndicatorSnapshot, VolumeSnapshot, PatternSnapshot,
} from '../utils/types';
import { computeIndicators } from '../indicators/indicators';
import { analyzeVolume } from '../volume/volumeAnalysis';
import { analyzePatterns } from '../patterns/patternAnalysis';
import { marketDataService } from '../market/marketDataService';
import { createLogger } from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';

const log = createLogger('confluence');

// ---- Scoring weights ----
const SCORES = {
  // Volume factors
  VOLUME_SPIKE: 20,
  WHALE_ACTIVITY: 25,
  ABSORPTION: 15,
  LIQUIDITY_SWEEP: 12,
  BUY_IMBALANCE: 10,
  SELL_IMBALANCE: -10,
  SPOOFING: -15,

  // Pattern factors
  BREAKOUT: 18,
  FAKE_BREAKOUT: -30,
  BOS: 20,
  CHOCH: 15,
  ORDER_BLOCK: 22,
  FVG: 12,
  TREND_CONTINUATION: 15,
  REVERSAL: 10,

  // Indicator factors
  EMA_BULLISH_STACK: 18,
  EMA_BEARISH_STACK: -18,
  RSI_OVERSOLD: 12,
  RSI_OVERBOUGHT: -12,
  RSI_BULLISH_DIV: 15,
  RSI_BEARISH_DIV: -15,
  MACD_BULLISH: 10,
  MACD_BEARISH: -10,
  PRICE_ABOVE_VWAP: 8,
  PRICE_BELOW_VWAP: -8,
  FUNDING_NEGATIVE: 8, // negative funding = longs get paid, bearish signal for shorts
  FUNDING_EXTREME: 12,
};

export class ConfluenceEngine {
  async computeScore(pair: TradingPair, candles: Candle[], timeframe: Timeframe): Promise<ConfluenceScore | null> {
    if (candles.length < 210) return null;

    const indicators = computeIndicators(candles);
    if (!indicators) return null;

    const volume = analyzeVolume(pair, candles);
    const patterns = analyzePatterns(candles);
    const currentPrice = candles[candles.length - 1]!.close;

    const factors: ConfluenceFactor[] = [];
    let buyScore = 0;
    let sellScore = 0;

    // ---- Volume scoring ----
    this.addFactor(factors, 'Volume Spike', volume.isVolumeSpike, SCORES.VOLUME_SPIKE, 'High volume spike detected');
    this.addFactor(factors, 'Whale Activity', volume.isWhaleActivity, SCORES.WHALE_ACTIVITY, 'Whale-size position detected');
    this.addFactor(factors, 'Absorption', volume.isAbsorption, SCORES.ABSORPTION, 'Volume absorption at key level');
    this.addFactor(factors, 'Liquidity Sweep', volume.isLiquiditySweep, SCORES.LIQUIDITY_SWEEP, 'Liquidity sweep pattern');
    this.addFactor(factors, 'Buy Imbalance', volume.buyPressure > 65, SCORES.BUY_IMBALANCE, `Buy pressure: ${volume.buyPressure.toFixed(1)}%`);
    this.addFactor(factors, 'Sell Imbalance', volume.buyPressure < 35, SCORES.SELL_IMBALANCE, `Sell pressure: ${(100 - volume.buyPressure).toFixed(1)}%`);
    this.addFactor(factors, 'Spoofing Detected', volume.isSpoofing, SCORES.SPOOFING, 'Potential spoofing activity');

    // ---- Pattern scoring ----
    this.addFactor(factors, 'Breakout', patterns.isBreakout, SCORES.BREAKOUT, 'Price breaking resistance');
    this.addFactor(factors, 'Fake Breakout', patterns.isFakeBreakout, SCORES.FAKE_BREAKOUT, 'Failed breakout - reversal likely');
    this.addFactor(factors, 'Break of Structure', patterns.isBOS, SCORES.BOS, 'Market structure broken');
    this.addFactor(factors, 'Change of Character', patterns.isCHOCH, SCORES.CHOCH, 'Market character changing');
    this.addFactor(factors, 'Order Block', patterns.hasOrderBlock, SCORES.ORDER_BLOCK, 'Price at order block zone');
    this.addFactor(factors, 'Fair Value Gap', patterns.hasFairValueGap, SCORES.FVG, 'Fair value gap fill');
    this.addFactor(factors, 'Trend Continuation', patterns.isTrendContinuation, SCORES.TREND_CONTINUATION, 'Trend structure intact');
    this.addFactor(factors, 'Reversal Pattern', patterns.isReversal, SCORES.REVERSAL, 'Reversal candlestick detected');

    // ---- Indicator scoring ----
    const bullishStack = indicators.ema20 > indicators.ema50 && indicators.ema50 > indicators.ema200;
    const bearishStack = indicators.ema20 < indicators.ema50 && indicators.ema50 < indicators.ema200;
    this.addFactor(factors, 'EMA Bullish Stack', bullishStack, SCORES.EMA_BULLISH_STACK, '20 > 50 > 200 EMA');
    this.addFactor(factors, 'EMA Bearish Stack', bearishStack, SCORES.EMA_BEARISH_STACK, '20 < 50 < 200 EMA');
    this.addFactor(factors, 'RSI Oversold', indicators.rsi < 35, SCORES.RSI_OVERSOLD, `RSI: ${indicators.rsi.toFixed(1)}`);
    this.addFactor(factors, 'RSI Overbought', indicators.rsi > 70, SCORES.RSI_OVERBOUGHT, `RSI: ${indicators.rsi.toFixed(1)}`);
    this.addFactor(factors, 'RSI Bullish Divergence', indicators.rsiDivergence === 'bullish', SCORES.RSI_BULLISH_DIV, 'Bullish RSI divergence');
    this.addFactor(factors, 'RSI Bearish Divergence', indicators.rsiDivergence === 'bearish', SCORES.RSI_BEARISH_DIV, 'Bearish RSI divergence');
    this.addFactor(factors, 'MACD Bullish', indicators.macdHistogram > 0, SCORES.MACD_BULLISH, 'MACD histogram positive');
    this.addFactor(factors, 'MACD Bearish', indicators.macdHistogram < 0, SCORES.MACD_BEARISH, 'MACD histogram negative');
    this.addFactor(factors, 'Price Above VWAP', currentPrice > indicators.vwap, SCORES.PRICE_ABOVE_VWAP, 'Trading above VWAP');
    this.addFactor(factors, 'Price Below VWAP', currentPrice < indicators.vwap, SCORES.PRICE_BELOW_VWAP, 'Trading below VWAP');

    // Accumulate scores
    for (const f of factors) {
      if (!f.active) continue;
      if (f.score > 0) buyScore += f.score;
      else sellScore += Math.abs(f.score);
    }

    const totalScore = buyScore + sellScore;
    const direction: TradeDirection = buyScore >= sellScore ? 'LONG' : 'SHORT';
    const rawConfidence = totalScore > 0 ? (Math.max(buyScore, sellScore) / totalScore) * 100 : 50;
    const confidence = Math.min(Math.round(rawConfidence), 99);
    const strength = this.scoreToStrength(confidence);

    return {
      pair, direction, totalScore, buyScore, sellScore, confidence, strength, factors,
    };
  }

  async buildSignal(
    pair: TradingPair,
    candles: Candle[],
    timeframe: Timeframe,
  ): Promise<TradingSignal | null> {
    const score = await this.computeScore(pair, candles, timeframe);
    if (!score) return null;

    const indicators = computeIndicators(candles)!;
    const volume = analyzeVolume(pair, candles);
    const patterns = analyzePatterns(candles);

    const currentPrice = candles[candles.length - 1]!.close;
    const atr = indicators.atr;
    const isLong = score.direction === 'LONG';

    // Entry, SL, TP based on ATR
    const entry = currentPrice;
    const stopLoss = isLong ? entry - atr * 1.5 : entry + atr * 1.5;
    const riskAmount = Math.abs(entry - stopLoss);
    const takeProfit = isLong ? entry + riskAmount * 2.5 : entry - riskAmount * 2.5;
    const riskReward = riskAmount > 0 ? Math.abs(takeProfit - entry) / riskAmount : 0;

    const reasons = score.factors
      .filter((f) => f.active)
      .map((f) => f.description)
      .slice(0, 6);

    return {
      id: uuidv4(),
      pair,
      direction: score.direction,
      confidence: score.confidence,
      buyScore: score.buyScore,
      sellScore: score.sellScore,
      strength: score.strength,
      entry,
      stopLoss,
      takeProfit,
      riskReward,
      reasons,
      indicators,
      volumeAnalysis: volume,
      patternAnalysis: patterns,
      timestamp: Date.now(),
      timeframe,
      expiresAt: Date.now() + 60 * 60 * 1000, // 1 hour
    };
  }

  private addFactor(
    factors: ConfluenceFactor[],
    name: string,
    active: boolean,
    score: number,
    description: string,
  ): void {
    factors.push({ name, score, weight: Math.abs(score), active, description });
  }

  private scoreToStrength(confidence: number): SignalStrength {
    if (confidence >= 85) return 'VERY_STRONG';
    if (confidence >= 70) return 'STRONG';
    if (confidence >= 55) return 'MODERATE';
    return 'WEAK';
  }
}

export const confluenceEngine = new ConfluenceEngine();
