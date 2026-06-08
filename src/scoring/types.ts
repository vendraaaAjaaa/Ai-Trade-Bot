/**
 * =============================================
 * SIGNAL SCORE ENGINE TYPES — Phase 7
 * =============================================
 *
 * These interfaces define the future scoring architecture.
 * The engine itself (SignalScoreEngine.ts) is compiled but NOT
 * used by the live signal pipeline yet — it runs in parallel
 * for comparison only until Phase 8 migrates it fully.
 *
 * Current AND-chain architecture continues to govern real trades.
 */

import type { StrategyMode } from '../utils/types2';

// ─────────────────────────────────────────────────────────────
// Individual scored dimension
// ─────────────────────────────────────────────────────────────

export interface ScoreDimension {
  /** Identifier used in logs and analytics */
  name: string;
  /** Raw score: 0–100 */
  rawScore: number;
  /** Weight factor: 0.0–1.0 */
  weight: number;
  /** Weighted contribution: rawScore × weight */
  weightedScore: number;
  /** Details for debugging */
  detail?: string;
  /**
   * Optional hard veto: if true, the entire engine outputs 0
   * regardless of other scores. This preserves safety gates
   * while still producing a numeric score for analytics.
   */
  isVeto?: boolean;
  vetoReason?: string;
}

// ─────────────────────────────────────────────────────────────
// Final score output
// ─────────────────────────────────────────────────────────────

export interface SignalScore {
  /** 0–100 composite score */
  totalScore: number;
  /** Whether any veto was triggered */
  isVetoed: boolean;
  vetoReasons: string[];
  /** Per-dimension breakdown */
  dimensions: ScoreDimension[];
  /**
   * Recommended action derived from the score.
   * NOTE: this recommendation is advisory only until Phase 8 activation.
   */
  recommendation: 'ENTER' | 'SKIP' | 'WAIT';
  /** Mode-specific thresholds used */
  thresholdUsed: number;
  /** ISO timestamp */
  evaluatedAt: string;
  /** Whether score would have approved in the old AND-chain */
  legacyApproved?: boolean;
}

// ─────────────────────────────────────────────────────────────
// Per-dimension scorer interface
// ─────────────────────────────────────────────────────────────

export interface DimensionScorer {
  name: string;
  weight: number;
  /**
   * Returns a score 0–100 and optional veto.
   * Implementations must be pure — no side effects.
   */
  score(context: ScoringContext): Promise<{ raw: number; detail?: string; veto?: string }>;
}

// ─────────────────────────────────────────────────────────────
// Input context passed to every scorer
// ─────────────────────────────────────────────────────────────

export interface ScoringContext {
  mode: StrategyMode;
  confidence: number;           // 0–100
  consensusScore: number;       // 0–100
  qualityScore: number;         // 0–100
  riskReward: number;           // e.g. 2.3
  mtfAlignmentScore: number;    // 0–100
  regime: string;               // e.g. 'trending_up'
  isManipulative: boolean;
  isChoppy: boolean;
  isFakeBreakout: boolean;
  isSpoofing: boolean;
  sessionAllowed: boolean;
  regimeAllowed: boolean;
  direction: 'LONG' | 'SHORT';
}

// ─────────────────────────────────────────────────────────────
// Weight presets per mode
// ─────────────────────────────────────────────────────────────

export const DEFAULT_WEIGHTS: Record<StrategyMode, Record<string, number>> = {
  safe: {
    confidence: 0.25,
    consensus:  0.25,
    quality:    0.20,
    mtf:        0.15,
    rr:         0.15,
  },
  swing: {
    confidence: 0.22,
    consensus:  0.22,
    quality:    0.18,
    mtf:        0.20,
    rr:         0.18,
  },
  investing: {
    confidence: 0.20,
    consensus:  0.20,
    quality:    0.25,
    mtf:        0.20,
    rr:         0.15,
  },
  aggressive: {
    confidence: 0.30,
    consensus:  0.20,
    quality:    0.15,
    mtf:        0.15,
    rr:         0.20,
  },
  scalping: {
    confidence: 0.35,
    consensus:  0.15,
    quality:    0.10,
    mtf:        0.20,
    rr:         0.20,
  },
};

/** Minimum total score required to ENTER, per mode */
export const ENTRY_SCORE_THRESHOLDS: Record<StrategyMode, number> = {
  safe:       82,
  swing:      75,
  investing:  72,
  aggressive: 60,
  scalping:   58,
};
