/**
 * =============================================
 * PATIENCE ENGINE — Phase 5
 * =============================================
 *
 * Changes from Phase 5:
 *   - Mode-aware soft-fail tolerance
 *       safe/swing:       max 1 soft fail (unchanged)
 *       aggressive/scalping: max 2 soft fails allowed
 *   - Hard blockers are NEVER relaxed regardless of mode:
 *       - manipulative regime
 *       - session block
 *       - quality.tradingAllowed = false
 *       - isManipulative flag
 *   - Feature flag: ENABLE_SOFT_FAIL_TOLERANCE=true (default on)
 *   - Debug logs explain exactly which soft fails occurred
 *   - neutralConfidenceFloor config respected
 */

import type { TradingSignal } from '../utils/types';
import type {
  PatienceDecision, RegimeAnalysis, MarketQualityScore,
  SessionInfo, MTFAnalysis, StrategyMode,
} from '../utils/types2';
import { createLogger } from '../utils/logger';
import { config } from '../config';

const log = createLogger('patience');

// ---- Feature flag ----
const ENABLE_SOFT_FAIL_TOLERANCE = config.featureFlags.softFailTolerance;

/**
 * Maximum number of soft fails allowed before rejecting, per mode.
 * Legacy: any 2+ soft fails → rejected; 1 soft fail → trade in aggressive/swing/scalping.
 */
const MAX_SOFT_FAILS: Record<StrategyMode, number> = {
  safe:       1,  // unchanged — most conservative
  swing:      1,  // unchanged
  investing:  1,  // unchanged
  aggressive: 2,  // Phase 5 relaxation
  scalping:   2,  // Phase 5 relaxation
};

/** Legacy soft-fail limit (was effectively 1 for aggressive, 0 for safe) */
const LEGACY_MAX_SOFT_FAILS = 1;

// Psychological notes the AI uses to stay disciplined
const PATIENCE_NOTES = {
  excellent: [
    'Setup meets all institutional criteria. Proceed with controlled confidence.',
    'This is the quality of trade worth waiting for. Execute with discipline.',
    'All confluence factors aligned. This is a high-probability setup.',
  ],
  good: [
    'Solid setup. Enter with standard position size.',
    'Good conditions. Manage risk carefully.',
  ],
  marginal: [
    'The best trade is often the trade you do NOT take. Wait for better conditions.',
    'Marginal setup. Institutional traders skip these. Wait for clarity.',
    'Mediocre entry quality. A missed trade is never a lost trade.',
  ],
  poor: [
    'Market is not offering an edge. Preserve capital and observe.',
    'No edge detected. Patient traders sit on their hands.',
    'Uncertainty is high. Sitting out is a valid strategy.',
  ],
  no_trade: [
    'Do not trade. Protect your capital.',
    'Market conditions are unfavorable. Any entry here is gambling.',
    'Discipline means knowing when NOT to trade.',
  ],
} as const;

export class PatienceEngine {

