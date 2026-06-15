/**
 * =============================================
 * CONFIG — Phase 8 Defensive Safety Validation
 * =============================================
 *
 * Changes from Phase 8:
 *   - Live trading requires explicit mode, explicit BINANCE_TESTNET, valid credentials,
 *     and LIVE_TRADING_CONFIRMATION before real-funds endpoints are allowed.
 *   - Dashboard API token, CORS allowlist, and rate-limit settings are validated here.
 *   - Numeric risk and runtime settings are bounded with clear fail-closed errors.
 *   - Phase 9 adds explicit max-position-notional and dry-run restore controls.
 *
 * Safety preserved:
 *   - Dry-run remains the default trading mode.
 *   - Binance testnet remains the default unless explicitly disabled.
 *   - USE_SCORING_ENGINE still defaults to false and remains shadow-only by default.
 */

import dotenv from 'dotenv';
import { z, ZodError } from 'zod';

if (process.env['NODE_ENV'] !== 'test') {
  dotenv.config();
}

export const LIVE_TRADING_CONFIRMATION_PHRASE = 'I_UNDERSTAND_THIS_USES_REAL_FUNDS';

const PLACEHOLDER_CREDENTIALS = new Set([
  '',
  'test',
  'test_key',
  'test_secret',
  'your_binance_api_key_here',
  'your_binance_secret_here',
  'change_me',
  'changeme',
]);

const PLACEHOLDER_TOKENS = new Set([
  '',
  'change_me',
  'change_me_dashboard_token',
  'your_dashboard_api_token_here',
]);

