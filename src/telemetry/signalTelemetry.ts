/**
 * =============================================
 * SIGNAL TELEMETRY ENGINE — Phase 1
 * =============================================
 *
 * Purpose:
 *   Track every signal evaluation attempt, record why each one
 *   was approved or rejected, and expose rolling analytics.
 *
 * Principles:
 *   - Zero impact on signal behavior (pure instrumentation)
 *   - Graceful degradation: if Redis fails, logs still work
 *   - DEBUG_SIGNAL_FLOW=true → verbose per-signal logs
 *   - All counters are daily-bucketed (auto-expire at midnight UTC)
 */

import { redis } from '../redis/client';
import { createLogger } from '../utils/logger';
import { config } from '../config';
import type {
  EntryCheckReport,
  FilterCheckResult,
  RejectionCategory,
  SignalAnalyticsSnapshot,
} from './types';

const log = createLogger('telemetry');

// ---- Feature flag ----
const DEBUG_SIGNAL_FLOW = config.featureFlags.debugSignalFlow;

// ---- Redis key builders ----
const today = (): string => new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"

const RejectionKeys: Record<RejectionCategory, () => string> = {
  frequency:  () => `telemetry:rejected:frequency:${today()}`,
  regime:     () => `telemetry:rejected:regime:${today()}`,
  session:    () => `telemetry:rejected:session:${today()}`,
  quality:    () => `telemetry:rejected:quality:${today()}`,
  confidence: () => `telemetry:rejected:confidence:${today()}`,
  mtf:        () => `telemetry:rejected:mtf:${today()}`,
  patience:   () => `telemetry:rejected:patience:${today()}`,
  consensus:  () => `telemetry:rejected:consensus:${today()}`,
  risk:       () => `telemetry:rejected:risk:${today()}`,
  rr:         () => `telemetry:rejected:rr:${today()}`,
};

const CounterKeys = {
  evaluated:         () => `telemetry:evaluated:${today()}`,
  approved:          () => `telemetry:approved:${today()}`,
  rejected:          () => `telemetry:rejected:total:${today()}`,
  // Rolling confidence/consensus — stored as JSON array (last 200 values)
  confidenceList:    () => `telemetry:confidence_list:${today()}`,
  consensusList:     () => `telemetry:consensus_list:${today()}`,
};

// Counters expire at end of day (30 h to cover timezone drift)
const DAY_TTL = 30 * 3600;

// ---- Public API ----

/**
 * Increment the rejection counter for a given category.
 * Fire-and-forget — never throws.
 */
export async function recordRejection(category: RejectionCategory): Promise<void> {
  try {
    const key = RejectionKeys[category]();
    await redis.incr(key);
    await redis.expire(key, DAY_TTL);
    await redis.incr(CounterKeys.rejected());
    await redis.expire(CounterKeys.rejected(), DAY_TTL);
    await redis.incr(CounterKeys.evaluated());
    await redis.expire(CounterKeys.evaluated(), DAY_TTL);
  } catch (err) {
    log.warn({ err, category }, '[telemetry] recordRejection failed (non-critical)');
  }
}

/**
 * Increment the approved (executed) signal counter and record scores.
 */
export async function recordExecution(confidence: number, consensusScore: number): Promise<void> {
  try {
    await redis.incr(CounterKeys.approved());
    await redis.expire(CounterKeys.approved(), DAY_TTL);
    await redis.incr(CounterKeys.evaluated());
    await redis.expire(CounterKeys.evaluated(), DAY_TTL);

    // Store rolling confidence / consensus for average computation
    const client = redis.getClient();
    await client.lpush(CounterKeys.confidenceList(), String(confidence));
    await client.ltrim(CounterKeys.confidenceList(), 0, 199);
    await client.expire(CounterKeys.confidenceList(), DAY_TTL);

    await client.lpush(CounterKeys.consensusList(), String(consensusScore));
    await client.ltrim(CounterKeys.consensusList(), 0, 199);
    await client.expire(CounterKeys.consensusList(), DAY_TTL);
  } catch (err) {
    log.warn({ err }, '[telemetry] recordExecution failed (non-critical)');
  }
}

/**
 * Build a structured EntryCheckReport and log it.
 * Call this at every evaluation regardless of outcome.
 */
