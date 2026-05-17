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
import { trackTrade, detectMEV } from './smartmoney/smartMoneyAnalysis';
import { updateTradeBuffer } from './volume/volumeAnalysis';
import { config } from './config';
import type { TradingPair, Timeframe, AggregateTrade } from './utils/types';

const log = createLogger('main');

async function bootstrap() {
  log.info('=======================================================');
  log.info('  AI AGENTIC TRADING AUTOMATION PLATFORM  v1.0.0');
  log.info('=======================================================');
  log.info({ mode: config.trading.mode, pairs: config.trading.pairs }, 'Starting platform');

  // ---- Database ----
  log.info('Connecting to PostgreSQL...');
  const dbOk = await db.healthCheck();
  if (!dbOk) {
    log.error('PostgreSQL connection failed. Check DB_HOST, DB_USER, DB_PASSWORD.');
    process.exit(1);
  }
  await runMigrations();
  log.info('Database ready');

  // ---- Redis ----
  log.info('Connecting to Redis...');
  const redisOk = await redis.healthCheck();
  if (!redisOk) {
    log.warn('Redis connection failed. Platform will run without caching.');
  } else {
    log.info('Redis ready');
  }

  // ---- Initialize signal buffers ----
  log.info('Loading historical candle buffers...');
  await signalEngine.initializeBuffers();

  // ---- WebSocket ----
  const timeframes: Timeframe[] = [
    config.trading.defaultTimeframe as Timeframe,
    config.trading.secondaryTimeframe as Timeframe,
    config.trading.trendTimeframe as Timeframe,
  ];

  const wsService = new BinanceWebSocketService(
    config.trading.pairs as TradingPair[],
    timeframes,
  );

  // Handle candle events
  wsService.on('candle', async ({ pair, timeframe, candle, isClosed }) => {
    if (isClosed) {
      await signalEngine.onCandleClose(pair, timeframe, candle);
    }
  });

  // Handle aggregate trade events
  wsService.on('trade', async (trade: AggregateTrade) => {
    updateTradeBuffer(trade);

    // Whale detection
    const whale = trackTrade(trade);
    if (whale) {
      log.info({ pair: whale.pair, amountUsdt: whale.amountUsdt, significance: whale.significance }, 'Whale detected');
    }

    // MEV detection
    const mev = detectMEV(trade);
    if (mev) {
      log.warn({ type: mev.type, pair: mev.pair, confidence: mev.confidence }, 'MEV pattern detected');
    }

    // Update dry run positions with latest price
    if (config.trading.mode === 'dryrun') {
      await dryRunExecutor.updatePositionPrice(trade.pair, trade.price);
    }
  });

  // Handle ticker events  
  wsService.on('ticker', (_ticker) => {
    // Ticker updates are cached in redis by websocket service
  });

  wsService.on('connected', () => log.info('Market WebSocket connected and streaming'));
  wsService.on('error', (err) => log.error({ err }, 'WebSocket error'));
  wsService.on('fatal_error', (err) => {
    log.error({ err }, 'Fatal WebSocket error');
    process.exit(1);
  });

  wsService.start();

  // ---- Wire up signal → execution ----
  signalEngine.on('signal', async (signal) => {
    log.info({ pair: signal.pair, direction: signal.direction, confidence: signal.confidence }, 'Executing signal');

    // Send Telegram notification
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

  // Wire up position closed events
  dryRunExecutor.on('position_closed', async ({ position, reason }) => {
    await telegramNotifier.sendPositionClosed(position, reason).catch(() => {});
  });

  dryRunExecutor.on('position_liquidated', async (position) => {
    await telegramNotifier.sendPositionClosed(position, 'LIQUIDATED').catch(() => {});
    await telegramNotifier.sendRiskWarning(`Position LIQUIDATED on ${position.pair}!`).catch(() => {});
  });

  // ---- Daily report scheduler ----
  scheduleDailyReport();

  // ---- API Server ----
  const { httpServer } = createApiServer();
  httpServer.listen(config.app.port, () => {
    log.info({ port: config.app.port }, 'API server started');
  });

  log.info('=======================================================');
  log.info(`  Platform running in ${config.trading.mode.toUpperCase()} mode`);
  log.info(`  API: http://localhost:${config.app.port}`);
  log.info(`  Pairs: ${config.trading.pairs.join(', ')}`);
  log.info(`  Timeframe: ${config.trading.defaultTimeframe}`);
  log.info('=======================================================');

  // ---- Graceful shutdown ----
  process.on('SIGTERM', () => gracefulShutdown(wsService));
  process.on('SIGINT', () => gracefulShutdown(wsService));
}

function scheduleDailyReport() {
  const now = new Date();
  const nextReport = new Date();
  nextReport.setHours(23, 59, 0, 0);
  if (nextReport <= now) nextReport.setDate(nextReport.getDate() + 1);

  const delay = nextReport.getTime() - now.getTime();
  setTimeout(async () => {
    await telegramNotifier.sendDailyReport().catch(() => {});
    setInterval(() => telegramNotifier.sendDailyReport().catch(() => {}), 24 * 60 * 60 * 1000);
  }, delay);
}

async function gracefulShutdown(ws: BinanceWebSocketService) {
  log.info('Shutting down gracefully...');
  ws.stop();
  telegramNotifier.stop();
  await redis.close();
  await db.close();
  process.exit(0);
}

bootstrap().catch((err) => {
  log.error({ err }, 'Fatal startup error');
  process.exit(1);
});
