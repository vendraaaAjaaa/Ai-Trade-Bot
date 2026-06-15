/**
 * =============================================
 * DASHBOARD API — Phase 8 Defensive Surface Hardening
 * =============================================
 *
 * Changes from Phase 8:
 *   - All /api routes require Bearer authentication via DASHBOARD_API_TOKEN.
 *   - CORS is restricted to CORS_ORIGINS and security headers are applied.
 *   - Dashboard routes use Zod validation for params, query strings, and bodies.
 *   - API errors are normalized and do not expose stack traces or secrets.
 *
 * Safety preserved:
 *   - Dashboard remains a thin orchestration layer.
 *   - Mutating endpoints still call the existing execution, replay, and strategy services.
 */

import crypto from 'crypto';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { z, ZodError } from 'zod';
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
import { liveCircuitBreaker } from '../execution/live/liveCircuitBreaker';
import type { MTFAnalysis } from '../utils/types2';
import type { TradingPair, Timeframe, ReplayConfig } from '../utils/types';
import type { StrategyMode, NoTradeDecision } from '../utils/types2';

const log = createLogger('api-v2');

const tradingPairSchema = z.preprocess(
  (value) => (typeof value === 'string' ? value.trim().toUpperCase() : value),
  z.enum(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']),
);
const timeframeSchema = z.enum(['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d']);
const strategyModeSchema = z.enum(['scalping', 'swing', 'investing', 'safe', 'aggressive']);
const tradingModeSchema = z.enum(['live', 'dryrun', 'replay']);

const pairParamsSchema = z.object({ pair: tradingPairSchema });
const idParamsSchema = z.object({
  id: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9:_-]+$/, 'Invalid position id format'),
});
const limitQuerySchema = (defaultLimit: number, maxLimit: number) => z.object({
  limit: z.coerce.number().int().min(1).max(maxLimit).default(defaultLimit),
});
const signalEvaluateBodySchema = z.object({
  pair: tradingPairSchema,
  timeframe: timeframeSchema.default(config.trading.defaultTimeframe as Timeframe),
});
const tradeHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  mode: tradingModeSchema.default(config.trading.mode),
});
const metricsQuerySchema = z.object({
  pair: tradingPairSchema.optional(),
  mode: tradingModeSchema.default(config.trading.mode),
});
const dailyPnlQuerySchema = z.object({
  mode: tradingModeSchema.default(config.trading.mode),
  days: z.coerce.number().int().min(1).max(365).default(30),
});
const strategyModeBodySchema = z.object({ mode: strategyModeSchema });
const circuitBreakerResetBodySchema = z.object({
  reason: z.string().trim().min(8).max(500),
});
const candlesQuerySchema = z.object({
  timeframe: timeframeSchema.default('15m'),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
const replayConfigSchema = z.object({
  pair: tradingPairSchema,
  timeframe: timeframeSchema,
  startTime: z.number().int().positive(),
  endTime: z.number().int().positive(),
  speedMultiplier: z.number().finite().min(1).max(100),
  isRunning: z.boolean().default(false),
}).superRefine((value, ctx) => {
  if (value.endTime <= value.startTime) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['endTime'],
      message: 'endTime must be greater than startTime',
    });
  }
});

type RateLimitEntry = {
  count: number;
  resetAt: number;
};

type AsyncRoute = (req: Request, res: Response) => Promise<void> | void;

const rateLimitBuckets = new Map<string, RateLimitEntry>();
const allowedOrigins = new Set(config.dashboard.corsOrigins);

function sendError(res: Response, status: number, code: string, message: string, details?: unknown): void {
  res.status(status).json({
    error: {
      code,
      message,
      ...(details ? { details } : {}),
    },
  });
}