export function generateEntryReport(
  pair: string,
  mode: string,
  checks: FilterCheckResult[],
  outcome: { approved: boolean; direction?: 'LONG' | 'SHORT'; confidence?: number; consensusScore?: number },
): EntryCheckReport {
  const failedChecks = checks.filter((c) => c.result === 'FAIL');
  const firstFail = failedChecks[0];

  const report: EntryCheckReport = {
    pair,
    mode,
    timestamp: Date.now(),
    checks,
    result: outcome.approved ? 'APPROVED' : 'REJECTED',
    rejectionReason: firstFail?.detail,
    rejectionCategory: firstFail?.name as RejectionCategory | undefined,
    direction: outcome.direction,
    confidence: outcome.confidence,
    consensusScore: outcome.consensusScore,
  };

  // ---- Always log a concise summary ----
  const statusIcon = outcome.approved ? '✅' : '❌';
  const failSummary = failedChecks.map((c) => `${c.name}(${c.detail ?? 'fail'})`).join(', ');

  log.info(
    { pair, mode, result: report.result, fails: failSummary || 'none' },
    `${statusIcon} [ENTRY CHECK] ${pair} → ${report.result}`,
  );

  // ---- Detailed block log when debug is enabled ----
  if (DEBUG_SIGNAL_FLOW) {
    const lines: string[] = [
      '',
      '┌─────────────────────────────────────────',
      `│ [ENTRY CHECK] Pair: ${pair}  Mode: ${mode}`,
      '├─────────────────────────────────────────',
    ];

    for (const c of checks) {
      const icon = c.result === 'PASS' ? '✓' : c.result === 'FAIL' ? '✗' : '–';
      const detail = c.detail ? ` (${c.detail})` : '';
      lines.push(`│ ${icon} ${c.name.padEnd(14)} ${c.result}${detail}`);
    }

    lines.push('├─────────────────────────────────────────');
    lines.push(`│ RESULT: ${report.result}${report.rejectionReason ? ` — ${report.rejectionReason}` : ''}`);
    lines.push('└─────────────────────────────────────────');

    log.debug(lines.join('\n'));
  }

  return report;
}

/**
 * Read all daily counters from Redis and build a snapshot.
 */
export async function getAnalyticsSnapshot(): Promise<SignalAnalyticsSnapshot> {
  try {
    const categories: RejectionCategory[] = [
      'frequency', 'regime', 'session', 'quality', 'confidence',
      'mtf', 'patience', 'consensus', 'risk', 'rr',
    ];

    const [evaluatedStr, approvedStr, rejectedStr, ...rejCounts] = await Promise.all([
      redis.get(CounterKeys.evaluated()),
      redis.get(CounterKeys.approved()),
      redis.get(CounterKeys.rejected()),
      ...categories.map((c) => redis.get(RejectionKeys[c]())),
    ]);

    const totalEvaluated = parseInt(evaluatedStr ?? '0', 10);
    const totalApproved  = parseInt(approvedStr  ?? '0', 10);
    const totalRejected  = parseInt(rejectedStr  ?? '0', 10);

    const rejectionsByCategory = Object.fromEntries(
      categories.map((c, i) => [c, parseInt(rejCounts[i] ?? '0', 10)]),
    ) as Record<RejectionCategory, number>;

    // Find top rejection source
    const topRejectionSource = (Object.entries(rejectionsByCategory) as [RejectionCategory, number][])
      .sort(([, a], [, b]) => b - a)[0]?.[0] ?? null;

    // Compute averages from rolling lists
    const client = redis.getClient();
    const confRaw = await client.lrange(CounterKeys.confidenceList(), 0, -1);
    const consRaw = await client.lrange(CounterKeys.consensusList(), 0, -1);

    const avg = (arr: string[]) =>
      arr.length === 0 ? 0 : arr.reduce((s, v) => s + parseFloat(v), 0) / arr.length;

    return {
      totalEvaluated,
      totalApproved,
      totalRejected,
      approvalRate: totalEvaluated === 0 ? 0 : Math.round((totalApproved / totalEvaluated) * 100),
      avgConfidence: Math.round(avg(confRaw)),
      avgConsensusScore: Math.round(avg(consRaw)),
      rejectionsByCategory,
      topRejectionSource,
      generatedAt: new Date().toISOString(),
    };
  } catch (err) {
    log.warn({ err }, '[telemetry] getAnalyticsSnapshot failed, returning empty');
    return {
      totalEvaluated: 0, totalApproved: 0, totalRejected: 0,
      approvalRate: 0, avgConfidence: 0, avgConsensusScore: 0,
      rejectionsByCategory: {} as Record<RejectionCategory, number>,
      topRejectionSource: null,
      generatedAt: new Date().toISOString(),
    };
  }
}

/**
 * Log a formatted analytics summary to the console.
 * Call from bot startup or on Telegram /stats command.
 */
export async function logAnalyticsSummary(): Promise<void> {
  const snap = await getAnalyticsSnapshot();
  log.info({
    evaluated:    snap.totalEvaluated,
    approved:     snap.totalApproved,
    rejected:     snap.totalRejected,
    approvalRate: `${snap.approvalRate}%`,
    avgConfidence: snap.avgConfidence,
    avgConsensus:  snap.avgConsensusScore,
    topRejection:  snap.topRejectionSource ?? 'n/a',
    byCategory:    snap.rejectionsByCategory,
  }, '📊 [SIGNAL ANALYTICS] Daily snapshot');
}
