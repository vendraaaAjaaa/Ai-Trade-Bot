import type { Candle, TradingPair } from '../utils/types';
import type { MarketQualityScore, RegimeAnalysis, SessionInfo } from '../utils/types2';
import { createLogger } from '../utils/logger';
import { redis } from '../redis/client';

const log = createLogger('quality');
const qualityKey = (pair: string) => `quality:${pair}`;

export class MarketQualityEngine {

  async score(
    pair: TradingPair,
    candles: Candle[],
    regime: RegimeAnalysis,
    session: SessionInfo,
  ): Promise<MarketQualityScore> {
    const cached = await redis.getJson<MarketQualityScore>(qualityKey(pair));
    if (cached && Date.now() - cached.timestamp < 90_000) return cached;

    const result = this.compute(candles, regime, session);
    await redis.setJson(qualityKey(pair), result, 90);

    log.info({ pair, total: result.total, grade: result.grade }, 'Market quality scored');
    return result;
  }

  private compute(candles: Candle[], regime: RegimeAnalysis, session: SessionInfo): MarketQualityScore {
    const reasons: string[] = [];
    let trendClarity = 0;
    let liquidityQuality = 0;
    let volatilityQuality = 0;
    let volumeQuality = 0;
    let confirmationStrength = 0;

    // ---- Trend Clarity (0-25) ----
    if (regime.regime === 'trending_up' || regime.regime === 'trending_down') {
      trendClarity = Math.min(25, 10 + regime.trendStrength * 0.15);
      reasons.push(`Clear ${regime.regime.replace('_', ' ')} trend`);
    } else if (regime.regime === 'ranging') {
      trendClarity = 8;
      reasons.push('Ranging market — low trend clarity');
    } else if (regime.regime === 'choppy' || regime.regime === 'manipulative') {
      trendClarity = 0;
      reasons.push(`${regime.regime} conditions — no trend clarity`);
    } else {
      trendClarity = 5;
    }

    // ---- Liquidity Quality (0-20) ----
    if (session.isHighQuality) {
      liquidityQuality = 18;
      reasons.push(`${session.name} session — high liquidity`);
    } else if (session.isActive) {
      liquidityQuality = 12;
    } else {
      liquidityQuality = 3;
      reasons.push('Dead session — low liquidity');
    }
    if (regime.regime === 'low_liquidity') {
      liquidityQuality = Math.max(0, liquidityQuality - 10);
      reasons.push('Low liquidity regime detected');
    }

    // ---- Volatility Quality (0-20) ----
    const atrPct = regime.atrPercent;
    if (atrPct >= 0.3 && atrPct <= 2.0) {
      volatilityQuality = 18;
      reasons.push(`Healthy volatility (ATR: ${atrPct.toFixed(2)}%)`);
    } else if (atrPct > 2.0 && atrPct <= 3.5) {
      volatilityQuality = 10;
      reasons.push(`Elevated volatility (ATR: ${atrPct.toFixed(2)}%)`);
    } else if (atrPct > 3.5) {
      volatilityQuality = 3;
      reasons.push(`Extreme volatility (ATR: ${atrPct.toFixed(2)}%) — dangerous`);
    } else {
      volatilityQuality = 5;
      reasons.push(`Compressed volatility (ATR: ${atrPct.toFixed(2)}%)`);
    }

    // ---- Volume Quality (0-20) ----
    if (candles.length >= 20) {
      const recent = candles.slice(-5);
      const hist = candles.slice(-20, -5);
      const recentAvg = recent.reduce((s, c) => s + c.volume, 0) / recent.length;
      const histAvg = hist.reduce((s, c) => s + c.volume, 0) / hist.length;
      const ratio = histAvg > 0 ? recentAvg / histAvg : 1;

      if (ratio >= 1.2) {
        volumeQuality = 18;
        reasons.push(`Strong volume (${ratio.toFixed(2)}x avg)`);
      } else if (ratio >= 0.8) {
        volumeQuality = 12;
      } else {
        volumeQuality = 4;
        reasons.push('Weak volume below average');
      }
    } else {
      volumeQuality = 8;
    }

    // ---- Confirmation Strength (0-15) ----
    if (!regime.isChoppy && !regime.isManipulative && regime.wickRatio < 0.4) {
      confirmationStrength = 13;
    } else if (regime.wickRatio < 0.55) {
      confirmationStrength = 7;
    } else {
      confirmationStrength = 2;
      reasons.push('High wick ratio — weak confirmation');
    }

    // ---- Manipulation penalty ----
    if (regime.isManipulative) {
      liquidityQuality = Math.max(0, liquidityQuality - 10);
      confirmationStrength = 0;
      reasons.push('WARN: Manipulation signals detected');
    }

    const total = Math.round(trendClarity + liquidityQuality + volatilityQuality + volumeQuality + confirmationStrength);

    const grade: MarketQualityScore['grade'] =
      total >= 90 ? 'excellent' :
      total >= 70 ? 'tradeable' :
      total >= 50 ? 'risky' : 'no_trade';

    const tradingAllowed = total >= 50 && regime.tradingAllowed;

    return {
      total, grade, trendClarity, liquidityQuality, volatilityQuality,
      volumeQuality, confirmationStrength, tradingAllowed, reasons,
      timestamp: Date.now(),
    };
  }

  async getCached(pair: TradingPair): Promise<MarketQualityScore | null> {
    return redis.getJson<MarketQualityScore>(qualityKey(pair));
  }
}

export const marketQualityEngine = new MarketQualityEngine();
