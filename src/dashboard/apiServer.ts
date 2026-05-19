import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { createLogger } from '../utils/logger';
import { signalEngine } from '../signals/signalEngine';
import { dryRunExecutor } from '../execution/dryrun/dryRunExecutor';
import { performanceAnalytics } from '../analytics/performanceAnalytics';
import { riskManager } from '../risk/riskManager';
import { replayEngine } from '../replay/replayEngine';
import { marketDataService } from '../market/marketDataService';
import { marketRegimeEngine } from '../regime/marketRegimeEngine';
import { marketQualityEngine } from '../quality/marketQualityScore';
import { sessionFilter } from '../session/sessionFilter';
import { consensusVoting } from '../consensus/consensusVoting';
import { strategyManager } from '../strategy/strategyModes';
import { frequencyLimiter } from '../strategy/frequencyLimiter';
import { selfReviewEngine } from '../review/selfReviewEngine';
import { db } from '../database/connection';
import { redis } from '../redis/client';
import { config } from '../config';
import type { TradingPair, Timeframe } from '../utils/types';
import type { StrategyMode, NoTradeDecision } from '../utils/types2';
import type { ReplayConfig } from '../utils/types';

const log = createLogger('api-v2');

export function createApiServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new SocketIOServer(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    transports: ['websocket', 'polling'],
  });

  app.use(express.json());
  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (_req.method === 'OPTIONS') { res.sendStatus(200); return; }
    next();
  });

  // ---- Health ----
  app.get('/health', async (_req, res) => {
    const [dbOk, redisOk] = await Promise.all([db.healthCheck(), redis.healthCheck()]);
    res.json({
      status: dbOk && redisOk ? 'ok' : 'degraded',
      db: dbOk, redis: redisOk,
      mode: config.trading.mode,
      strategy: strategyManager.getMode(),
      pairs: config.trading.pairs,
      timestamp: Date.now(),
    });
  });

  // ---- Signals ----
  app.get('/api/signals', async (_req, res) => {
    try {
      const signals = await signalEngine.getAllLatestSignals();
      res.json({ signals, count: signals.length });
    } catch { res.status(500).json({ error: 'Failed to fetch signals' }); }
  });

  app.get('/api/signals/:pair', async (req, res) => {
    try {
      const signal = await signalEngine.getLatestSignal(req.params.pair.toUpperCase() as TradingPair);
      res.json({ signal });
    } catch { res.status(500).json({ error: 'Failed to fetch signal' }); }
  });

  app.post('/api/signals/evaluate', async (req, res) => {
    try {
      const { pair, timeframe } = req.body as { pair: TradingPair; timeframe: Timeframe };
      const candles = await marketDataService.fetchCandles(pair, timeframe || config.trading.defaultTimeframe as Timeframe, 300);
      const signal = await signalEngine.evaluateSignal(pair, timeframe || config.trading.defaultTimeframe as Timeframe, candles);
      res.json({ signal });
    } catch { res.status(500).json({ error: 'Signal evaluation failed' }); }
  });

  app.get('/api/signals/history', async (req, res) => {
    try {
      const limit = parseInt(String(req.query['limit'] ?? '20'));
      const rows = await db.query(`SELECT * FROM signals ORDER BY created_at DESC LIMIT $1`, [limit]);
      res.json({ signals: rows });
    } catch { res.status(500).json({ error: 'Failed to fetch signal history' }); }
  });

  // ---- Positions ----
  app.get('/api/positions', (_req, res) => {
    res.json({ positions: dryRunExecutor.getOpenPositions() });
  });

  app.get('/api/positions/history', async (req, res) => {
    try {
      const limit = parseInt(String(req.query['limit'] ?? '50'));
      const mode = String(req.query['mode'] ?? config.trading.mode);
      const trades = await performanceAnalytics.getTradeHistory(limit, mode);
      res.json({ trades });
    } catch { res.status(500).json({ error: 'Failed to fetch trade history' }); }
  });

  app.post('/api/positions/:id/close', async (req, res) => {
    try {
      const positions = dryRunExecutor.getOpenPositions();
      const pos = positions.find((p) => p.id === req.params.id);
      if (!pos) { res.status(404).json({ error: 'Position not found' }); return; }
      const price = await marketDataService.getCurrentPrice(pos.pair as TradingPair);
      await dryRunExecutor.closePosition(req.params.id, price, 'MANUAL');
      res.json({ success: true });
    } catch { res.status(500).json({ error: 'Failed to close position' }); }
  });

  // ---- Wallet ----
  app.get('/api/wallet', (_req, res) => {
    res.json({ wallet: dryRunExecutor.getWallet() });
  });

  // ---- Analytics ----
  app.get('/api/analytics/metrics', async (req, res) => {
    try {
      const { pair, mode = config.trading.mode } = req.query as { pair?: string; mode?: string };
      const metrics = await performanceAnalytics.getMetrics(pair, undefined, undefined, mode);
      res.json({ metrics });
    } catch { res.status(500).json({ error: 'Failed to fetch metrics' }); }
  });

  app.get('/api/analytics/daily-pnl', async (req, res) => {
    try {
      const { mode = config.trading.mode, days = '30' } = req.query as Record<string, string>;
      const data = await performanceAnalytics.getDailyPnl(mode, parseInt(days));
      res.json({ data });
    } catch { res.status(500).json({ error: 'Failed to fetch daily PnL' }); }
  });

  // ---- Risk ----
  app.get('/api/risk/state', async (_req, res) => {
    try {
      const state = await riskManager.getCurrentState();
      res.json({ state });
    } catch { res.status(500).json({ error: 'Failed to fetch risk state' }); }
  });

  // ---- NEW: Regime ----
  app.get('/api/regime', async (_req, res) => {
    try {
      const regimes: Record<string, unknown> = {};
      for (const pair of config.trading.pairs) {
        regimes[pair] = await marketRegimeEngine.getCached(pair as TradingPair);
      }
      res.json({ regimes });
    } catch { res.status(500).json({ error: 'Failed to fetch regimes' }); }
  });

  app.get('/api/regime/:pair', async (req, res) => {
    try {
      const pair = req.params.pair.toUpperCase() as TradingPair;
      const candles = await marketDataService.fetchCandles(pair, config.trading.defaultTimeframe as Timeframe, 200);
      const regime = await marketRegimeEngine.analyze(pair, candles);
      res.json({ regime });
    } catch { res.status(500).json({ error: 'Failed to analyze regime' }); }
  });

  // ---- NEW: Quality ----
  app.get('/api/quality', async (_req, res) => {
    try {
      const scores: Record<string, unknown> = {};
      for (const pair of config.trading.pairs) {
        scores[pair] = await marketQualityEngine.getCached(pair as TradingPair);
      }
      res.json({ scores });
    } catch { res.status(500).json({ error: 'Failed to fetch quality scores' }); }
  });

  // ---- NEW: Session ----
  app.get('/api/session', (_req, res) => {
    const session = sessionFilter.getCurrentSession();
    res.json({ session });
  });

  // ---- NEW: Consensus ----
  app.get('/api/consensus/:pair', async (req, res) => {
    try {
      const pair = req.params.pair.toUpperCase() as TradingPair;
      const signal = await signalEngine.getLatestSignal(pair);
      if (!signal) { res.json({ consensus: null }); return; }
      const regime = await marketRegimeEngine.getCached(pair) ?? { regime: 'unknown', tradingAllowed: false, confidence: 0, trendStrength: 0, isChoppy: true, isManipulative: false, atrPercent: 0, emaFlattening: true, wickRatio: 0, fakeBreakoutFrequency: 0, description: 'No data', timestamp: Date.now() };
      const quality = await marketQualityEngine.getCached(pair) ?? { total: 0, grade: 'no_trade' as const, trendClarity: 0, liquidityQuality: 0, volatilityQuality: 0, volumeQuality: 0, confirmationStrength: 0, tradingAllowed: false, reasons: [], timestamp: Date.now() };
      const session = sessionFilter.getCurrentSession();
      const mtf = { pair, strategyMode: strategyManager.getMode(), trendTimeframe: { tf: '1h', trend: signal.indicators.trend, aligned: true }, structureTimeframe: { tf: '15m', structure: signal.indicators.trend, aligned: true }, triggerTimeframe: { tf: '5m', ready: true }, overallAligned: true, alignmentScore: 80, timestamp: Date.now() };
      const consensus = consensusVoting.vote(signal, regime, quality, mtf as any, session, strategyManager.getMode());
      res.json({ consensus });
    } catch { res.status(500).json({ error: 'Failed to compute consensus' }); }
  });

  // ---- NEW: Strategy Mode ----
  app.get('/api/strategy/mode', (_req, res) => {
    res.json({ mode: strategyManager.getMode(), config: strategyManager.getConfig() });
  });

  app.post('/api/strategy/mode', async (req, res) => {
    try {
      const { mode } = req.body as { mode: StrategyMode };
      const valid: StrategyMode[] = ['scalping', 'swing', 'investing', 'safe', 'aggressive'];
      if (!valid.includes(mode)) { res.status(400).json({ error: 'Invalid mode' }); return; }
      await strategyManager.setMode(mode);
      res.json({ mode, config: strategyManager.getConfig() });
    } catch { res.status(500).json({ error: 'Failed to set strategy mode' }); }
  });

  app.get('/api/strategy/modes', (_req, res) => {
    res.json({ modes: strategyManager.getAllModes() });
  });

  // ---- NEW: Frequency & Streak ----
  app.get('/api/frequency', async (_req, res) => {
    try {
      const [freq, streak, status] = await Promise.all([
        frequencyLimiter.getFrequencyState(strategyManager.getMode()),
        frequencyLimiter.getLossStreakState(),
        frequencyLimiter.getSystemStatus(),
      ]);
      res.json({ frequency: freq, streak, systemStatus: status });
    } catch { res.status(500).json({ error: 'Failed to fetch frequency state' }); }
  });

  app.post('/api/frequency/reset-cooldown', async (_req, res) => {
    try {
      await frequencyLimiter.exitCooldown();
      res.json({ success: true });
    } catch { res.status(500).json({ error: 'Failed to reset cooldown' }); }
  });

  // ---- NEW: Self Review ----
  app.get('/api/review', async (req, res) => {
    try {
      const limit = parseInt(String(req.query['limit'] ?? '10'));
      const reviews = await selfReviewEngine.getRecentReviews(limit);
      res.json({ reviews });
    } catch { res.status(500).json({ error: 'Failed to fetch reviews' }); }
  });

  // ---- Market Data ----
  app.get('/api/market/candles/:pair', async (req, res) => {
    try {
      const pair = req.params.pair.toUpperCase() as TradingPair;
      const { timeframe = '15m', limit = '200' } = req.query as Record<string, string>;
      const candles = await marketDataService.fetchCandles(pair, timeframe as Timeframe, parseInt(limit));
      res.json({ candles, pair, timeframe });
    } catch { res.status(500).json({ error: 'Failed to fetch candles' }); }
  });

  app.get('/api/market/price/:pair', async (req, res) => {
    try {
      const pair = req.params.pair.toUpperCase() as TradingPair;
      const price = await marketDataService.getCurrentPrice(pair);
      res.json({ pair, price });
    } catch { res.status(500).json({ error: 'Failed to fetch price' }); }
  });

  app.get('/api/market/funding/:pair', async (req, res) => {
    try {
      const pair = req.params.pair.toUpperCase() as TradingPair;
      const funding = await marketDataService.getFundingRate(pair);
      res.json({ funding });
    } catch { res.status(500).json({ error: 'Failed to fetch funding' }); }
  });

  // ---- Replay ----
  app.post('/api/replay/start', async (req, res) => {
    try {
      const cfg = req.body as ReplayConfig;
      replayEngine.runReplay(cfg).then((result) => io.emit('replay_complete', result)).catch(() => {});
      res.json({ status: 'started' });
    } catch { res.status(500).json({ error: 'Failed to start replay' }); }
  });

  app.post('/api/replay/stop', (_req, res) => { replayEngine.stop(); res.json({ status: 'stopped' }); });
  app.get('/api/replay/status', (_req, res) => { res.json({ isRunning: replayEngine.isActive() }); });

  // ---- AI Analysis ----
  app.get('/api/ai/analysis', async (req, res) => {
    try {
      const limit = parseInt(String(req.query['limit'] ?? '20'));
      const rows = await db.query(`SELECT * FROM ai_analysis ORDER BY created_at DESC LIMIT $1`, [limit]);
      res.json({ analysis: rows });
    } catch { res.status(500).json({ error: 'Failed to fetch AI analysis' }); }
  });

  // ---- Config ----
  app.get('/api/config', (_req, res) => {
    res.json({
      mode: config.trading.mode,
      strategy: strategyManager.getMode(),
      strategyConfig: strategyManager.getConfig(),
      pairs: config.trading.pairs,
      timeframe: config.trading.defaultTimeframe,
    });
  });

  // ---- Socket.IO ----
  io.on('connection', (socket) => {
    log.debug({ id: socket.id }, 'Dashboard connected');
    socket.on('subscribe', (pair: string) => socket.join(`pair:${pair}`));
    socket.on('disconnect', () => log.debug({ id: socket.id }, 'Dashboard disconnected'));
  });

  // Forward events to dashboard
  signalEngine.on('signal', (signal) => io.emit('signal', signal));
  signalEngine.on('no_trade', (data: { pair: string; decision: NoTradeDecision }) => io.emit('no_trade', data));
  dryRunExecutor.on('position_opened', (data) => io.emit('position_opened', data));
  dryRunExecutor.on('position_closed', (data) => io.emit('position_closed', data));
  dryRunExecutor.on('position_liquidated', (pos) => io.emit('position_liquidated', pos));
  replayEngine.on('candle', (d) => io.emit('replay_candle', d));
  replayEngine.on('signal', (s) => io.emit('replay_signal', s));

  return { app, httpServer, io };
}
