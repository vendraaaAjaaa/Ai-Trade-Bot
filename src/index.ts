import 'dotenv/config';
import { createLogger } from './utils/logger';
import { db } from './database/connection';
import { redis } from './redis/client';
import { runMigrations } from './database/migrations/001_initial';
import { BinanceWebSocketService } from './websocket/binanceWebSocket';
import { signalEngine } from './signals/signalEngine';
import { dryRunExecutor } from './execution/dryrun/dryRunExecutor';
import { liveExecutor } from './execution/live/liveExecutor';
import { telegramNotifier } from './telegram/telegramBot';
import { createApiServer } from './dashboard/apiServer';
import { marketRegimeEngine } from './regime/marketRegimeEngine';
import { sessionFilter } from './session/sessionFilter';
import { strategyManager } from './strategy/strategyModes';
import { frequencyLimiter } from './strategy/frequencyLimiter';
import { trackTrade, detectMEV } from './smartmoney/smartMoneyAnalysis';
import { updateTradeBuffer } from './volume/volumeAnalysis';
import { config } from './config';
import { marketDataService } from './market/marketDataService';
import type { TradingPair, Timeframe, AggregateTrade } from './utils/types';
import type { NoTradeDecision } from './utils/types2';

const log = createLogger('main-v2');

async function bootstrap() {
  log.info('╔══════════════════════════════════════════════════════╗');
  log.info('║   AI AGENTIC TRADING PLATFORM  v2.0 — DISCIPLINED   ║');
  log.info('╚══════════════════════════════════════════════════════╝');
  log.info({ mode: config.trading.mode, pairs: config.trading.pairs }, 'Starting platform');

  // ---- Infrastructure ----
  log.info('Connecting to PostgreSQL...');
  if (!await db.healthCheck()) { log.error('PostgreSQL connection failed'); process.exit(1); }
  await runMigrations();

  log.info('Connecting to Redis...');
  if (!await redis.healthCheck()) log.warn('Redis unavailable — running without cache');

  // ---- Initialize strategy & frequency state ----
  await strategyManager.initialize();
  const mode = strategyManager.getMode();
  const modeCfg = strategyManager.getConfig();
  log.info({ mode, maxTrades: modeCfg.maxTradesPerDay, minConfidence: modeCfg.minConfidence }, 'Strategy mode loaded');

  // ---- Initialize signal buffers & regime engine ----
  log.info('Loading historical candle buffers...');
  await signalEngine.initializeBuffers();

  // ---- WebSocket ----
  const timeframes: Timeframe[] = [
    config.trading.defaultTimeframe as Timeframe,
    config.trading.secondaryTimeframe as Timeframe,
    config.trading.trendTimeframe as Timeframe,
  ];

  const wsService = new BinanceWebSocketService(config.trading.pairs as TradingPair[], timeframes);

  // ---- Candle handler (WebSocket - may not work on some ISPs) ----
  wsService.on('candle', async ({ pair, timeframe, candle, isClosed }) => {
    try {
      if (isClosed) {
        await signalEngine.onCandleClose(pair, timeframe, candle);

        // Update regime every 15 closed candles on primary TF
        if (timeframe === config.trading.defaultTimeframe) {
          const buffer = signalEngine.getBuffer(pair, timeframe);
          if (buffer.length >= 50 && buffer.length % 15 === 0) {
            const regime = await marketRegimeEngine.analyze(pair, buffer);
            if (!regime.tradingAllowed) {
              await telegramNotifier.sendRegimeAlert(pair, regime).catch(() => {});
            }
          }
        }
      }
    } catch (err) {
      log.error({ err, pair, timeframe }, 'CRITICAL: Candle handler crashed!');
    }
  });

  // ---- Trade handler ----
  wsService.on('trade', async (trade: AggregateTrade) => {
    updateTradeBuffer(trade);
    trackTrade(trade);
    const mev = detectMEV(trade);
    if (mev) log.warn({ type: mev.type, pair: mev.pair }, 'MEV detected');

    if (config.trading.mode === 'dryrun') {
      await dryRunExecutor.updatePositionPrice(trade.pair, trade.price);
    }
  });

  wsService.on('connected', () => log.info('Binance WebSocket streaming'));
  wsService.on('fatal_error', () => process.exit(1));
  wsService.start();

  // ---- REST API Candle Polling (ISP-resistant fallback) ----
  // Since some ISPs block WebSocket kline streams, we poll every 30s via REST API
  const lastCandleTime = new Map<string, number>();

  async function pollCandles() {
    for (const pair of config.trading.pairs as TradingPair[]) {
      for (const tf of timeframes) {
        try {
          const candles = await marketDataService.fetchFromBinance(pair, tf, 2);
          if (candles.length < 2) continue;

          // The second-to-last candle is the latest CLOSED candle
          const closedCandle = candles[candles.length - 2];
          const key = `${pair}:${tf}`;
          const lastTime = lastCandleTime.get(key) ?? 0;

          if (closedCandle.openTime > lastTime) {
            lastCandleTime.set(key, closedCandle.openTime);

            // Skip the first poll (initialization) to avoid duplicate signals
            if (lastTime > 0) {
              log.info({ pair, tf, close: closedCandle.close, openTime: new Date(closedCandle.openTime).toISOString() },
                '📊 REST poll: new closed candle detected');
              await signalEngine.onCandleClose(pair, tf, closedCandle);
            } else {
              log.info({ pair, tf }, '📊 REST poll: baseline set');
            }
          }
        } catch (err) {
          log.warn({ err, pair, tf }, 'REST poll: failed to fetch candles');
        }
      }
    }
  }

  // Initial baseline + start polling
  await pollCandles();
  setInterval(pollCandles, 30_000);
  log.info({ intervalSec: 30, pairs: config.trading.pairs.length, timeframes: timeframes.length },
    '🔄 REST candle polling started (ISP-resistant)');

  // ---- Signal → Execution pipeline ----
  signalEngine.on('signal', async (signal) => {
    // Pre-execution session check
    const session = sessionFilter.getCurrentSession();
    if (!session.tradingAllowed) {
      log.info({ session: session.name }, 'Signal skipped: session not tradeable');
      return;
    }

    // Send Telegram alert for approved signal
    await telegramNotifier.sendSignalAlert(signal).catch(() => {});

    let position = null;
    if (config.trading.mode === 'dryrun') {
      position = await dryRunExecutor.executeSignal(signal);
    } else if (config.trading.mode === 'live') {
      const balance = await liveExecutor.getAccountBalance();
      position = await liveExecutor.executeSignal(signal, balance);
    }

    if (position) {
      await telegramNotifier.sendPositionOpened(position).catch(() => {});
    }
  });

  // ---- No-trade events ----
  signalEngine.on('no_trade', async (data: { pair: string; decision: NoTradeDecision }) => {
    log.debug({ pair: data.pair, category: data.decision.category, reason: data.decision.primaryReason }, 'No trade');
    await telegramNotifier.sendNoTradeAlert(data.pair, data.decision).catch(() => {});
  });

  // ---- Position events ----
  dryRunExecutor.on('position_closed', async ({ position, reason }) => {
    await telegramNotifier.sendPositionClosed(position, reason).catch(() => {});
  });

  dryRunExecutor.on('position_liquidated', async (position) => {
    await telegramNotifier.sendPositionClosed(position, 'LIQUIDATED').catch(() => {});
    const streak = await frequencyLimiter.getLossStreakState();
    if (streak.inCooldown) {
      await telegramNotifier.sendCooldownAlert(streak).catch(() => {});
    }
  });

  // ---- Loss streak cooldown monitor ----
  setInterval(async () => {
    const streak = await frequencyLimiter.getLossStreakState();
    if (streak.inCooldown && Date.now() >= streak.cooldownUntil) {
      await frequencyLimiter.exitCooldown();
      log.info('Cooldown period ended — resuming trading');
    }
  }, 60_000);

  // ---- Daily report ----
  scheduleDailyReport();

  // ---- API Server ----
  const { httpServer } = createApiServer();
  httpServer.listen(config.app.port, () => {
    log.info({ port: config.app.port }, 'API server started');
  });

  const session = sessionFilter.getCurrentSession();
  log.info('╔══════════════════════════════════════════════════════╗');
  log.info(`║  Mode: ${config.trading.mode.padEnd(10)} Strategy: ${mode.padEnd(10)}          ║`);
  log.info(`║  Session: ${session.name.padEnd(10)} Quality: ${session.quality}/100              ║`);
  log.info(`║  API: http://localhost:${config.app.port}                        ║`);
  log.info('╚══════════════════════════════════════════════════════╝');

  process.on('SIGTERM', () => gracefulShutdown(wsService));
  process.on('SIGINT', () => gracefulShutdown(wsService));
}

function scheduleDailyReport() {
  const now = new Date();
  const next = new Date();
  next.setHours(23, 55, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  setTimeout(async () => {
    await telegramNotifier.sendDailyReport().catch(() => {});
    setInterval(() => telegramNotifier.sendDailyReport().catch(() => {}), 86_400_000);
  }, next.getTime() - now.getTime());
}

async function gracefulShutdown(ws: BinanceWebSocketService) {
  log.info('Shutting down...');
  ws.stop();
  telegramNotifier.stop();
  await redis.close();
  await db.close();
  process.exit(0);
}

bootstrap().catch((err) => { log.error({ err }, 'Fatal startup error'); process.exit(1); });
