import type { TradingSignal } from '../utils/types';
import type {
  PatienceDecision, RegimeAnalysis, MarketQualityScore,
  SessionInfo, MTFAnalysis, StrategyMode,
} from '../utils/types2';
import { createLogger } from '../utils/logger';

const log = createLogger('patience');

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
};

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

    // ---- Critical blockers (hard NO) ----
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

    // ---- Soft filters ----
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

    // ---- Decision logic ----
    const criticalFails = checks.filter((c) => !c.pass && c.critical);
    const softFails = checks.filter((c) => !c.pass && !c.critical);
    const totalFails = criticalFails.length + softFails.length;

    if (criticalFails.length > 0) {
      return {
        shouldTrade: false,
        reason: criticalFails[0]!.reason,
        quality: 'no_trade',
        waitForCondition: this.suggestWaitCondition(regime, quality, session),
        psychologicalNote: this.randomNote('no_trade'),
        timestamp: Date.now(),
      };
    }

    if (softFails.length >= 3) {
      return {
        shouldTrade: false,
        reason: `Multiple soft criteria failed: ${softFails.map((f) => f.reason).slice(0, 2).join('; ')}`,
        quality: 'poor',
        waitForCondition: 'Wait for MTF alignment and higher confidence score',
        estimatedWaitMinutes: 15,
        psychologicalNote: this.randomNote('poor'),
        timestamp: Date.now(),
      };
    }

    if (softFails.length === 2) {
      return {
        shouldTrade: false,
        reason: softFails.map((f) => f.reason).join('; '),
        quality: 'marginal',
        waitForCondition: softFails[0]!.reason,
        estimatedWaitMinutes: 5,
        psychologicalNote: this.randomNote('marginal'),
        timestamp: Date.now(),
      };
    }

    if (softFails.length === 1) {
      // One soft fail — tradeable in aggressive, swing, and scalping modes
      if (mode === 'aggressive' || mode === 'swing' || mode === 'scalping') {
        return {
          shouldTrade: true,
          reason: `${mode} mode: proceeding despite minor concern: ${softFails[0]!.reason}`,
          quality: 'good',
          psychologicalNote: this.randomNote('good'),
          timestamp: Date.now(),
        };
      }
      return {
        shouldTrade: false,
        reason: softFails[0]!.reason,
        quality: 'marginal',
        waitForCondition: softFails[0]!.reason,
        estimatedWaitMinutes: 3,
        psychologicalNote: this.randomNote('marginal'),
        timestamp: Date.now(),
      };
    }

    // All checks pass
    const qualityLabel = quality.total >= 85 ? 'excellent' : 'good';
    return {
      shouldTrade: true,
      reason: `All patience criteria met — ${qualityLabel} setup`,
      quality: qualityLabel,
      psychologicalNote: this.randomNote(qualityLabel),
      timestamp: Date.now(),
    };
  }

  private minConfidence(mode: StrategyMode): number {
    return { scalping: 72, swing: 75, investing: 70, safe: 90, aggressive: 60 }[mode];
  }

  private minRR(mode: StrategyMode): number {
    return { scalping: 1.5, swing: 2.0, investing: 2.5, safe: 2.5, aggressive: 1.2 }[mode];
  }

  private suggestWaitCondition(regime: RegimeAnalysis, quality: MarketQualityScore, session: SessionInfo): string {
    if (!session.tradingAllowed) return 'Wait for London or New York session';
    if (regime.isChoppy) return 'Wait for ATR expansion and EMA directional bias';
    if (regime.isManipulative) return 'Wait for manipulation activity to subside';
    if (quality.total < 50) return 'Wait for market quality to improve above 70';
    return 'Wait for all confluence factors to align';
  }

  private randomNote(quality: keyof typeof PATIENCE_NOTES): string {
    const notes = PATIENCE_NOTES[quality];
    return notes[Math.floor(Math.random() * notes.length)]!;
  }
}

export const patienceEngine = new PatienceEngine();
