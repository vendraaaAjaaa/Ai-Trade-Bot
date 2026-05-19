import type { Position } from '../utils/types';
import type { TradeReview, MarketRegime, SessionName } from '../utils/types2';
import { db } from '../database/connection';
import { createLogger } from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';

const log = createLogger('self-review');

export class SelfReviewEngine {

  async reviewTrade(
    position: Position,
    regimeAtEntry: MarketRegime,
    sessionAtEntry: SessionName,
    signalConfidence: number,
    aiConsensus: number,
    reason: string,
  ): Promise<TradeReview> {
    const pnl = position.realizedPnl;
    const outcome: TradeReview['outcome'] = pnl > 0.5 ? 'win' : pnl < -0.5 ? 'loss' : 'breakeven';

    const executionSlippage = Math.abs(
      (position.entryPrice - position.currentPrice) / position.entryPrice * 100,
    );

    const lessonsLearned = this.deriveLessons(outcome, regimeAtEntry, sessionAtEntry, signalConfidence, aiConsensus, position);
    const whatWorked = this.analyzeWhatWorked(outcome, regimeAtEntry, sessionAtEntry, signalConfidence);
    const whatFailed = this.analyzeWhatFailed(outcome, regimeAtEntry, sessionAtEntry, signalConfidence, reason);

    const entryQuality = this.scoreEntryQuality(signalConfidence, aiConsensus, regimeAtEntry);
    const exitQuality = this.scoreExitQuality(reason, pnl, position);

    const journal = this.generateJournal(
      position, outcome, pnl, regimeAtEntry, sessionAtEntry,
      signalConfidence, aiConsensus, whatWorked, whatFailed, lessonsLearned,
    );

    const review: TradeReview = {
      positionId: position.id,
      pair: position.pair,
      direction: position.direction,
      outcome,
      pnl,
      entryQuality,
      exitQuality,
      regimeAtEntry,
      sessionAtEntry,
      signalConfidence,
      aiConsensus,
      executionSlippage,
      lessonsLearned,
      whatWorked,
      whatFailed,
      journal,
      timestamp: Date.now(),
    };

    await this.persist(review);

    log.info({ positionId: position.id, outcome, pnl: pnl.toFixed(4), regimeAtEntry }, 'Trade review complete');

    return review;
  }

  private deriveLessons(
    outcome: string, regime: MarketRegime, session: SessionName,
    confidence: number, consensus: number, position: Position,
  ): string[] {
    const lessons: string[] = [];

    if (outcome === 'loss') {
      if (regime === 'choppy' || regime === 'ranging') {
        lessons.push(`Avoid trading in ${regime} regime — EMA and volume diverge from price.`);
      }
      if (session === 'asia' || session === 'dead') {
        lessons.push(`${session} session provided insufficient liquidity — prefer London/NY.`);
      }
      if (confidence < 72) {
        lessons.push(`Low confidence (${confidence}%) led to weak setup. Raise minimum threshold.`);
      }
      if (consensus < 60) {
        lessons.push(`Low consensus (${consensus}%) — agents were disagreeing. Stronger consensus required.`);
      }
      const roe = Math.abs(position.roe);
      if (roe > 30) {
        lessons.push('Position sized too large — drawdown exceeded 30% ROE before reversal.');
      }
    }

    if (outcome === 'win') {
      if (regime === 'trending_up' || regime === 'trending_down') {
        lessons.push(`Trading with the ${regime.replace('_', ' ')} regime maximizes probability.`);
      }
      if (session === 'london' || session === 'new_york' || session === 'overlap') {
        lessons.push(`${session} session provided excellent liquidity and momentum.`);
      }
      if (confidence >= 80) {
        lessons.push('High-confidence setups with full confluence continue to outperform.');
      }
    }

    if (lessons.length === 0) {
      lessons.push('Breakeven — review entry timing and confluence strength.');
    }

    return lessons;
  }