const tradingPairSchema = z.enum(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
const timeframeSchema = z.enum(['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d']);
const tradingModeSchema = z.enum(['live', 'dryrun', 'replay']);

const configSchema = z.object({
  app: z.object({
    nodeEnv: z.enum(['development', 'production', 'test']).default('development'),
    port: z.number().int().min(1).max(65535).default(3001),
    logLevel: z.string().min(1).default('info'),
  }),
  binance: z.object({
    apiKey: z.string(),
    apiSecret: z.string(),
    testnet: z.boolean().default(true),
    futuresBaseUrl: z.string().url(),
    spotBaseUrl: z.string().url(),
    testnetFuturesUrl: z.string().url(),
    testnetSpotUrl: z.string().url(),
  }),
  database: z.object({
    host: z.string().min(1).default('localhost'),
    port: z.number().int().min(1).max(65535).default(5432),
    name: z.string().min(1).default('trading_platform'),
    user: z.string().min(1).default('postgres'),
    password: z.string().min(8).default('change_me_strong_password'),
    poolMin: z.number().int().min(0).max(50).default(2),
    poolMax: z.number().int().min(1).max(100).default(10),
  }),
  redis: z.object({
    host: z.string().min(1).default('localhost'),
    port: z.number().int().min(1).max(65535).default(6379),
    password: z.string().optional(),
    db: z.number().int().min(0).max(15).default(0),
  }),
  telegram: z.object({
    botToken: z.string().default(''),
    chatId: z.string().default(''),
  }),
  ai: z.object({
    codexPath: z.string().min(1).default('codex'),
    geminiPath: z.string().min(1).default('gemini'),
  }),
  trading: z.object({
    pairs: z.array(tradingPairSchema).nonempty(),
    defaultTimeframe: timeframeSchema.default('15m'),
    secondaryTimeframe: timeframeSchema.default('1h'),
    trendTimeframe: timeframeSchema.default('4h'),
    mode: tradingModeSchema.default('dryrun'),
  }),
  dryRun: z.object({
    balance: z.number().finite().positive().default(10000),
    leverage: z.number().int().min(1).max(20).default(10),
    feeRate: z.number().finite().min(0).max(0.01).default(0.0004),
    slippage: z.number().finite().min(0).max(0.05).default(0.0002),
    restoreOpenPositions: z.boolean().default(true),
    strictRestore: z.boolean().default(false),
  }),
  risk: z.object({
    maxDailyLossPercent: z.number().finite().positive().max(50).default(5),
    maxOpenPositions: z.number().int().min(1).max(20).default(3),
    maxPositionSizePercent: z.number().finite().positive().max(10).default(10),
    maxPositionNotionalPercent: z.number().finite().positive().max(100).default(10),
    riskRewardMin: z.number().finite().min(1).max(10).default(1.5),
    cooldownAfterLossMinutes: z.number().int().min(1).max(1440).default(30),
    maxLeverage: z.number().int().min(1).max(20).default(20),
    defaultLeverage: z.number().int().min(1).max(20).default(10),
    volatilityThreshold: z.number().finite().positive().max(1).default(0.05),
  }),
  signals: z.object({
    minConfidenceScore: z.number().int().min(1).max(100).default(70),
    volumeSpikeMultiplier: z.number().finite().positive().max(100).default(2.0),
    whaleThresholdUsdt: z.number().finite().positive().default(500000),
    minSignalIntervalMinutes: z.number().int().min(1).max(1440).default(5),
  }),
  websocket: z.object({
    reconnectDelayMs: z.number().int().min(100).max(60000).default(5000),
    maxReconnectAttempts: z.number().int().min(1).max(1000).default(10),
    pingIntervalMs: z.number().int().min(5000).max(300000).default(30000),
  }),
  dashboard: z.object({
    apiToken: z.string().default(''),
    backendApiUrl: z.string().url().default('http://localhost:3001'),
    corsOrigins: z.array(z.string().url()).nonempty(),
    rateLimitWindowMs: z.number().int().min(1000).max(3600000).default(60000),
    rateLimitMax: z.number().int().min(1).max(10000).default(120),
  }),

  // Phase 1-7 feature flags.
  featureFlags: z.object({
    debugSignalFlow: z.boolean().default(false),
    dynamicConsensus: z.boolean().default(true),
    relaxedMTF: z.boolean().default(true),
    softFailTolerance: z.boolean().default(true),
    choppyTuning: z.boolean().default(true),
    scoringEngineShadow: z.boolean().default(true),
    scoringEngineActive: z.boolean().default(false),
  }),

  consensus: z.object({
    requiredVotes: z.object({
      safe: z.number().int().min(1).max(7).default(5),
      swing: z.number().int().min(1).max(7).default(4),
      investing: z.number().int().min(1).max(7).default(4),
      aggressive: z.number().int().min(1).max(7).default(3),
      scalping: z.number().int().min(1).max(7).default(3),
    }),
    legacyRequiredVotes: z.number().int().min(1).max(7).default(4),
  }),

  agents: z.object({
    neutralConfidenceFloor: z.number().int().min(0).max(100).default(52),
  }),

  choppy: z.object({
    scoreThreshold: z.number().int().min(1).max(9).default(7),
  }),

  scoring: z.object({
    entryThresholds: z.object({
      safe: z.number().int().min(1).max(100).default(82),
      swing: z.number().int().min(1).max(100).default(75),
      investing: z.number().int().min(1).max(100).default(72),
      aggressive: z.number().int().min(1).max(100).default(60),
      scalping: z.number().int().min(1).max(100).default(58),
    }),
  }),
}).superRefine((cfg, ctx) => {
  if (cfg.database.poolMin > cfg.database.poolMax) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['database', 'poolMin'],
      message: 'DB_POOL_MIN must be less than or equal to DB_POOL_MAX.',
    });
  }

  if (cfg.risk.defaultLeverage > cfg.risk.maxLeverage) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['risk', 'defaultLeverage'],
      message: 'DEFAULT_LEVERAGE must be less than or equal to MAX_LEVERAGE.',
    });
  }

  if (cfg.dryRun.leverage > cfg.risk.maxLeverage) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['dryRun', 'leverage'],
      message: 'DRY_RUN_LEVERAGE must be less than or equal to MAX_LEVERAGE.',
    });
  }
});

