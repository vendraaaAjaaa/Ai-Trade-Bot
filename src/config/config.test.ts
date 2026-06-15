import { LIVE_TRADING_CONFIRMATION_PHRASE, parseConfig } from './index';

describe('configuration safety validation', () => {
  it('defaults to dryrun mode and Binance testnet', () => {
    const cfg = parseConfig({ NODE_ENV: 'test' });

    expect(cfg.trading.mode).toBe('dryrun');
    expect(cfg.binance.testnet).toBe(true);
    expect(cfg.risk.maxPositionNotionalPercent).toBe(10);
    expect(cfg.dryRun.restoreOpenPositions).toBe(true);
    expect(cfg.dryRun.strictRestore).toBe(false);
    expect(cfg.dashboard.backendApiUrl).toBe('http://localhost:3001');
  });

  it('rejects live mode when BINANCE_TESTNET is missing', () => {
    expect(() => parseConfig({
      NODE_ENV: 'test',
      TRADING_MODE: 'live',
      BINANCE_API_KEY: 'valid_key',
      BINANCE_API_SECRET: 'valid_secret',
      DASHBOARD_API_TOKEN: 'valid_dashboard_token_123456',
    })).toThrow(/BINANCE_TESTNET must be explicitly set/);
  });

  it('rejects placeholder Binance credentials in live mode', () => {
    expect(() => parseConfig({
      NODE_ENV: 'test',
      TRADING_MODE: 'live',
      BINANCE_TESTNET: 'true',
      BINANCE_API_KEY: 'test_key',
      BINANCE_API_SECRET: 'test_secret',
      DASHBOARD_API_TOKEN: 'valid_dashboard_token_123456',
    })).toThrow(/requires real Binance credentials/);
  });

  it('requires explicit confirmation for real-funds live trading', () => {
    expect(() => parseConfig({
      NODE_ENV: 'test',
      TRADING_MODE: 'live',
      BINANCE_TESTNET: 'false',
      BINANCE_API_KEY: 'valid_key',
      BINANCE_API_SECRET: 'valid_secret',
      DASHBOARD_API_TOKEN: 'valid_dashboard_token_123456',
    })).toThrow(/LIVE_TRADING_CONFIRMATION/);
  });

  it('accepts live testnet with explicit non-placeholder credentials and dashboard token', () => {
    const cfg = parseConfig({
      NODE_ENV: 'test',
      TRADING_MODE: 'live',
      BINANCE_TESTNET: 'true',
      BINANCE_API_KEY: 'valid_key',
      BINANCE_API_SECRET: 'valid_secret',
      DASHBOARD_API_TOKEN: 'valid_dashboard_token_123456',
    });

    expect(cfg.trading.mode).toBe('live');
    expect(cfg.binance.testnet).toBe(true);
  });

  it('accepts real-funds live mode only with the exact confirmation phrase', () => {
    const cfg = parseConfig({
      NODE_ENV: 'test',
      TRADING_MODE: 'live',
      BINANCE_TESTNET: 'false',
      BINANCE_API_KEY: 'valid_key',
      BINANCE_API_SECRET: 'valid_secret',
      LIVE_TRADING_CONFIRMATION: LIVE_TRADING_CONFIRMATION_PHRASE,
      DASHBOARD_API_TOKEN: 'valid_dashboard_token_123456',
      CORS_ORIGINS: 'http://localhost:3000',
    });

    expect(cfg.binance.testnet).toBe(false);
  });

  it('rejects invalid risk limits', () => {
    expect(() => parseConfig({
      NODE_ENV: 'test',
      MAX_DAILY_LOSS_PERCENT: '-1',
    })).toThrow(/maxDailyLossPercent/);

    expect(() => parseConfig({
      NODE_ENV: 'test',
      DEFAULT_LEVERAGE: '20',
      MAX_LEVERAGE: '5',
    })).toThrow(/DEFAULT_LEVERAGE/);

    expect(() => parseConfig({
      NODE_ENV: 'test',
      MAX_POSITION_NOTIONAL_PERCENT: '0',
    })).toThrow(/maxPositionNotionalPercent/);

    expect(() => parseConfig({
      NODE_ENV: 'test',
      MAX_POSITION_NOTIONAL_PERCENT: '101',
    })).toThrow(/maxPositionNotionalPercent/);
  });

  it('parses server-only dashboard backend URL and dry-run restore flags', () => {
    const cfg = parseConfig({
      NODE_ENV: 'test',
      BACKEND_API_URL: 'http://backend:3001',
      DRYRUN_RESTORE_OPEN_POSITIONS: 'false',
      DRYRUN_STRICT_RESTORE: 'true',
      MAX_POSITION_NOTIONAL_PERCENT: '25',
    });

    expect(cfg.dashboard.backendApiUrl).toBe('http://backend:3001');
    expect(cfg.dryRun.restoreOpenPositions).toBe(false);
    expect(cfg.dryRun.strictRestore).toBe(true);
    expect(cfg.risk.maxPositionNotionalPercent).toBe(25);
  });
});
