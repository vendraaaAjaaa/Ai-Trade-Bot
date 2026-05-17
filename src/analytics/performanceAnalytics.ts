import { db } from '../database/connection';
import { createLogger } from '../utils/logger';
import type { PerformanceMetrics } from '../utils/types';

const log = createLogger('analytics');

interface DBPosition {
  id: string;
  pair: string;
  direction: string;
  realized_pnl: string;
  entry_price: string;
  stop_loss: string;
  take_profit: string;
  status: string;
  opened_at: string;
  closed_at: string | null;
  mode: string;
}

export class PerformanceAnalytics {
  async getMetrics(
    pair?: string,
    fromTs?: number,
    toTs?: number,
    mode = 'dryrun',
  ): Promise<PerformanceMetrics> {
    let sql = `SELECT * FROM positions WHERE status IN ('CLOSED','LIQUIDATED') AND mode=$1`;
    const params: (string | number)[] = [mode];

    if (pair) { sql += ` AND pair=$${params.length + 1}`; params.push(pair); }
    if (fromTs) { sql += ` AND opened_at >= $${params.length + 1}`; params.push(fromTs); }
    if (toTs) { sql += ` AND opened_at <= $${params.length + 1}`; params.push(toTs); }

    sql += ' ORDER BY closed_at ASC';

    const positions = await db.query<DBPosition>(sql, params);

    if (positions.length === 0) {
      return this.emptyMetrics();
    }

    const pnls = positions.map((p) => parseFloat(p.realized_pnl));
    const winners = pnls.filter((p) => p > 0);
    const losers = pnls.filter((p) => p <= 0);

    const winRate = positions.length > 0 ? (winners.length / positions.length) * 100 : 0;
    const totalPnl = pnls.reduce((a, b) => a + b, 0);
    const avgWin = winners.length > 0 ? winners.reduce((a, b) => a + b, 0) / winners.length : 0;
    const avgLoss = losers.length > 0 ? Math.abs(losers.reduce((a, b) => a + b, 0) / losers.length) : 0;
    const profitFactor = avgLoss > 0 ? (avgWin * winners.length) / (avgLoss * losers.length) : winners.length > 0 ? 999 : 0;

    // Max drawdown calculation
    let peak = 0;
    let running = 0;
    let maxDrawdown = 0;
    for (const pnl of pnls) {
      running += pnl;
      if (running > peak) peak = running;
      const dd = peak - running;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }

    // Consecutive wins/losses
    let consecWins = 0;
    let consecLosses = 0;
    let maxConsecWins = 0;
    let maxConsecLosses = 0;
    let currWins = 0;
    let currLosses = 0;

    for (const pnl of pnls) {
      if (pnl > 0) { currWins++; currLosses = 0; }
      else { currLosses++; currWins = 0; }
      if (currWins > maxConsecWins) maxConsecWins = currWins;
      if (currLosses > maxConsecLosses) maxConsecLosses = currLosses;
    }
    consecWins = currWins;
    consecLosses = currLosses;

    // Average RR
    const rrList = positions
      .filter((p) => p.stop_loss && p.take_profit && p.entry_price)
      .map((p) => {
        const entry = parseFloat(p.entry_price);
        const sl = parseFloat(p.stop_loss);
        const tp = parseFloat(p.take_profit);
        const risk = Math.abs(entry - sl);
        return risk > 0 ? Math.abs(tp - entry) / risk : 0;
      });
    const avgRR = rrList.length > 0 ? rrList.reduce((a, b) => a + b, 0) / rrList.length : 0;

    // Sharpe ratio (simplified)
    const mean = totalPnl / pnls.length;
    const variance = pnls.reduce((s, p) => s + Math.pow(p - mean, 2), 0) / pnls.length;
    const stdDev = Math.sqrt(variance);
    const sharpeRatio = stdDev > 0 ? (mean / stdDev) * Math.sqrt(252) : 0;

    // Expectancy
    const expectancy = (winRate / 100) * avgWin - ((100 - winRate) / 100) * avgLoss;

    const from = parseInt(positions[0]?.opened_at ?? '0');
    const to = parseInt(positions[positions.length - 1]?.opened_at ?? '0');

    return {
      totalTrades: positions.length,
      winningTrades: winners.length,
      losingTrades: losers.length,
      winRate,
      profitFactor,
      totalPnl,
      maxDrawdown,
      maxDrawdownPercent: totalPnl > 0 ? (maxDrawdown / (totalPnl + maxDrawdown)) * 100 : 0,
      avgRR,
      avgWin,
      avgLoss,
      consecutiveWins: consecWins,
      consecutiveLosses: consecLosses,
      maxConsecutiveWins: maxConsecWins,
      maxConsecutiveLosses: maxConsecLosses,
      sharpeRatio,
      expectancy,
      period: { from, to },
    };
  }

  async getDailyPnl(mode = 'dryrun', days = 30): Promise<{ date: string; pnl: number; trades: number }[]> {
    const rows = await db.query<{ date: string; pnl: string; trades: string }>(
      `SELECT DATE(TO_TIMESTAMP(closed_at/1000)) as date,
       SUM(realized_pnl) as pnl, COUNT(*) as trades
       FROM positions WHERE status='CLOSED' AND mode=$1
       AND closed_at >= $2
       GROUP BY date ORDER BY date`,
      [mode, Date.now() - days * 86400 * 1000],
    );
    return rows.map((r) => ({
      date: r.date,
      pnl: parseFloat(r.pnl),
      trades: parseInt(r.trades),
    }));
  }

  async getTradeHistory(limit = 50, mode = 'dryrun'): Promise<DBPosition[]> {
    return db.query<DBPosition>(
      `SELECT * FROM positions WHERE mode=$1 ORDER BY opened_at DESC LIMIT $2`,
      [mode, limit],
    );
  }

  private emptyMetrics(): PerformanceMetrics {
    return {
      totalTrades: 0, winningTrades: 0, losingTrades: 0, winRate: 0,
      profitFactor: 0, totalPnl: 0, maxDrawdown: 0, maxDrawdownPercent: 0,
      avgRR: 0, avgWin: 0, avgLoss: 0, consecutiveWins: 0, consecutiveLosses: 0,
      maxConsecutiveWins: 0, maxConsecutiveLosses: 0, sharpeRatio: 0, expectancy: 0,
      period: { from: 0, to: 0 },
    };
  }
}

export const performanceAnalytics = new PerformanceAnalytics();