export type AppConfig = z.infer<typeof configSchema>;
type Env = NodeJS.ProcessEnv | Record<string, string | undefined>;

function envString(env: Env, key: string, defaultValue = ''): string {
  return (env[key] ?? defaultValue).trim();
}

function optionalEnvString(env: Env, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

function envNumber(env: Env, key: string, defaultValue: number): number {
  const raw = env[key]?.trim();
  return raw ? Number(raw) : defaultValue;
}

function envBoolean(env: Env, key: string, defaultValue: boolean): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (!raw) return defaultValue;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`Invalid configuration: ${key} must be "true" or "false".`);
}

function envCsv(env: Env, key: string, defaultValue: readonly string[]): string[] {
  const raw = env[key]?.trim();
  const source = raw ? raw.split(',') : [...defaultValue];
  return source.map((item) => item.trim()).filter(Boolean);
}

function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_CREDENTIALS.has(value.trim().toLowerCase());
}

function isPlaceholderToken(value: string): boolean {
  return PLACEHOLDER_TOKENS.has(value.trim().toLowerCase());
}

function assertLiveSafety(env: Env, raw: { mode: string; testnet: boolean; apiKey: string; apiSecret: string; dashboardToken: string }): void {
  if (raw.mode !== 'live') return;

  if (!env['TRADING_MODE']?.trim()) {
    throw new Error('Invalid configuration: TRADING_MODE must be explicitly set when live trading is enabled.');
  }

  if (!env['BINANCE_TESTNET']?.trim()) {
    throw new Error('Invalid configuration: BINANCE_TESTNET must be explicitly set when TRADING_MODE=live.');
  }

  if (isPlaceholder(raw.apiKey) || isPlaceholder(raw.apiSecret)) {
    throw new Error('Invalid configuration: live mode requires real Binance credentials, not placeholders or empty values.');
  }

  if (!raw.testnet && envString(env, 'LIVE_TRADING_CONFIRMATION') !== LIVE_TRADING_CONFIRMATION_PHRASE) {
    throw new Error(
      `Invalid configuration: real-funds live trading requires LIVE_TRADING_CONFIRMATION=${LIVE_TRADING_CONFIRMATION_PHRASE}.`,
    );
  }

  if (!raw.dashboardToken || isPlaceholderToken(raw.dashboardToken)) {
    throw new Error('Invalid configuration: DASHBOARD_API_TOKEN is required and cannot be a placeholder in live mode.');
  }
}

function assertProductionSafety(env: Env, nodeEnv: string, mode: string, dashboardToken: string): void {
  if (nodeEnv !== 'production' && mode !== 'live') return;

  if (!dashboardToken || isPlaceholderToken(dashboardToken)) {
    throw new Error('Invalid configuration: DASHBOARD_API_TOKEN is required and cannot be a placeholder in production/live mode.');
  }

  const origins = envCsv(env, 'CORS_ORIGINS', []);
  if (nodeEnv === 'production' && origins.length === 0) {
    throw new Error('Invalid configuration: CORS_ORIGINS must be set to an explicit allowlist in production.');
  }
}

