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
import { db } from '../database/connection';
import { redis } from '../redis/client';
import { config } from '../config';
import type { TradingPair, Timeframe, ReplayConfig } from '../utils/types';

const log = createLogger('api-server');

export function createApiServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new SocketIOServer(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    transports: ['websocket', 'polling'],
  });

  // ---- Middleware ----
  app.use(express.json());
  app.use((req, _res, next) => {
    log.debug({ method: req.method, path: req.path }, 'API request');
    next();
  });

  // CORS
  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    next();
  });

  // ---- Health ----
  app.get('/health', async (_req, res) => {
    const dbOk = await db.healthCheck();
    const redisOk = await redis.healthCheck();
    res.json({
      status: dbOk && redisOk ? 'ok' : 'degraded',
      db: dbOk, redis: redisOk,
      mode: config.trading.mode,
      pairs: config.trading.pairs,
      timestamp: Date.now(),
    });
  });

  // ---- Signals ----
  app.get('/api/signals', async (_req, res) => {
    try {
      const signals = await signalEngine.getAllLatestSignals();
      res.json({ signals, count: signals.length });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch signals' });
    }
  });

  app.get('/api/signals/:pair', async (req, res) => {
    try {
      const pair = req.params.pair.toUpperCase() as TradingPair;
      const signal = await signalEngine.getLatestSignal(pair);
      res.json({ signal });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch signal' });
    }
  });

  app.post('/api/signals/evaluate', async (req, res) => {
    try {
      const { pair, timeframe } = req.body as { pair: TradingPair; timeframe: Timeframe };
      const candles = await marketDataService.fetchCandles(pair, timeframe || config.trading.defaultTimeframe as Timeframe, 300);
      const signal = await signalEngine.evaluateSignal(pair, timeframe || config.trading.defaultTimeframe as Timeframe, candles);
      res.json({ signal });
    } catch (err) {
      res.status(500).json({ error: 'Signal evaluation failed' });
    }
  });

  app.get('/api/signals/history', async (req, res) => {
    try {
      const { pair, limit = '20' } = req.query as { pair?: string; limit?: string };
      let sql = `SELECT * FROM signals ORDER BY created_at DESC LIMIT $1`;
      const params: (string | number)[] = [parseInt(limit)];
      if (pair) { sql = `SELECT * FROM signals WHERE pair=$2 ORDER BY created_at DESC LIMIT $1`; params.push(pair); }
      const rows = await db.query(sql, params);
      res.json({ signals: rows });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch signal history' });
    }
  });

  // ---- Positions ----
  app.get('/api/positions', async (_req, res) => {
    try {
      const open = dryRunExecutor.getOpenPositions();
      res.json({ positions: open, count: open.length });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch positions' });
    }
  });

  app.get('/api/positions/history', async (req, res) => {
    try {
      const { limit = '50', mode = config.trading.mode } = req.query as { limit?: string; mode?: string };
      const trades = await performanceAnalytics.getTradeHistory(parseInt(limit), mode);
      res.json({ trades });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch trade history' });
    }
  });

  app.post('/api/positions/:id/close', async (req, res) => {
    try {
      const { id } = req.params;
      const price = await marketDataService.getCurrentPrice('BTCUSDT');
      await dryRunExecutor.closePosition(id, price, 'MANUAL');
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Failed to close position' });
    }
  });

  // ---- Wallet ----
  app.get('/api/wallet', (_req, res) => {
    try {
      const wallet = dryRunExecutor.getWallet();
      res.json({ wallet });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch wallet' });
    }
  });

  // ---- Analytics ----
  app.get('/api/analytics/metrics', async (req, res) => {
    try {
      const { pair, mode = config.trading.mode } = req.query as { pair?: string; mode?: string };
      const metrics = await performanceAnalytics.getMetrics(pair, undefined, undefined, mode);
      res.json({ metrics });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch metrics' });
    }
  });

  app.get('/api/analytics/daily-pnl', async (req, res) => {
    try {
      const { mode = config.trading.mode, days = '30' } = req.query as { mode?: string; days?: string };
      const data = await performanceAnalytics.getDailyPnl(mode, parseInt(days));
      res.json({ data });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch daily PnL' });
    }
  });

  // ---- Risk ----
  app.get('/api/risk/state', async (_req, res) => {
    try {
      const state = await riskManager.getCurrentState();
      res.json({ state });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch risk state' });
    }
  });

  // ---- Market Data ----
  app.get('/api/market/candles/:pair', async (req, res) => {
    try {
      const pair = req.params.pair.toUpperCase() as TradingPair;
      const { timeframe = '15m', limit = '200' } = req.query as { timeframe?: string; limit?: string };
      const candles = await marketDataService.fetchCandles(pair, timeframe as Timeframe, parseInt(limit));
      res.json({ candles, pair, timeframe });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch candles' });
    }
  });

  app.get('/api/market/price/:pair', async (req, res) => {
    try {
      const pair = req.params.pair.toUpperCase() as TradingPair;
      const price = await marketDataService.getCurrentPrice(pair);
      res.json({ pair, price });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch price' });
    }
  });

  app.get('/api/market/funding/:pair', async (req, res) => {
    try {
      const pair = req.params.pair.toUpperCase() as TradingPair;
      const funding = await marketDataService.getFundingRate(pair);
      res.json({ funding });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch funding rate' });
    }
  });

  // ---- Replay ----
  app.post('/api/replay/start', async (req, res) => {
    try {
      const { pair, timeframe, startTime, endTime, speedMultiplier = 10 } = req.body as ReplayConfig;
      const cfg: ReplayConfig = {
        pair, timeframe, startTime, endTime, speedMultiplier,
        isRunning: true,
      };
      // Run async, stream via Socket.IO
      replayEngine.runReplay(cfg).then((result) => {
        io.emit('replay_complete', result);
      }).catch((err) => {
        io.emit('replay_error', { error: String(err) });
      });
      res.json({ status: 'started', config: cfg });
    } catch (err) {
      res.status(500).json({ error: 'Failed to start replay' });
    }
  });

  app.post('/api/replay/stop', (_req, res) => {
    replayEngine.stop();
    res.json({ status: 'stopped' });
  });

  app.get('/api/replay/status', (_req, res) => {
    res.json({ isRunning: replayEngine.isActive() });
  });

  // ---- AI Analysis History ----
  app.get('/api/ai/analysis', async (req, res) => {
    try {
      const { limit = '20' } = req.query as { limit?: string };
      const rows = await db.query(
        `SELECT * FROM ai_analysis ORDER BY created_at DESC LIMIT $1`,
        [parseInt(limit)],
      );
      res.json({ analysis: rows });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch AI analysis' });
    }
  });

  // ---- Config ----
  app.get('/api/config', (_req, res) => {
    res.json({
      mode: config.trading.mode,
      pairs: config.trading.pairs,
      timeframe: config.trading.defaultTimeframe,
      minConfidence: config.signals.minConfidenceScore,
      maxDailyLoss: config.risk.maxDailyLossPercent,
      maxPositions: config.risk.maxOpenPositions,
      leverage: config.risk.defaultLeverage,
    });
  });

  // ---- Socket.IO realtime events ----
  io.on('connection', (socket) => {
    log.info({ id: socket.id }, 'Dashboard client connected');

    socket.on('subscribe', (pair: string) => {
      socket.join(`pair:${pair}`);
    });

    socket.on('disconnect', () => {
      log.debug({ id: socket.id }, 'Dashboard client disconnected');
    });
  });

  // Forward signal engine events to dashboard
  signalEngine.on('signal', (signal) => {
    io.emit('signal', signal);
    io.to(`pair:${signal.pair}`).emit('signal', signal);
  });

  // Forward executor events
  dryRunExecutor.on('position_opened', (pos) => io.emit('position_opened', pos));
  dryRunExecutor.on('position_closed', (data) => io.emit('position_closed', data));
  dryRunExecutor.on('position_liquidated', (pos) => io.emit('position_liquidated', pos));

  // Forward replay events
  replayEngine.on('candle', (data) => io.emit('replay_candle', data));
  replayEngine.on('signal', (sig) => io.emit('replay_signal', sig));
  replayEngine.on('trade_closed', (t) => io.emit('replay_trade', t));

  return { app, httpServer, io };
}
