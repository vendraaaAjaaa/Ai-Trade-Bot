// =============================================
// TELEMETRY TYPES — Phase 1
// Structured analytics for signal flow debugging
// =============================================

export type RejectionCategory =
  | 'frequency'
  | 'regime'
  | 'session'
  | 'quality'
  | 'confidence'
  | 'mtf'
  | 'patience'
  | 'consensus'
  | 'risk'
  | 'rr';

export type FilterResult = 'PASS' | 'FAIL' | 'SKIPPED';

/**
 * Per-filter check result within a single signal evaluation
 */
export interface FilterCheckResult {
  name: string;
  result: FilterResult;
  /** Human-readable reason when FAIL */
  detail?: string;
  /** Numeric value that triggered the check (e.g. confidence score) */
  value?: number;
  /** Threshold that was tested against */
  threshold?: number;
}

/**
 * Full structured report for one signal evaluation attempt.
 * Generated regardless of outcome (APPROVED or REJECTED).
 */
export interface EntryCheckReport {
  pair: string;
  mode: string;
  timestamp: number;
  checks: FilterCheckResult[];
  /** APPROVED | REJECTED */
  result: 'APPROVED' | 'REJECTED';
  /** Primary reason for rejection (undefined on approval) */
  rejectionReason?: string;
  /** Which category caused the rejection */
  rejectionCategory?: RejectionCategory;
  /** Signal direction if a signal was generated */
  direction?: 'LONG' | 'SHORT';
  /** Confidence score if available */
  confidence?: number;
  /** Consensus score if available */
  consensusScore?: number;
}

/**
 * Rolling analytics snapshot — periodically computed from Redis counters
 */
export interface SignalAnalyticsSnapshot {
  totalEvaluated: number;
  totalApproved: number;
  totalRejected: number;
  approvalRate: number;            // 0-100 %
  avgConfidence: number;
  avgConsensusScore: number;
  rejectionsByCategory: Record<RejectionCategory, number>;
  topRejectionSource: RejectionCategory | null;
  /** ISO timestamp of snapshot */
  generatedAt: string;
}