  private analyzeWhatWorked(
    outcome: string, regime: MarketRegime, session: SessionName, confidence: number,
  ): string {
    if (outcome === 'win') {
      return `Trade succeeded in ${regime.replace('_', ' ')} regime during ${session} session with ${confidence}% confidence.`;
    }
    if (outcome === 'breakeven') {
      return 'Risk management protected capital despite unclear conditions.';
    }
    return 'SL prevented further loss. Risk management worked as designed.';
  }

  private analyzeWhatFailed(
    outcome: string, regime: MarketRegime, session: SessionName,
    confidence: number, closeReason: string,
  ): string {
    if (outcome === 'win') return 'No critical failures — execution was sound.';
    if (outcome === 'breakeven') return 'Entry timing could be improved for better RR capture.';

    const failures: string[] = [];
    if (regime === 'choppy') failures.push('entered in choppy conditions');
    if (session === 'asia' || session === 'dead') failures.push('traded in low-quality session');
    if (confidence < 72) failures.push('confidence below threshold');
    if (closeReason === 'SL_HIT') failures.push('stop loss triggered — direction was wrong');

    return failures.length > 0
      ? `Failed because: ${failures.join(', ')}.`
      : 'Market reversed unexpectedly despite valid setup.';
  }

  private scoreEntryQuality(confidence: number, consensus: number, regime: MarketRegime): string {
    const score = (confidence * 0.5) + (consensus * 0.3) + (regime === 'trending_up' || regime === 'trending_down' ? 20 : 0);
    if (score >= 85) return 'A+ — Institutional quality entry';
    if (score >= 70) return 'B — Good entry with solid confluence';
    if (score >= 55) return 'C — Marginal entry, borderline quality';
    return 'D — Poor entry, should have waited';
  }

  private scoreExitQuality(reason: string, pnl: number, position: Position): string {
    if (reason === 'TP_HIT') return 'A — Full take profit achieved';
    if (reason === 'MANUAL' && pnl > 0) return 'B+ — Profitable manual close';
    if (reason === 'SL_HIT') return 'C — Stop loss hit, risk managed correctly';
    if (reason === 'LIQUIDATED') return 'F — Liquidation, position was oversized';
    if (reason === 'MANUAL' && pnl < 0) return 'C- — Manual close at a loss';
    return 'B — Standard exit';
  }

  private generateJournal(
    position: Position,
    outcome: string,
    pnl: number,
    regime: MarketRegime,
    session: SessionName,
    confidence: number,
    consensus: number,
    whatWorked: string,
    whatFailed: string,
    lessons: string[],
  ): string {
    const emoji = outcome === 'win' ? '✅' : outcome === 'loss' ? '❌' : '⚖️';
    return [
      `${emoji} POST-TRADE REVIEW: ${position.pair} ${position.direction}`,
      `Outcome: ${outcome.toUpperCase()} | PnL: $${pnl.toFixed(4)} | ROE: ${position.roe.toFixed(2)}%`,
      `Regime at entry: ${regime.replace(/_/g, ' ')} | Session: ${session}`,
      `Signal confidence: ${confidence}% | AI consensus: ${consensus}%`,
      ``,
      `What worked: ${whatWorked}`,
      `What failed: ${whatFailed}`,
      ``,
      `Key lessons:`,
      ...lessons.map((l) => `  • ${l}`),
    ].join('\n');
  }

  private async persist(review: TradeReview): Promise<void> {
    await db.query(
      `INSERT INTO ai_analysis (id, position_id, pair, analysis_type, reasoning, confidence, journal, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [
        uuidv4(), review.positionId, review.pair, 'self_review',
        JSON.stringify(review), review.signalConfidence, review.journal,
      ],
    ).catch((err) => log.warn({ err }, 'Failed to persist self-review'));
  }

  async getRecentReviews(limit = 20): Promise<TradeReview[]> {
    const rows = await db.query<{ reasoning: string }>(
      `SELECT reasoning FROM ai_analysis WHERE analysis_type='self_review' ORDER BY created_at DESC LIMIT $1`,
      [limit],
    ).catch(() => []);

    return rows
      .map((r) => { try { return JSON.parse(r.reasoning) as TradeReview; } catch { return null; } })
      .filter((r): r is TradeReview => r !== null);
  }
}

export const selfReviewEngine = new SelfReviewEngine();
