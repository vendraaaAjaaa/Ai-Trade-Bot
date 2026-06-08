/**
 * =============================================
 * CONFIG — Updated for Phases 1-7
 * =============================================
 *
 * New sections added:
 *   - featureFlags: all phase feature flags with env-override
 *   - consensus:    dynamic thresholds per mode
 *   - choppy:       configurable detection threshold
 *   - scoring:      weighted engine thresholds
 *
 * All new fields have safe defaults so existing deployments
 * continue to work without any .env changes.
 */

import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const configSchema = z.object({
  app: z.object({
    nodeEnv:  z.enum(['development', 'production', 'test']).default('development'),
    port:     z.number().default(3001),
    logLevel: z.string().default('info'),
  }),
  binance: z.object({
    apiKey:              z.string().min(1),
    apiSecret:           z.string().min(1),
    testnet:             z.boolean().default(true),
    futuresBaseUrl:      z.string().url(),
    spotBaseUrl:         z.string().url(),
    testnetFuturesUrl:   z.string().url(),
    testnetSpotUrl:      z.string().url(),
  }),
  database: z.object({
    host:     z.string().default('localhost'),
    port:     z.number().default(5432),
    name:     z.string().default('trading_platform'),
    user:     z.string().default('postgres'),
    password: z.string().default('postgres123'),
    poolMin:  z.number().default(2),
    poolMax:  z.number().default(10),
  }),
  redis: z.object({
    host:     z.string().default('localhost'),
    port:     z.number().default(6379),
    password: z.string().optional(),
    db:       z.number().default(0),
  }),
  telegram: z.object({
    botToken: z.string().default(''),
    chatId:   z.string().default(''),
  }),
  ai: z.object({
    codexPath:  z.string().default('codex'),
    geminiPath: z.string().default('gemini'),
  }),
  trading: z.object({
    pairs:              z.array(z.string()).default(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']),
    defaultTimeframe:   z.string().default('15m'),
    secondaryTimeframe: z.string().default('1h'),
    trendTimeframe:     z.string().default('4h'),
    mode:               z.enum(['live', 'dryrun', 'replay']).default('dryrun'),
  }),
  dryRun: z.object({
    balance:  z.number().default(10000),
    leverage: z.number().default(10),
    feeRate:  z.number().default(0.0004),
    slippage: z.number().default(0.0002),
  }),
  risk: z.object({
    maxDailyLossPercent:    z.number().default(5),
    maxOpenPositions:       z.number().default(3),
    maxPositionSizePercent: z.number().default(10),
    riskRewardMin:          z.number().default(1.5),
    cooldownAfterLossMinutes: z.number().default(30),
    maxLeverage:            z.number().default(20),
    defaultLeverage:        z.number().default(10),
    volatilityThreshold:    z.number().default(0.05),
  }),
  signals: z.object({
    minConfidenceScore:       z.number().default(70),
    volumeSpikeMultiplier:    z.number().default(2.0),
    whaleThresholdUsdt:       z.number().default(500000),
    minSignalIntervalMinutes: z.number().default(5),
  }),
  websocket: z.object({
    reconnectDelayMs:      z.number().default(5000),
    maxReconnectAttempts:  z.number().default(10),
    pingIntervalMs:        z.number().default(30000),
  }),

  // ── Phase 1-7 additions ─────────────────────────────────────

  /** Phase 1-7 feature flags — all default to the new behaviour */
  featureFlags: z.object({
    /** Phase 1: enable verbose per-filter signal logging */
    debugSignalFlow:       z.boolean().default(false),
    /** Phase 2: use per-mode consensus thresholds instead of hardcoded 4 */
    dynamicConsensus:      z.boolean().default(true),
    /** Phase 4: use OR logic for trigger TF in aggressive/scalping */
    relaxedMTF:            z.boolean().default(true),
    /** Phase 5: allow up to 2 soft fails for aggressive/scalping */
    softFailTolerance:     z.boolean().default(true),
    /** Phase 6: use tuned choppy threshold (7) instead of legacy (5) */
    choppyTuning:          z.boolean().default(true),
    /** Phase 7: run score engine in shadow mode (logs only, no trade impact) */
    scoringEngineShadow:   z.boolean().default(true),
    /** Phase 8 (future): activate scoring engine for real decisions */
    scoringEngineActive:   z.boolean().default(false),
  }),

  /** Phase 2: per-mode consensus required votes */
  consensus: z.object({
    requiredVotes: z.object({
      safe:       z.number().default(5),
      swing:      z.number().default(4),
      investing:  z.number().default(4),
      aggressive: z.number().default(3),
      scalping:   z.number().default(3),
    }),
    /** Legacy threshold used when dynamicConsensus=false */
    legacyRequiredVotes: z.number().default(4),
  }),

  /** Phase 3: floor confidence for neutral directional bias */
  agents: z.object({
    /**
     * Minimum confidence a neutral agent emits instead of WAIT.
     * E.g. 52 → agent votes directionally but with very low weight.
     */
    neutralConfidenceFloor: z.number().default(52),
  }),

  /** Phase 6: choppy detection score threshold */
  choppy: z.object({
    /** Score threshold above which market is classified as choppy.
     *  Max possible score is 9. Legacy=5, Phase 6 default=7. */
    scoreThreshold: z.number().default(7),
  }),

  /** Phase 7: scoring engine thresholds */
  scoring: z.object({
    entryThresholds: z.object({
      safe:       z.number().default(82),
      swing:      z.number().default(75),
      investing:  z.number().default(72),
      aggressive: z.number().default(60),
      scalping:   z.number().default(58),
    }),
  }),
});

export type AppConfig = z.infer<typeof configSchema>;

function parseConfig(): AppConfig {
  const raw = {
    app: {
      nodeEnv:  process.env['NODE_ENV'],
      port:     parseInt(process.env['PORT'] || '3001'),
      logLevel: process.env['LOG_LEVEL'] || 'info',
    },
    binance: {
      apiKey:            process.env['BINANCE_API_KEY']  || 'test_key',
      apiSecret:         process.env['BINANCE_API_SECRET'] || 'test_secret',
      testnet:           process.env['BINANCE_TESTNET'] === 'true',
      futuresBaseUrl:    process.env['BINANCE_FUTURES_BASE_URL']    || 'https://fapi.binance.com',
      spotBaseUrl:       process.env['BINANCE_SPOT_BASE_URL']       || 'https://api.binance.com',
      testnetFuturesUrl: process.env['BINANCE_TESTNET_FUTURES_URL'] || 'https://testnet.binancefuture.com',
      testnetSpotUrl:    process.env['BINANCE_TESTNET_SPOT_URL']    || 'https://testnet.binance.vision',
    },
    database: {
      host:     process.env['DB_HOST']         || 'localhost',
      port:     parseInt(process.env['DB_PORT'] || '5432'),
      name:     process.env['DB_NAME']         || 'trading_platform',
      user:     process.env['DB_USER']         || 'postgres',
      password: process.env['DB_PASSWORD']     || 'postgres123',
      poolMin:  parseInt(process.env['DB_POOL_MIN'] || '2'),
      poolMax:  parseInt(process.env['DB_POOL_MAX'] || '10'),
    },
    redis: {
      host:     process.env['REDIS_HOST']     || 'localhost',
      port:     parseInt(process.env['REDIS_PORT'] || '6379'),
      password: process.env['REDIS_PASSWORD'] || undefined,
      db:       parseInt(process.env['REDIS_DB'] || '0'),
    },
    telegram: {
      botToken: process.env['TELEGRAM_BOT_TOKEN'] || '',
      chatId:   process.env['TELEGRAM_CHAT_ID']   || '',
    },
    ai: {
      codexPath:  process.env['CODEX_PATH']  || 'codex',
      geminiPath: process.env['GEMINI_PATH'] || 'gemini',
    },
    trading: {
      pairs:              (process.env['TRADING_PAIRS'] || 'BTCUSDT,ETHUSDT,SOLUSDT').split(','),
      defaultTimeframe:   process.env['DEFAULT_TIMEFRAME']    || '15m',
      secondaryTimeframe: process.env['SECONDARY_TIMEFRAME']  || '1h',
      trendTimeframe:     process.env['TREND_TIMEFRAME']      || '4h',
      mode: (process.env['TRADING_MODE'] as 'live' | 'dryrun' | 'replay') || 'dryrun',
    },
    dryRun: {
      balance:  parseFloat(process.env['DRY_RUN_BALANCE']   || '10000'),
      leverage: parseInt(process.env['DRY_RUN_LEVERAGE']    || '10'),
      feeRate:  parseFloat(process.env['DRY_RUN_FEE_RATE']  || '0.0004'),
      slippage: parseFloat(process.env['DRY_RUN_SLIPPAGE']  || '0.0002'),
    },
    risk: {
      maxDailyLossPercent:      parseFloat(process.env['MAX_DAILY_LOSS_PERCENT']       || '5'),
      maxOpenPositions:         parseInt(process.env['MAX_OPEN_POSITIONS']             || '3'),
      maxPositionSizePercent:   parseFloat(process.env['MAX_POSITION_SIZE_PERCENT']    || '10'),
      riskRewardMin:            parseFloat(process.env['RISK_REWARD_MIN']              || '1.5'),
      cooldownAfterLossMinutes: parseInt(process.env['COOLDOWN_AFTER_LOSS_MINUTES']    || '30'),
      maxLeverage:              parseInt(process.env['MAX_LEVERAGE']                   || '20'),
      defaultLeverage:          parseInt(process.env['DEFAULT_LEVERAGE']               || '10'),
      volatilityThreshold:      parseFloat(process.env['VOLATILITY_THRESHOLD']        || '0.05'),
    },
    signals: {
      minConfidenceScore:       parseInt(process.env['MIN_CONFIDENCE_SCORE']           || '70'),
      volumeSpikeMultiplier:    parseFloat(process.env['VOLUME_SPIKE_MULTIPLIER']      || '2.0'),
      whaleThresholdUsdt:       parseFloat(process.env['WHALE_THRESHOLD_USDT']        || '500000'),
      minSignalIntervalMinutes: parseInt(process.env['MIN_SIGNAL_INTERVAL_MINUTES']    || '5'),
    },
    websocket: {
      reconnectDelayMs:     parseInt(process.env['WS_RECONNECT_DELAY_MS']             || '5000'),
      maxReconnectAttempts: parseInt(process.env['WS_MAX_RECONNECT_ATTEMPTS']         || '10'),
      pingIntervalMs:       parseInt(process.env['WS_PING_INTERVAL_MS']               || '30000'),
    },

    // ── Phase 1-7 additions ────────────────────────────────────
    featureFlags: {
      debugSignalFlow:     process.env['DEBUG_SIGNAL_FLOW']       === 'true',
      dynamicConsensus:    process.env['ENABLE_DYNAMIC_CONSENSUS'] !== 'false',
      relaxedMTF:          process.env['ENABLE_RELAXED_MTF']       !== 'false',
      softFailTolerance:   process.env['ENABLE_SOFT_FAIL_TOLERANCE'] !== 'false',
      choppyTuning:        process.env['ENABLE_CHOPPY_TUNING']    !== 'false',
      scoringEngineShadow: process.env['SCORING_ENGINE_SHADOW']   !== 'false',
      scoringEngineActive: process.env['USE_SCORING_ENGINE']      === 'true',
    },
    consensus: {
      requiredVotes: {
        safe:       parseInt(process.env['CONSENSUS_VOTES_SAFE']       || '5'),
        swing:      parseInt(process.env['CONSENSUS_VOTES_SWING']      || '4'),
        investing:  parseInt(process.env['CONSENSUS_VOTES_INVESTING']  || '4'),
        aggressive: parseInt(process.env['CONSENSUS_VOTES_AGGRESSIVE'] || '3'),
        scalping:   parseInt(process.env['CONSENSUS_VOTES_SCALPING']   || '3'),
      },
      legacyRequiredVotes: parseInt(process.env['CONSENSUS_LEGACY_VOTES'] || '4'),
    },
    agents: {
      neutralConfidenceFloor: parseInt(process.env['NEUTRAL_CONFIDENCE_FLOOR'] || '52'),
    },
    choppy: {
      scoreThreshold: parseInt(process.env['CHOPPY_SCORE_THRESHOLD'] || '7'),
    },
    scoring: {
      entryThresholds: {
        safe:       parseInt(process.env['SCORE_THRESHOLD_SAFE']       || '82'),
        swing:      parseInt(process.env['SCORE_THRESHOLD_SWING']      || '75'),
        investing:  parseInt(process.env['SCORE_THRESHOLD_INVESTING']  || '72'),
        aggressive: parseInt(process.env['SCORE_THRESHOLD_AGGRESSIVE'] || '60'),
        scalping:   parseInt(process.env['SCORE_THRESHOLD_SCALPING']   || '58'),
      },
    },
  };

  return configSchema.parse(raw);
}

export const config = parseConfig();
export default config;
