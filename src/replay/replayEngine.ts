import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../utils/logger';
import { marketDataService } from '../market/marketDataService';
import { confluenceEngine } from '../confluence/confluenceEngine';
import { performanceAnalytics } from '../analytics/performanceAnalytics';
import type { TradingPair, Timeframe, Candle, TradingSignal, ReplayConfig } from '../utils/types';
import { computeIndicators } from '../indicators/indicators';
import { analyzeVolume } from '../volume/volumeAnalysis';
import { analyzePatterns } from '../patterns/patternAnalysis';

const log = createLogger('replay');

interface ReplayTrade {
  signalId: string;
  pair: TradingPair;
  direction: string;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  exitPrice: number;
  pnl: number;
  rr: number;
  openIdx: number;
  closeIdx: number;
  reason: string;
}

export class ReplayEngine extends EventEmitter {
  private isRunning = false;
  private shouldStop = false;

  constructor() {
    super();
    this.setMaxListeners(20);
  }

  async runReplay(cfg: ReplayConfig): Promise<{
    trades: ReplayTrade[];
    metrics: {
      totalTrades: number;
      winRate: number;
      totalPnl: number;
      maxDrawdown: number;
      profitFactor: number;
    };
  }> {
    if (this.isRunning) throw new Error('Replay already running');

    this.isRunning = true;
    this.shouldStop = false;

    log.info({
      pair: cfg.pair,
      timeframe: cfg.timeframe,
      from: new Date(cfg.startTime).toISOString(),
      to: new Date(cfg.endTime).toISOString(),
    }, 'Starting replay');

    try {
      const allCandles = await marketDataService.getHistoricalCandles(
        cfg.pair,
        cfg.timeframe,
        cfg.startTime,
        cfg.endTime,
      );

      if (allCandles.length < 210) {
        throw new Error(`Not enough historical candles: ${allCandles.length}`);
      }

      const trades: ReplayTrade[] = [];
      let openTrade: ReplayTrade | null = null;
      const minCandlesForSignal = 210;

      for (let i = minCandlesForSignal; i < allCandles.length; i++) {
        if (this.shouldStop) break;

        const candleSlice = allCandles.slice(0, i + 1);
        const current = allCandles[i]!;

        // Emit fake-live candle for dashboard visualization
        this.emit('candle', { pair: cfg.pair, candle: current, index: i, total: allCandles.length });

        // Speed control
        if (cfg.speedMultiplier < 100) {
          await new Promise((r) => setTimeout(r, Math.max(1, 50 / cfg.speedMultiplier)));
        }

        // Check if open trade should close
        if (openTrade) {
          const isLong = openTrade.direction === 'LONG';
          if ((isLong && current.low <= openTrade.stopLoss) || (!isLong && current.high >= openTrade.stopLoss)) {
            openTrade.exitPrice = openTrade.stopLoss;
            openTrade.pnl = isLong
              ? (openTrade.stopLoss - openTrade.entry) / openTrade.entry
              : (openTrade.entry - openTrade.stopLoss) / openTrade.entry;
            openTrade.closeIdx = i;
            openTrade.reason = 'SL_HIT';
            trades.push({ ...openTrade });
            this.emit('trade_closed', openTrade);
            openTrade = null;
          } else if ((isLong && current.high >= openTrade.takeProfit) || (!isLong && current.low <= openTrade.takeProfit)) {
            openTrade.exitPrice = openTrade.takeProfit;
            openTrade.pnl = isLong
              ? (openTrade.takeProfit - openTrade.entry) / openTrade.entry
              : (openTrade.entry - openTrade.takeProfit) / openTrade.entry;
            openTrade.closeIdx = i;
            openTrade.reason = 'TP_HIT';
            trades.push({ ...openTrade });
            this.emit('trade_closed', openTrade);
            openTrade = null;
          }
          continue; // Only one position at a time
        }

        // Generate signal every 5 candles to save compute
        if (i % 5 !== 0) continue;

        const signal = await confluenceEngine.buildSignal(cfg.pair, candleSlice, cfg.timeframe);
        if (!signal || signal.confidence < 70) continue;

        this.emit('signal', signal);

        openTrade = {
          signalId: signal.id,
          pair: cfg.pair,
          direction: signal.direction,
          entry: current.close,
          stopLoss: signal.stopLoss,
          takeProfit: signal.takeProfit,
          exitPrice: 0,
          pnl: 0,
          rr: signal.riskReward,
          openIdx: i,
          closeIdx: 0,
          reason: '',
        };
      }

      // Close any open trade at end
      if (openTrade) {
        const lastCandle = allCandles[allCandles.length - 1]!;
        openTrade.exitPrice = lastCandle.close;
        const isLong = openTrade.direction === 'LONG';
        openTrade.pnl = isLong
          ? (lastCandle.close - openTrade.entry) / openTrade.entry
          : (openTrade.entry - lastCandle.close) / openTrade.entry;
        openTrade.reason = 'REPLAY_END';
        trades.push({ ...openTrade });
      }

      const metrics = this.computeReplayMetrics(trades);

      log.info({
        pair: cfg.pair,
        trades: trades.length,
        winRate: metrics.winRate.toFixed(1),
        totalPnl: metrics.totalPnl.toFixed(4),
      }, 'Replay complete');

      this.emit('replay_complete', { trades, metrics });
      return { trades, metrics };
    } finally {
      this.isRunning = false;
    }
  }

  stop(): void {
    this.shouldStop = true;
  }

  private computeReplayMetrics(trades: ReplayTrade[]) {
    if (trades.length === 0) {
      return { totalTrades: 0, winRate: 0, totalPnl: 0, maxDrawdown: 0, profitFactor: 0 };
    }

    const wins = trades.filter((t) => t.pnl > 0);
    const losses = trades.filter((t) => t.pnl <= 0);
    const winRate = (wins.length / trades.length) * 100;
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);

    let peak = 0;
    let running = 0;
    let maxDrawdown = 0;
    for (const t of trades) {
      running += t.pnl;
      if (running > peak) peak = running;
      const dd = peak - running;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }

    const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : wins.length > 0 ? 999 : 0;

    return { totalTrades: trades.length, winRate, totalPnl, maxDrawdown, profitFactor };
  }

  isActive(): boolean {
    return this.isRunning;
  }
}

export const replayEngine = new ReplayEngine();
