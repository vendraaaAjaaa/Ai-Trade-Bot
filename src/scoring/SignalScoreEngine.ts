/**
 * =============================================
 * SIGNAL SCORE ENGINE — Phase 7
 * =============================================
 *
 * Status: SHADOW MODE — runs in parallel with the existing AND-chain
 * pipeline but does NOT influence real trade decisions yet.
 *
 * Activation:
 *   Set USE_SCORING_ENGINE=true to switch the pipeline to use this
 *   engine instead of the AND-chain (Phase 8 migration).
 *   Until then, this engine runs after every signal evaluation
 *   for telemetry comparison only.
 *
 * Architecture:
 *   - Each dimension is scored 0–100 independently
 *   - Weighted composite score computed per mode
 *   - Hard vetoes override the total score to 0
 *   - Entry threshold is mode-specific
 *   - Full breakdown logged for A/B comparison
 *
 * Safety:
 *   - All original safety vetoes are replicated in scorers
 *   - Spoofing, fake-breakout, RR<1, manipulative regime → always veto
 *   - No veto can be disabled via feature flags
 */

import { createLogger } from '../utils/logger';
import type { StrategyMode } from '../utils/types2';
import {
  DEFAULT_SCORERS,
  ConfidenceScorer,
  ConsensusScorer,
  QualityScorer,
  MTFScorer,
  RRScorer,
  SessionRegimeScorer,
} from './dimensionScorers';
import {
  DEFAULT_WEIGHTS,
  ENTRY_SCORE_THRESHOLDS,
} from './types';
import type {
  SignalScore,
  ScoreDimension,
  DimensionScorer,
  ScoringContext,
} from './types';

export { SignalScore, ScoringContext };

const log = createLogger('score-engine');

// ─────────────────────────────────────────────────────────────
// Feature flag
// ─────────────────────────────────────────────────────────────

/**
 * When true, scoring engine controls trade decisions (Phase 8).
 * When false (default), engine runs in shadow/logging mode only.
 */
export const USE_SCORING_ENGINE = process.env['USE_SCORING_ENGINE'] === 'true';

export class SignalScoreEngine {
  private readonly scorers: DimensionScorer[];

  constructor(scorers: DimensionScorer[] = DEFAULT_SCORERS) {
    this.scorers = scorers;
  }

  // ─────────────────────────────────────────────────────────────
  /**
   * Evaluate a signal context and return a full score breakdown.
   *
   * This method is always safe to call — it never throws,
   * never writes to Redis, and never modifies external state.
   */
  async evaluate(ctx: ScoringContext): Promise<SignalScore> {
    const mode       = ctx.mode;
    const weights    = DEFAULT_WEIGHTS[mode];
    const threshold  = ENTRY_SCORE_THRESHOLDS[mode];
    const dimensions: ScoreDimension[] = [];
    const vetoReasons: string[] = [];

    for (const scorer of this.scorers) {
      const modeWeight = weights[scorer.name] ?? scorer.weight;
      let raw = 0;
      let detail: string | undefined;
      let veto: string | undefined;

      try {
        const result = await scorer.score(ctx);
        raw    = result.raw;
        detail = result.detail;
        veto   = result.veto;
      } catch (err) {
        log.warn({ err, scorer: scorer.name }, '[ScoreEngine] Scorer threw — using 0');
        raw    = 0;
        detail = `Scorer error: ${String(err)}`;
      }

      if (veto) vetoReasons.push(veto);

      dimensions.push({
        name:          scorer.name,
        rawScore:      raw,
        weight:        modeWeight,
        weightedScore: raw * modeWeight,
        detail,
        isVeto:        !!veto,
        vetoReason:    veto,
      });
    }

    // ---- Sum weighted scores (zero-weight scorers like session_regime are excluded) ----
    const totalWeighted = dimensions
      .filter((d) => !d.isVeto && d.weight > 0)
      .reduce((sum, d) => sum + d.weightedScore, 0);

    const totalWeight = Object.values(weights).reduce((s, w) => s + w, 0);
    const totalScore  = vetoReasons.length > 0 ? 0 : Math.round((totalWeighted / totalWeight) * 100) / 100;

    const recommendation: SignalScore['recommendation'] =
      vetoReasons.length > 0 ? 'SKIP' :
      totalScore >= threshold  ? 'ENTER' :
      totalScore >= threshold * 0.8 ? 'WAIT' : 'SKIP';

    const score: SignalScore = {
      totalScore:     Math.min(100, Math.round(totalScore)),
      isVetoed:       vetoReasons.length > 0,
      vetoReasons,
      dimensions,
      recommendation,
      thresholdUsed:  threshold,
      evaluatedAt:    new Date().toISOString(),
    };

    // ---- Log for shadow A/B comparison ----
    log.info({
      mode,
      total:          score.totalScore,
      threshold,
      recommendation: score.recommendation,
      vetoed:         score.isVetoed,
      vetoReasons:    vetoReasons.length > 0 ? vetoReasons : undefined,
      breakdown: Object.fromEntries(
        dimensions.map((d) => [d.name, `${d.rawScore}×${d.weight.toFixed(2)}=${d.weightedScore.toFixed(1)}`]),
      ),
    }, USE_SCORING_ENGINE
      ? `🎯 [SCORE ENGINE] ${score.recommendation} (${score.totalScore}/${threshold})`
      : `🔭 [SCORE ENGINE SHADOW] ${score.recommendation} (${score.totalScore}/${threshold}) — advisory only`);

    return score;
  }

  // ─────────────────────────────────────────────────────────────
  /**
   * Compatibility shim: converts the old AND-chain inputs into a
   * ScoringContext so existing callers don't need to change signatures.
   */
  static buildContext(params: {
    mode: StrategyMode;
    confidence: number;
    consensusScore: number;
    qualityScore: number;
    riskReward: number;
    mtfAlignmentScore: number;
    regime: string;
    isManipulative: boolean;
    isChoppy: boolean;
    isFakeBreakout: boolean;
    isSpoofing: boolean;
    sessionAllowed: boolean;
    regimeAllowed: boolean;
    direction: 'LONG' | 'SHORT';
  }): ScoringContext {
    return { ...params };
  }
}

// Singleton for use across the pipeline
export const signalScoreEngine = new SignalScoreEngine();
