/**
 * =============================================
 * DIMENSION SCORERS — Phase 7
 * =============================================
 *
 * Each scorer is an independent, testable unit that evaluates
 * one aspect of the signal and returns a 0–100 raw score plus
 * an optional hard veto.
 *
 * Scorers are pure functions (no side effects, no Redis, no DB).
 * All safety vetoes are preserved and enforced here too.
 */

import type { DimensionScorer, ScoringContext } from './types';

// ─────────────────────────────────────────────────────────────
// Confidence Scorer
// ─────────────────────────────────────────────────────────────
export const ConfidenceScorer: DimensionScorer = {
  name:   'confidence',
  weight: 0.25, // overridden by mode weights at runtime

  async score(ctx: ScoringContext) {
    const raw = Math.min(100, Math.max(0, ctx.confidence));
    return {
      raw,
      detail: `Signal confidence: ${raw}%`,
    };
  },
};

// ─────────────────────────────────────────────────────────────
// Consensus Scorer
// ─────────────────────────────────────────────────────────────
export const ConsensusScorer: DimensionScorer = {
  name:   'consensus',
  weight: 0.20,

  async score(ctx: ScoringContext) {
    return {
      raw: Math.min(100, Math.max(0, ctx.consensusScore)),
      detail: `Consensus: ${ctx.consensusScore}/100`,
    };
  },
};

// ─────────────────────────────────────────────────────────────
// Market Quality Scorer
// ─────────────────────────────────────────────────────────────
export const QualityScorer: DimensionScorer = {
  name:   'quality',
  weight: 0.18,

  async score(ctx: ScoringContext) {
    // Veto: spoofing or fake breakout always blocks regardless of score
    if (ctx.isSpoofing) {
      return { raw: 0, detail: 'VETO: spoofing detected', veto: 'Spoofing detected — capital at risk' };
    }
    if (ctx.isFakeBreakout) {
      return { raw: 0, detail: 'VETO: fake breakout', veto: 'Fake breakout pattern — do not enter' };
    }
    if (ctx.isManipulative) {
      return { raw: 0, detail: 'VETO: manipulative regime', veto: 'Manipulative market regime detected' };
    }

    return {
      raw:    Math.min(100, Math.max(0, ctx.qualityScore)),
      detail: `Market quality: ${ctx.qualityScore}/100`,
    };
  },
};

// ─────────────────────────────────────────────────────────────
// MTF Alignment Scorer
// ─────────────────────────────────────────────────────────────
export const MTFScorer: DimensionScorer = {
  name:   'mtf',
  weight: 0.17,

  async score(ctx: ScoringContext) {
    return {
      raw:    Math.min(100, Math.max(0, ctx.mtfAlignmentScore)),
      detail: `MTF alignment: ${ctx.mtfAlignmentScore}/100`,
    };
  },
};

// ─────────────────────────────────────────────────────────────
// Risk/Reward Scorer
// ─────────────────────────────────────────────────────────────
export const RRScorer: DimensionScorer = {
  name:   'rr',
  weight: 0.20,

  async score(ctx: ScoringContext) {
    const rr = ctx.riskReward;

    // Veto: RR below 1:1 is never acceptable — hard safety
    if (rr < 1.0) {
      return { raw: 0, detail: `VETO: RR ${rr.toFixed(2)} < 1:1`, veto: `RR ${rr.toFixed(2)}:1 below minimum 1:1` };
    }

    // Score curve: 1.0 = 30 pts, 1.5 = 50, 2.0 = 65, 2.5 = 80, 3.0+ = 95-100
    let raw: number;
    if      (rr >= 3.5) raw = 100;
    else if (rr >= 3.0) raw = 95;
    else if (rr >= 2.5) raw = 85;
    else if (rr >= 2.0) raw = 72;
    else if (rr >= 1.5) raw = 55;
    else                raw = 35; // 1.0–1.5: low but above veto

    return {
      raw,
      detail: `RR ${rr.toFixed(2)}:1 → ${raw}/100`,
    };
  },
};

// ─────────────────────────────────────────────────────────────
// Session / Regime Safety Scorer (hard gate wrapper)
// ─────────────────────────────────────────────────────────────
export const SessionRegimeScorer: DimensionScorer = {
  name:   'session_regime',
  weight: 0, // zero weight — this scorer only emits vetoes

  async score(ctx: ScoringContext) {
    if (!ctx.sessionAllowed) {
      return { raw: 0, detail: 'VETO: session blocked', veto: 'Current session is not tradeable' };
    }
    if (!ctx.regimeAllowed) {
      return { raw: 0, detail: 'VETO: regime blocked', veto: 'Regime does not allow trading' };
    }
    return { raw: 100, detail: 'Session and regime OK' };
  },
};

// Default scorer registry
export const DEFAULT_SCORERS: DimensionScorer[] = [
  ConfidenceScorer,
  ConsensusScorer,
  QualityScorer,
  MTFScorer,
  RRScorer,
  SessionRegimeScorer,
];