function formatZodError(error: ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join('.') || 'value'}: ${issue.message}`);
}

function asyncHandler(route: AsyncRoute) {
  return (req: Request, res: Response, _next: NextFunction): void => {
    Promise.resolve(route(req, res)).catch((error: unknown) => {
      if (error instanceof ZodError) {
        sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request input', formatZodError(error));
        return;
      }

      log.error({ err: error, method: req.method, path: req.path }, 'API request failed');
      sendError(res, 500, 'INTERNAL_ERROR', 'Request failed');
    });
  };
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  return schema.parse(value);
}

function applySecurityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  next();
}

function applyCors(req: Request, res: Response, next: NextFunction): void {
  const origin = req.header('origin');
  if (origin) {
    if (!allowedOrigins.has(origin)) {
      sendError(res, 403, 'CORS_ORIGIN_DENIED', 'Origin is not allowed');
      return;
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');

  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }

  next();
}

function applyRateLimit(req: Request, res: Response, next: NextFunction): void {
  const now = Date.now();
  const key = `${req.ip || req.socket.remoteAddress || 'unknown'}:${req.header('authorization') ?? 'anonymous'}`;
  const existing = rateLimitBuckets.get(key);

  if (!existing || existing.resetAt <= now) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + config.dashboard.rateLimitWindowMs });
    next();
    return;
  }

  existing.count += 1;
  if (existing.count > config.dashboard.rateLimitMax) {
    res.setHeader('Retry-After', Math.ceil((existing.resetAt - now) / 1000).toString());
    sendError(res, 429, 'RATE_LIMITED', 'Too many dashboard API requests');
    return;
  }

  next();
}

function constantTimeEquals(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  return aBuffer.length === bBuffer.length && crypto.timingSafeEqual(aBuffer, bBuffer);
}

function authenticateApi(req: Request, res: Response, next: NextFunction): void {
  if (!config.dashboard.apiToken) {
    sendError(res, 503, 'DASHBOARD_AUTH_NOT_CONFIGURED', 'Dashboard API authentication is not configured');
    return;
  }

  const auth = req.header('authorization') ?? '';
  const [scheme, token] = auth.split(/\s+/);

  if (scheme !== 'Bearer' || !token || !constantTimeEquals(token, config.dashboard.apiToken)) {
    sendError(res, 401, 'UNAUTHORIZED', 'Bearer token required');
    return;
  }

  next();
}

function socketCorsOrigin(origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void): void {
  if (!origin || allowedOrigins.has(origin)) {
    callback(null, true);
    return;
  }

  callback(new Error('Origin is not allowed by CORS'), false);
}

export function createApiServer() {
  const app = express();
  app.disable('x-powered-by');

  const httpServer = createServer(app);
  const io = new SocketIOServer(httpServer, {
    cors: { origin: socketCorsOrigin, methods: ['GET', 'POST'], allowedHeaders: ['Authorization', 'Content-Type'] },
    transports: ['websocket', 'polling'],
  });

  app.use(applySecurityHeaders);
  app.use(applyCors);
  app.use(applyRateLimit);
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', authenticateApi);

  // ---- Health ----
  app.get('/health', asyncHandler(async (_req, res) => {
    const [dbOk, redisOk] = await Promise.all([db.healthCheck(), redis.healthCheck()]);
    res.json({
      status: dbOk && redisOk ? 'ok' : 'degraded',
      db: dbOk,
      redis: redisOk,
      mode: config.trading.mode,
      strategy: strategyManager.getMode(),
      pairs: config.trading.pairs,
      timestamp: Date.now(),
    });
  }));

  // ---- Signals ----
  app.get('/api/signals', asyncHandler(async (_req, res) => {
    const signals = await signalEngine.getAllLatestSignals();
    res.json({ signals, count: signals.length });
  }));

  app.get('/api/signals/:pair', asyncHandler(async (req, res) => {
    const { pair } = parse(pairParamsSchema, req.params);
    const signal = await signalEngine.getLatestSignal(pair as TradingPair);
    res.json({ signal });
  }));

  app.post('/api/signals/evaluate', asyncHandler(async (req, res) => {
    const { pair, timeframe } = parse(signalEvaluateBodySchema, req.body);
    const validatedPair = pair as TradingPair;
    const validatedTimeframe = timeframe as Timeframe;
    const candles = await marketDataService.fetchCandles(validatedPair, validatedTimeframe, 300);
    const signal = await signalEngine.evaluateSignal(validatedPair, validatedTimeframe, candles);
    res.json({ signal });
  }));

  app.get('/api/signals/history', asyncHandler(async (req, res) => {
    const { limit } = parse(limitQuerySchema(20, 500), req.query);
    const rows = await db.query('SELECT * FROM signals ORDER BY created_at DESC LIMIT $1', [limit]);
    res.json({ signals: rows });
  }));

  // ---- Positions ----
  app.get('/api/positions', (_req, res) => {
    res.json({ positions: dryRunExecutor.getOpenPositions() });
  });

  app.get('/api/positions/history', asyncHandler(async (req, res) => {
    const { limit, mode } = parse(tradeHistoryQuerySchema, req.query);
    const trades = await performanceAnalytics.getTradeHistory(limit, mode);
    res.json({ trades });
  }));

  app.post('/api/positions/:id/close', asyncHandler(async (req, res) => {
    const { id } = parse(idParamsSchema, req.params);
    const positions = dryRunExecutor.getOpenPositions();
    const pos = positions.find((position) => position.id === id);
    if (!pos) {
      sendError(res, 404, 'POSITION_NOT_FOUND', 'Position not found');
      return;
    }
    const price = await marketDataService.getCurrentPrice(pos.pair as TradingPair);
    await dryRunExecutor.closePosition(id, price, 'MANUAL');
    res.json({ success: true });
  }));

  // ---- Wallet ----
  app.get('/api/wallet', (_req, res) => {
    res.json({ wallet: dryRunExecutor.getWallet() });
  });

  // ---- Analytics ----
  app.get('/api/analytics/metrics', asyncHandler(async (req, res) => {
    const { pair, mode } = parse(metricsQuerySchema, req.query);
    const metrics = await performanceAnalytics.getMetrics(pair as TradingPair | undefined, undefined, undefined, mode);
    res.json({ metrics });
  }));

  app.get('/api/analytics/daily-pnl', asyncHandler(async (req, res) => {
    const { mode, days } = parse(dailyPnlQuerySchema, req.query);
    const data = await performanceAnalytics.getDailyPnl(mode, days);
    res.json({ data });
  }));

  // ---- Risk ----
  app.get('/api/risk/state', asyncHandler(async (_req, res) => {
    const state = await riskManager.getCurrentState();
    res.json({ state });
  }));

  app.get('/api/live/circuit-breaker', asyncHandler(async (_req, res) => {
    const state = await liveCircuitBreaker.getState();
    res.json({ circuitBreaker: state });
  }));

  app.post('/api/live/circuit-breaker/reset', asyncHandler(async (req, res) => {
    const { reason } = parse(circuitBreakerResetBodySchema, req.body);
    const state = await liveCircuitBreaker.reset(reason);
    res.json({ circuitBreaker: state });
  }));

  // ---- Regime ----
  app.get('/api/regime', asyncHandler(async (_req, res) => {
    const regimes: Record<string, unknown> = {};
    for (const pair of config.trading.pairs) {
      regimes[pair] = await marketRegimeEngine.getCached(pair as TradingPair);
    }
    res.json({ regimes });
  }));

  app.get('/api/regime/:pair', asyncHandler(async (req, res) => {
    const { pair } = parse(pairParamsSchema, req.params);
    const candles = await marketDataService.fetchCandles(pair as TradingPair, config.trading.defaultTimeframe as Timeframe, 200);
    const regime = await marketRegimeEngine.analyze(pair as TradingPair, candles);
    res.json({ regime });
  }));

  // ---- Quality ----
  app.get('/api/quality', asyncHandler(async (_req, res) => {
    const scores: Record<string, unknown> = {};
    for (const pair of config.trading.pairs) {
      scores[pair] = await marketQualityEngine.getCached(pair as TradingPair);
    }
    res.json({ scores });
  }));

  // ---- Session ----
  app.get('/api/session', (_req, res) => {
    const session = sessionFilter.getCurrentSession();
    res.json({ session });
  });

  // ---- Consensus ----
  app.get('/api/consensus/:pair', asyncHandler(async (req, res) => {
    const { pair } = parse(pairParamsSchema, req.params);
    const signal = await signalEngine.getLatestSignal(pair as TradingPair);
    if (!signal) {
      res.json({ consensus: null });
      return;
    }
    const regime = await marketRegimeEngine.getCached(pair as TradingPair)
      ?? { regime: 'unknown' as const, tradingAllowed: false, confidence: 0, trendStrength: 0, isChoppy: true, isManipulative: false, atrPercent: 0, emaFlattening: true, wickRatio: 0, fakeBreakoutFrequency: 0, description: 'No data', timestamp: Date.now() };
    const quality = await marketQualityEngine.getCached(pair as TradingPair)
      ?? { total: 0, grade: 'no_trade' as const, trendClarity: 0, liquidityQuality: 0, volatilityQuality: 0, volumeQuality: 0, confirmationStrength: 0, tradingAllowed: false, reasons: [], timestamp: Date.now() };
    const session = sessionFilter.getCurrentSession();
    const mtf: MTFAnalysis = {
      pair: pair as string,
      strategyMode: strategyManager.getMode(),
      trendTimeframe: { tf: '1h', trend: signal.indicators.trend, aligned: true },
      structureTimeframe: { tf: '15m', structure: signal.indicators.trend, aligned: true },
      triggerTimeframe: { tf: '5m', ready: true },
      overallAligned: true,
      alignmentScore: 80,
      timestamp: Date.now(),
    };
    const consensus = consensusVoting.vote(signal, regime, quality, mtf, session, strategyManager.getMode());
    res.json({ consensus });
  }));

  // ---- Strategy Mode ----
  app.get('/api/strategy/mode', (_req, res) => {
    res.json({ mode: strategyManager.getMode(), config: strategyManager.getConfig() });
  });

  app.post('/api/strategy/mode', asyncHandler(async (req, res) => {
    const { mode } = parse(strategyModeBodySchema, req.body);
    await strategyManager.setMode(mode as StrategyMode);
    res.json({ mode, config: strategyManager.getConfig() });
  }));

  app.get('/api/strategy/modes', (_req, res) => {
    res.json({ modes: strategyManager.getAllModes() });
  });

  // ---- Frequency & Streak ----
  app.get('/api/frequency', asyncHandler(async (_req, res) => {
    const [freq, streak, status] = await Promise.all([
      frequencyLimiter.getFrequencyState(strategyManager.getMode()),
      frequencyLimiter.getLossStreakState(),
      frequencyLimiter.getSystemStatus(),
    ]);
    res.json({ frequency: freq, streak, systemStatus: status });
  }));

  app.post('/api/frequency/reset-cooldown', asyncHandler(async (_req, res) => {
    await frequencyLimiter.exitCooldown();
    res.json({ success: true });
  }));

  // ---- Self Review ----
  app.get('/api/review', asyncHandler(async (req, res) => {
    const { limit } = parse(limitQuerySchema(10, 100), req.query);
    const reviews = await selfReviewEngine.getRecentReviews(limit);
    res.json({ reviews });
  }));

  // ---- Market Data ----
  app.get('/api/market/candles/:pair', asyncHandler(async (req, res) => {
    const { pair } = parse(pairParamsSchema, req.params);
    const { timeframe, limit } = parse(candlesQuerySchema, req.query);
    const candles = await marketDataService.fetchCandles(pair as TradingPair, timeframe as Timeframe, limit);
    res.json({ candles, pair, timeframe });
  }));

  app.get('/api/market/price/:pair', asyncHandler(async (req, res) => {
    const { pair } = parse(pairParamsSchema, req.params);
    const price = await marketDataService.getCurrentPrice(pair as TradingPair);
    res.json({ pair, price });
  }));

  app.get('/api/market/funding/:pair', asyncHandler(async (req, res) => {
    const { pair } = parse(pairParamsSchema, req.params);
    const funding = await marketDataService.getFundingRate(pair as TradingPair);
    res.json({ funding });
  }));

  // ---- Replay ----
  app.post('/api/replay/start', asyncHandler(async (req, res) => {
    const cfg = parse(replayConfigSchema, req.body) as ReplayConfig;
    replayEngine.runReplay(cfg)
      .then((result) => io.emit('replay_complete', result))
      .catch((error: unknown) => log.error({ err: error }, 'Replay failed after start'));
    res.json({ status: 'started' });
  }));

  app.post('/api/replay/stop', (_req, res) => {
    replayEngine.stop();
    res.json({ status: 'stopped' });
  });

  app.get('/api/replay/status', (_req, res) => {
    res.json({ isRunning: replayEngine.isActive() });
  });

  // ---- AI Analysis ----
  app.get('/api/ai/analysis', asyncHandler(async (req, res) => {
    const { limit } = parse(limitQuerySchema(20, 500), req.query);
    const rows = await db.query('SELECT * FROM ai_analysis ORDER BY created_at DESC LIMIT $1', [limit]);
    res.json({ analysis: rows });
  }));

  // ---- Config ----
  app.get('/api/config', (_req, res) => {
    res.json({
      mode: config.trading.mode,
      strategy: strategyManager.getMode(),
      strategyConfig: strategyManager.getConfig(),
      pairs: config.trading.pairs,
      timeframe: config.trading.defaultTimeframe,
      binanceTestnet: config.binance.testnet,
      corsOrigins: config.dashboard.corsOrigins,
    });
  });

  // ---- Socket.IO ----
  io.on('connection', (socket) => {
    log.debug({ id: socket.id }, 'Dashboard connected');
    socket.on('subscribe', (pair: string) => {
      const parsed = tradingPairSchema.safeParse(pair);
      if (!parsed.success) return;
      socket.join(`pair:${parsed.data}`);
    });
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