export function parseConfig(env: Env = process.env): AppConfig {
  const nodeEnv = envString(env, 'NODE_ENV', 'development');
  const mode = envString(env, 'TRADING_MODE', 'dryrun');
  const testnet = envBoolean(env, 'BINANCE_TESTNET', true);
  const apiKey = envString(env, 'BINANCE_API_KEY');
  const apiSecret = envString(env, 'BINANCE_API_SECRET');
  const dashboardToken = envString(env, 'DASHBOARD_API_TOKEN');

  assertLiveSafety(env, { mode, testnet, apiKey, apiSecret, dashboardToken });
  assertProductionSafety(env, nodeEnv, mode, dashboardToken);

  const raw = {
    app: {
      nodeEnv,
      port: envNumber(env, 'PORT', 3001),
      logLevel: envString(env, 'LOG_LEVEL', 'info'),
    },
    binance: {
      apiKey,
      apiSecret,
      testnet,
      futuresBaseUrl: envString(env, 'BINANCE_FUTURES_BASE_URL', 'https://fapi.binance.com'),
      spotBaseUrl: envString(env, 'BINANCE_SPOT_BASE_URL', 'https://api.binance.com'),
      testnetFuturesUrl: envString(env, 'BINANCE_TESTNET_FUTURES_URL', 'https://testnet.binancefuture.com'),
      testnetSpotUrl: envString(env, 'BINANCE_TESTNET_SPOT_URL', 'https://testnet.binance.vision'),
    },
    database: {
      host: envString(env, 'DB_HOST', 'localhost'),
      port: envNumber(env, 'DB_PORT', 5432),
      name: envString(env, 'DB_NAME', 'trading_platform'),
      user: envString(env, 'DB_USER', 'postgres'),
      password: envString(env, 'DB_PASSWORD', 'change_me_strong_password'),
      poolMin: envNumber(env, 'DB_POOL_MIN', 2),
      poolMax: envNumber(env, 'DB_POOL_MAX', 10),
    },
    redis: {
      host: envString(env, 'REDIS_HOST', 'localhost'),
      port: envNumber(env, 'REDIS_PORT', 6379),
      password: optionalEnvString(env, 'REDIS_PASSWORD'),
      db: envNumber(env, 'REDIS_DB', 0),
    },
    telegram: {
      botToken: envString(env, 'TELEGRAM_BOT_TOKEN'),
      chatId: envString(env, 'TELEGRAM_CHAT_ID'),
    },
    ai: {
      codexPath: envString(env, 'CODEX_PATH', 'codex'),
      geminiPath: envString(env, 'GEMINI_PATH', 'gemini'),
    },
    trading: {
      pairs: envCsv(env, 'TRADING_PAIRS', ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']).map((pair) => pair.toUpperCase()),
      defaultTimeframe: envString(env, 'DEFAULT_TIMEFRAME', '15m'),
      secondaryTimeframe: envString(env, 'SECONDARY_TIMEFRAME', '1h'),
      trendTimeframe: envString(env, 'TREND_TIMEFRAME', '4h'),
      mode,
    },
    dryRun: {
      balance: envNumber(env, 'DRY_RUN_BALANCE', 10000),
      leverage: envNumber(env, 'DRY_RUN_LEVERAGE', 10),
      feeRate: envNumber(env, 'DRY_RUN_FEE_RATE', 0.0004),
      slippage: envNumber(env, 'DRY_RUN_SLIPPAGE', 0.0002),
      restoreOpenPositions: envBoolean(env, 'DRYRUN_RESTORE_OPEN_POSITIONS', true),
      strictRestore: envBoolean(env, 'DRYRUN_STRICT_RESTORE', false),
    },
    risk: {
      maxDailyLossPercent: envNumber(env, 'MAX_DAILY_LOSS_PERCENT', 5),
      maxOpenPositions: envNumber(env, 'MAX_OPEN_POSITIONS', 3),
      maxPositionSizePercent: envNumber(env, 'MAX_POSITION_SIZE_PERCENT', 10),
      maxPositionNotionalPercent: envNumber(env, 'MAX_POSITION_NOTIONAL_PERCENT', 10),
      riskRewardMin: envNumber(env, 'RISK_REWARD_MIN', 1.5),
      cooldownAfterLossMinutes: envNumber(env, 'COOLDOWN_AFTER_LOSS_MINUTES', 30),
      maxLeverage: envNumber(env, 'MAX_LEVERAGE', 20),
      defaultLeverage: envNumber(env, 'DEFAULT_LEVERAGE', 10),
      volatilityThreshold: envNumber(env, 'VOLATILITY_THRESHOLD', 0.05),
    },
    signals: {
      minConfidenceScore: envNumber(env, 'MIN_CONFIDENCE_SCORE', 70),
      volumeSpikeMultiplier: envNumber(env, 'VOLUME_SPIKE_MULTIPLIER', 2.0),
      whaleThresholdUsdt: envNumber(env, 'WHALE_THRESHOLD_USDT', 500000),
      minSignalIntervalMinutes: envNumber(env, 'MIN_SIGNAL_INTERVAL_MINUTES', 5),
    },
    websocket: {
      reconnectDelayMs: envNumber(env, 'WS_RECONNECT_DELAY_MS', 5000),
      maxReconnectAttempts: envNumber(env, 'WS_MAX_RECONNECT_ATTEMPTS', 10),
      pingIntervalMs: envNumber(env, 'WS_PING_INTERVAL_MS', 30000),
    },
    dashboard: {
      apiToken: dashboardToken,
      backendApiUrl: envString(env, 'BACKEND_API_URL', envString(env, 'DASHBOARD_API_URL', 'http://localhost:3001')),
      corsOrigins: envCsv(env, 'CORS_ORIGINS', ['http://localhost:3000', 'http://127.0.0.1:3000']),
      rateLimitWindowMs: envNumber(env, 'DASHBOARD_RATE_LIMIT_WINDOW_MS', 60000),
      rateLimitMax: envNumber(env, 'DASHBOARD_RATE_LIMIT_MAX', 120),
    },
    featureFlags: {
      debugSignalFlow: envBoolean(env, 'DEBUG_SIGNAL_FLOW', false),
      dynamicConsensus: envBoolean(env, 'ENABLE_DYNAMIC_CONSENSUS', true),
      relaxedMTF: envBoolean(env, 'ENABLE_RELAXED_MTF', true),
      softFailTolerance: envBoolean(env, 'ENABLE_SOFT_FAIL_TOLERANCE', true),
      choppyTuning: envBoolean(env, 'ENABLE_CHOPPY_TUNING', true),
      scoringEngineShadow: envBoolean(env, 'SCORING_ENGINE_SHADOW', true),
      scoringEngineActive: envBoolean(env, 'USE_SCORING_ENGINE', false),
    },
    consensus: {
      requiredVotes: {
        safe: envNumber(env, 'CONSENSUS_VOTES_SAFE', 5),
        swing: envNumber(env, 'CONSENSUS_VOTES_SWING', 4),
        investing: envNumber(env, 'CONSENSUS_VOTES_INVESTING', 4),
        aggressive: envNumber(env, 'CONSENSUS_VOTES_AGGRESSIVE', 3),
        scalping: envNumber(env, 'CONSENSUS_VOTES_SCALPING', 3),
      },
      legacyRequiredVotes: envNumber(env, 'CONSENSUS_LEGACY_VOTES', 4),
    },
    agents: {
      neutralConfidenceFloor: envNumber(env, 'NEUTRAL_CONFIDENCE_FLOOR', 52),
    },
    choppy: {
      scoreThreshold: envNumber(env, 'CHOPPY_SCORE_THRESHOLD', 7),
    },
    scoring: {
      entryThresholds: {
        safe: envNumber(env, 'SCORE_THRESHOLD_SAFE', 82),
        swing: envNumber(env, 'SCORE_THRESHOLD_SWING', 75),
        investing: envNumber(env, 'SCORE_THRESHOLD_INVESTING', 72),
        aggressive: envNumber(env, 'SCORE_THRESHOLD_AGGRESSIVE', 60),
        scalping: envNumber(env, 'SCORE_THRESHOLD_SCALPING', 58),
      },
    },
  };

  try {
    return configSchema.parse(raw);
  } catch (error) {
    if (error instanceof ZodError) {
      const details = error.issues
        .map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`)
        .join('\n- ');
      throw new Error(`Invalid configuration:\n- ${details}`);
    }
    throw error;
  }
}

export function buildChildProcessEnv(extraEnv: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, ...extraEnv };
}

export const config = parseConfig();
export default config;