  evaluate(
    signal: TradingSignal,
    regime: RegimeAnalysis,
    quality: MarketQualityScore,
    session: SessionInfo,
    mtf: MTFAnalysis,
    mode: StrategyMode,
  ): PatienceDecision {

    const checks: { pass: boolean; reason: string; critical: boolean }[] = [];

    // ──────────────────────────────────────────────────────────
    // HARD BLOCKERS — these are NEVER relaxed regardless of mode
    // ──────────────────────────────────────────────────────────

    checks.push({
      pass: regime.tradingAllowed,
      reason: `Regime blocks trading: ${regime.regime} (${regime.description})`,
      critical: true,
    });

    checks.push({
      pass: session.tradingAllowed,
      reason: `Session blocks trading: ${session.name} — ${session.description}`,
      critical: true,
    });

    checks.push({
      pass: quality.tradingAllowed,
      reason: `Market quality too low: ${quality.total}/100 (${quality.grade})`,
      critical: true,
    });

    checks.push({
      pass: !regime.isManipulative,
      reason: 'Manipulation detected — skipping to protect capital',
      critical: true,
    });

    // ──────────────────────────────────────────────────────────
    // SOFT FILTERS — relaxable for aggressive/scalping
    // ──────────────────────────────────────────────────────────

    checks.push({
      pass: mtf.overallAligned,
      reason: mtf.rejectionReason ?? 'Multi-timeframe alignment incomplete',
      critical: false,
    });

    checks.push({
      pass: signal.confidence >= this.minConfidence(mode),
      reason: `Signal confidence ${signal.confidence}% below ${this.minConfidence(mode)}% threshold for ${mode} mode`,
      critical: false,
    });

    checks.push({
      pass: signal.riskReward >= this.minRR(mode),
      reason: `RR ${signal.riskReward.toFixed(2)}:1 below ${this.minRR(mode)}:1 minimum for ${mode} mode`,
      critical: false,
    });

    checks.push({
      pass: !regime.isChoppy,
      reason: 'Choppy market detected — waiting for clear directional bias',
      critical: false,
    });

    checks.push({
      pass: quality.total >= 60,
      reason: `Market quality ${quality.total}/100 is below 60 — conditions are risky`,
      critical: false,
    });

    // ──────────────────────────────────────────────────────────
    // Decision logic
    // ──────────────────────────────────────────────────────────
    const criticalFails = checks.filter((c) => !c.pass && c.critical);
    const softFails     = checks.filter((c) => !c.pass && !c.critical);
    const maxAllowed    = ENABLE_SOFT_FAIL_TOLERANCE ? MAX_SOFT_FAILS[mode] : LEGACY_MAX_SOFT_FAILS;

    // Debug log breakdown
    log.info({
      mode,
      softFails:    softFails.length,
      criticalFails: criticalFails.length,
      maxAllowed,
      softFailDetails: softFails.map((f) => f.reason),
    }, `[PATIENCE] Check complete — soft fails: ${softFails.length}/${maxAllowed}`);

    // ---- Hard blockers: immediate NO regardless of mode ----
    if (criticalFails.length > 0) {
      log.warn({ mode, reason: criticalFails[0]!.reason }, '[PATIENCE] Critical blocker — trade rejected');
      return {
        shouldTrade: false,
        reason: criticalFails[0]!.reason,
        quality: 'no_trade',
        waitForCondition: this.suggestWaitCondition(regime, quality, session),
        psychologicalNote: this.randomNote('no_trade'),
        timestamp: Date.now(),
      };
    }

    // ---- Too many soft fails for this mode ----
    if (softFails.length > maxAllowed) {
      const qualityLabel = softFails.length >= 3 ? 'poor' : 'marginal';
      log.info({
        mode, softFails: softFails.length, maxAllowed,
      }, `[PATIENCE] Soft fail overflow (${softFails.length} > ${maxAllowed}) — trade rejected`);
      return {
        shouldTrade: false,
        reason: `Too many soft fails (${softFails.length}/${maxAllowed} max): ${softFails.map((f) => f.reason).slice(0, 2).join('; ')}`,
        quality: qualityLabel as 'poor' | 'marginal',
        waitForCondition: 'Wait for MTF alignment and higher confidence score',
        estimatedWaitMinutes: softFails.length >= 3 ? 15 : 5,
        psychologicalNote: this.randomNote(qualityLabel as keyof typeof PATIENCE_NOTES),
        timestamp: Date.now(),
      };
    }

    // ---- Within soft-fail budget — trade is allowed ----
    if (softFails.length > 0) {
      log.info({
        mode, softFails: softFails.length, maxAllowed,
      }, `[PATIENCE] ${softFails.length} soft fail(s) within ${mode} budget — proceeding`);
      return {
        shouldTrade: true,
        reason: `${mode} mode: proceeding with ${softFails.length}/${maxAllowed} soft concern(s): ${softFails[0]!.reason}`,
        quality: 'good',
        psychologicalNote: this.randomNote('good'),
        timestamp: Date.now(),
      };
    }

    // ---- All checks pass ----
    const qualityLabel = quality.total >= 85 ? 'excellent' : 'good';
    return {
      shouldTrade: true,
      reason: `All patience criteria met — ${qualityLabel} setup`,
      quality: qualityLabel as 'excellent' | 'good',
      psychologicalNote: this.randomNote(qualityLabel as keyof typeof PATIENCE_NOTES),
      timestamp: Date.now(),
    };
  }

  private minConfidence(mode: StrategyMode): number {
    return ({ scalping: 72, swing: 75, investing: 70, safe: 90, aggressive: 60 } as Record<StrategyMode, number>)[mode];
  }

  private minRR(mode: StrategyMode): number {
    return ({ scalping: 1.5, swing: 2.0, investing: 2.5, safe: 2.5, aggressive: 1.2 } as Record<StrategyMode, number>)[mode];
  }

  private suggestWaitCondition(
    regime: RegimeAnalysis,
    quality: MarketQualityScore,
    session: SessionInfo,
  ): string {
    if (!session.tradingAllowed) return 'Wait for London or New York session';
    if (regime.isChoppy)        return 'Wait for ATR expansion and EMA directional bias';
    if (regime.isManipulative)  return 'Wait for manipulation activity to subside';
    if (quality.total < 50)     return 'Wait for market quality to improve above 70';
    return 'Wait for all confluence factors to align';
  }

  private randomNote(quality: keyof typeof PATIENCE_NOTES): string {
    const notes = PATIENCE_NOTES[quality];
    return notes[Math.floor(Math.random() * notes.length)]!;
  }
}

export const patienceEngine = new PatienceEngine();
