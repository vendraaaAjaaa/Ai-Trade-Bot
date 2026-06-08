/**
 * =============================================
 * MULTI-TIMEFRAME ANALYSIS — Phase 4
 * =============================================
 *
 * Changes from Phase 4:
 *   - Trigger alignment logic is now mode-aware
 *   - safe / swing:     trendAligned AND rsiOk AND macdAligned  (old strict logic)
 *   - aggressive / scalping: trendAligned OR (rsiOk AND macdAligned)
 *   - Feature flag: ENABLE_RELAXED_MTF=true (default on)
 *   - Telemetry: alignmentScore breakdown logged for debugging
 *   - HTF trend confirmation is ALWAYS required regardless of mode (safety preserved)
 *
 * No changes to:
 *   - Trend timeframe assessment (HTF always strict)
 *   - Structure timeframe assessment (unchanged)
 *   - Timeframe configuration map
 */

import type { Candle, TradingPair, Timeframe } from '../utils/types';
import type { MTFAnalysis, StrategyMode } from '../utils/types2';
import { marketDataService } from '../market/marketDataService';
import { computeIndicators } from '../indicators/indicators';
import { createLogger } from '../utils/logger';

const log = createLogger('mtf');

// ---- Feature flag ----
// Set ENABLE_RELAXED_MTF=false to revert to strict AND logic for all modes
const ENABLE_RELAXED_MTF = process.env['ENABLE_RELAXED_MTF'] !== 'false';

const MTF_CONFIG: Record<StrategyMode, { trend: Timeframe; structure: Timeframe; trigger: Timeframe }> = {
  scalping:   { trend: '1h',  structure: '15m', trigger: '5m'  },
  swing:      { trend: '1d',  structure: '4h',  trigger: '15m' },
  investing:  { trend: '1d',  structure: '4h',  trigger: '1h'  },
  safe:       { trend: '4h',  structure: '1h',  trigger: '15m' },
  aggressive: { trend: '1h',  structure: '15m', trigger: '5m'  },
};

/**
 * Modes that use relaxed trigger logic (OR instead of AND).
 * HTF trend and structure requirements are NEVER relaxed.
 */
const RELAXED_TRIGGER_MODES: StrategyMode[] = ['aggressive', 'scalping'];

export class MultiTimeframeAnalysis {

  async analyze(pair: TradingPair, mode: StrategyMode, signalDirection: 'LONG' | 'SHORT'): Promise<MTFAnalysis> {
    const cfg = MTF_CONFIG[mode];
    const useRelaxedTrigger = ENABLE_RELAXED_MTF && RELAXED_TRIGGER_MODES.includes(mode);

    const [trendCandles, structureCandles, triggerCandles] = await Promise.all([
      marketDataService.fetchCandles(pair, cfg.trend, 200),
      marketDataService.fetchCandles(pair, cfg.structure, 200),
      marketDataService.fetchCandles(pair, cfg.trigger, 100),
    ]);

    const trendA     = this.assessTimeframe(trendCandles, signalDirection, 'trend', false);
    const structureA = this.assessTimeframe(structureCandles, signalDirection, 'structure', false);
    const triggerA   = this.assessTimeframe(triggerCandles, signalDirection, 'trigger', useRelaxedTrigger);

    const overallAligned  = trendA.aligned && structureA.aligned && triggerA.aligned;
    const alignmentScore  =
      (trendA.aligned     ? 50 : 0) +
      (structureA.aligned ? 30 : 0) +
      (triggerA.aligned   ? 20 : 0);

    let rejectionReason: string | undefined;
    if (!trendA.aligned) {
      rejectionReason = `HTF (${cfg.trend}) trend opposes signal direction`;
    } else if (!structureA.aligned) {
      rejectionReason = `Structure (${cfg.structure}) is not aligned`;
    } else if (!triggerA.aligned) {
      rejectionReason = useRelaxedTrigger
        ? `Trigger (${cfg.trigger}) failed relaxed check: needs trendAligned OR (rsiOk AND macdAligned)`
        : `Trigger (${cfg.trigger}) not ready — strict check failed`;
    }

    log.info({
      pair,
      mode,
      relaxedTrigger: useRelaxedTrigger,
      aligned: overallAligned,
      score: alignmentScore,
      trend: { tf: cfg.trend, aligned: trendA.aligned, trend: trendA.trend },
      structure: { tf: cfg.structure, aligned: structureA.aligned },
      trigger: { tf: cfg.trigger, aligned: triggerA.aligned },
      rejection: rejectionReason,
    }, 'MTF analysis');

    const result: MTFAnalysis = {
      pair, strategyMode: mode,
      trendTimeframe:     { tf: cfg.trend,     trend: trendA.trend,     aligned: trendA.aligned     },
      structureTimeframe: { tf: cfg.structure, structure: structureA.trend, aligned: structureA.aligned },
      triggerTimeframe:   { tf: cfg.trigger,   ready: triggerA.aligned  },
      overallAligned, alignmentScore, rejectionReason,
      timestamp: Date.now(),
    };

    return result;
  }

  /**
   * Assess whether a single timeframe is aligned with the signal direction.
   *
   * @param relaxedTrigger  When true (aggressive/scalping trigger TF only),
   *                        use OR logic: trendAligned OR (rsiOk AND macdAligned).
   *                        This is ONLY passed as true for the trigger timeframe.
   */
  private assessTimeframe(
    candles: Candle[],
    direction: 'LONG' | 'SHORT',
    role: string,
    relaxedTrigger: boolean,
  ): { trend: string; aligned: boolean; components?: { trendAligned: boolean; rsiOk: boolean; macdAligned: boolean } } {
    if (candles.length < 50) return { trend: 'unknown', aligned: false };

    const indicators = computeIndicators(candles);
    if (!indicators)    return { trend: 'unknown', aligned: false };

    const trend = indicators.trend;
    const price = candles[candles.length - 1]!.close;

    const rsiOk =
      direction === 'LONG'  ? indicators.rsi < 75 :
      direction === 'SHORT' ? indicators.rsi > 25 : true;

    const macdAligned =
      direction === 'LONG'  ? indicators.macdHistogram > 0 :
      direction === 'SHORT' ? indicators.macdHistogram < 0 : true;

    const trendAligned =
      (direction === 'LONG'  && (trend === 'bullish' || (trend === 'ranging' && price > indicators.vwap))) ||
      (direction === 'SHORT' && (trend === 'bearish' || (trend === 'ranging' && price < indicators.vwap)));

    let aligned: boolean;

    if (role === 'trigger') {
      if (relaxedTrigger) {
        // Phase 4: OR logic — one path is sufficient for fast modes
        aligned = trendAligned || (rsiOk && macdAligned);
      } else {
        // Legacy strict logic for safe/swing
        aligned = trendAligned && rsiOk && macdAligned;
      }
    } else {
      // Trend and structure timeframes always use strict trend-only check
      aligned = trendAligned;
    }

    return {
      trend,
      aligned,
      components: { trendAligned, rsiOk, macdAligned },
    };
  }
}

export const mtfAnalysis = new MultiTimeframeAnalysis();
