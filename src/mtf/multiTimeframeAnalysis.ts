import type { Candle, TradingPair, Timeframe } from '../utils/types';
import type { MTFAnalysis, StrategyMode } from '../utils/types2';
import { marketDataService } from '../market/marketDataService';
import { computeIndicators } from '../indicators/indicators';
import { createLogger } from '../utils/logger';

const log = createLogger('mtf');

const MTF_CONFIG: Record<StrategyMode, { trend: Timeframe; structure: Timeframe; trigger: Timeframe }> = {
  scalping: { trend: '1h', structure: '15m', trigger: '5m' },
  swing: { trend: '1d', structure: '4h', trigger: '15m' },
  investing: { trend: '1d', structure: '4h', trigger: '1h' },
  safe: { trend: '4h', structure: '1h', trigger: '15m' },
  aggressive: { trend: '1h', structure: '15m', trigger: '5m' },
};

export class MultiTimeframeAnalysis {

  async analyze(pair: TradingPair, mode: StrategyMode, signalDirection: 'LONG' | 'SHORT'): Promise<MTFAnalysis> {
    const cfg = MTF_CONFIG[mode];

    const [trendCandles, structureCandles, triggerCandles] = await Promise.all([
      marketDataService.fetchCandles(pair, cfg.trend, 200),
      marketDataService.fetchCandles(pair, cfg.structure, 200),
      marketDataService.fetchCandles(pair, cfg.trigger, 100),
    ]);

    const trendA = this.assessTimeframe(trendCandles, signalDirection, 'trend');
    const structureA = this.assessTimeframe(structureCandles, signalDirection, 'structure');
    const triggerA = this.assessTimeframe(triggerCandles, signalDirection, 'trigger');

    const overallAligned = trendA.aligned && structureA.aligned && triggerA.aligned;
    const alignmentScore = (trendA.aligned ? 50 : 0) + (structureA.aligned ? 30 : 0) + (triggerA.aligned ? 20 : 0);

    let rejectionReason: string | undefined;
    if (!trendA.aligned) rejectionReason = `HTF (${cfg.trend}) trend opposes signal direction`;
    else if (!structureA.aligned) rejectionReason = `Structure (${cfg.structure}) is not aligned`;
    else if (!triggerA.aligned) rejectionReason = `Trigger (${cfg.trigger}) not ready`;

    const result: MTFAnalysis = {
      pair, strategyMode: mode,
      trendTimeframe: { tf: cfg.trend, trend: trendA.trend, aligned: trendA.aligned },
      structureTimeframe: { tf: cfg.structure, structure: structureA.trend, aligned: structureA.aligned },
      triggerTimeframe: { tf: cfg.trigger, ready: triggerA.aligned },
      overallAligned, alignmentScore, rejectionReason,
      timestamp: Date.now(),
    };

    log.info({ pair, mode, aligned: overallAligned, score: alignmentScore, rejection: rejectionReason }, 'MTF analysis');
    return result;
  }

  private assessTimeframe(
    candles: Candle[],
    direction: 'LONG' | 'SHORT',
    role: string,
  ): { trend: string; aligned: boolean } {
    if (candles.length < 50) return { trend: 'unknown', aligned: false };

    const indicators = computeIndicators(candles);
    if (!indicators) return { trend: 'unknown', aligned: false };

    const trend = indicators.trend;
    const price = candles[candles.length - 1]!.close;

    const rsiOk =
      direction === 'LONG' ? indicators.rsi < 75 :
        direction === 'SHORT' ? indicators.rsi > 25 : true;

    const macdAligned =
      direction === 'LONG' ? indicators.macdHistogram > 0 :
        direction === 'SHORT' ? indicators.macdHistogram < 0 : true;

    const trendAligned =
      (direction === 'LONG' && (trend === 'bullish' || (trend === 'ranging' && price > indicators.vwap))) ||
      (direction === 'SHORT' && (trend === 'bearish' || (trend === 'ranging' && price < indicators.vwap)));

    const aligned = role === 'trigger'
      ? trendAligned && rsiOk && macdAligned
      : trendAligned;

    return { trend, aligned };
  }
}

export const mtfAnalysis = new MultiTimeframeAnalysis();
