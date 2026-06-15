import type { TradingSignal } from '../utils/types';
import type { AppConfig } from '../config';

let mockRiskState: unknown = null;

jest.mock('../redis/client', () => ({
  redis: {
    getJson: jest.fn(async () => mockRiskState),
    setJson: jest.fn().mockResolvedValue(undefined),
  },
  CacheKeys: {
    riskState: () => 'risk:state',
  },
}));

jest.mock('../database/connection', () => ({
  db: {
    query: jest.fn().mockResolvedValue([{ count: '0' }]),
  },
}));

import { config } from '../config';
import { RiskManager } from './riskManager';

function makeSignal(overrides: Partial<TradingSignal> = {}): TradingSignal {
  return {
    id: 'signal-1',
    pair: 'BTCUSDT',
    direction: 'LONG',
    confidence: 90,
    buyScore: 90,
    sellScore: 10,
    strength: 'STRONG',
    entry: 1000,
    stopLoss: 950,
    takeProfit: 1100,
    riskReward: 2,
    reasons: ['test'],
    indicators: {
      ema20: 1,
      ema50: 1,
      ema200: 1,
      vwap: 1,
      rsi: 50,
      macdHistogram: 1,
      macdLine: 1,
      signalLine: 1,
      atr: 10,
      rsiDivergence: 'none',
      trend: 'bullish',
    },
    volumeAnalysis: {
      currentVolume: 1,
      avgVolume: 1,
      volumeRatio: 1,
      isVolumeSpike: false,
      deltaVolume: 0,
      buyVolume: 1,
      sellVolume: 1,
      buyPressure: 50,
      isAbsorption: false,
      isLiquiditySweep: false,
      isWhaleActivity: false,
      isSpoofing: false,
      aggressiveBuys: 0,
      aggressiveSells: 0,
      imbalancePercent: 0,
    },
    patternAnalysis: {
      isBreakout: false,
      isFakeBreakout: false,
      isBOS: false,
      isCHOCH: false,
      hasOrderBlock: false,
      hasFairValueGap: false,
      isTrendContinuation: false,
      isReversal: false,
      orderBlockLevel: null,
      fvgHigh: null,
      fvgLow: null,
      structureLevel: null,
    },
    timestamp: Date.now(),
    timeframe: '15m',
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

function resetRiskConfig(): void {
  const risk = config.risk as AppConfig['risk'];
  risk.maxDailyLossPercent = 5;
  risk.maxOpenPositions = 3;
  risk.maxPositionSizePercent = 10;
  risk.maxPositionNotionalPercent = 10;
  risk.riskRewardMin = 1.5;
  risk.cooldownAfterLossMinutes = 30;
  risk.maxLeverage = 20;
  risk.defaultLeverage = 10;
  risk.volatilityThreshold = 0.05;
  config.signals.minConfidenceScore = 70;
}

function currentRiskState(overrides: Record<string, number> = {}) {
  return {
    dailyPnl: 0,
    dailyLossCount: 0,
    openPositions: 0,
    lastLossTime: 0,
    lastUpdated: Date.now(),
    ...overrides,
  };
}

describe('RiskManager fail-closed checks', () => {
  beforeEach(() => {
    resetRiskConfig();
    mockRiskState = currentRiskState();
  });

  it('rejects negative balances', async () => {
    const manager = new RiskManager();

    const result = await manager.assessSignal(makeSignal(), -1);

    expect(result.isAllowed).toBe(false);
    expect(result.reason).toMatch(/Invalid account balance/);
  });

  it('rejects zero stop distance', async () => {
    const manager = new RiskManager();

    const result = await manager.assessSignal(makeSignal({ stopLoss: 1000 }), 10000);

    expect(result.isAllowed).toBe(false);
    expect(result.reason).toMatch(/Stop-loss distance/);
  });

  it('rejects leverage configuration above the hard cap', async () => {
    config.risk.defaultLeverage = 21;
    const manager = new RiskManager();

    const result = await manager.assessSignal(makeSignal(), 10000);

    expect(result.isAllowed).toBe(false);
    expect(result.reason).toMatch(/Invalid leverage/);
  });

  it('caps position size at configured notional percent of balance', async () => {
    config.risk.maxPositionNotionalPercent = 5;
    const manager = new RiskManager();

    const result = await manager.assessSignal(makeSignal({ entry: 1000, stopLoss: 999 }), 10000);

    expect(result.isAllowed).toBe(true);
    expect(result.positionSize).toBeCloseTo(0.5);
    expect(result.positionSize * 1000).toBeLessThanOrEqual(500);
  });

  it('allows risk sizing below the configured notional cap', async () => {
    config.risk.maxPositionSizePercent = 1;
    config.risk.maxPositionNotionalPercent = 100;
    const manager = new RiskManager();

    const result = await manager.assessSignal(makeSignal({ entry: 1000, stopLoss: 950 }), 10000);

    expect(result.isAllowed).toBe(true);
    expect(result.positionSize).toBeCloseTo(2);
    expect(result.riskAmount).toBeCloseTo(100);
  });

  it('rejects invalid max risk configuration', async () => {
    config.risk.maxPositionSizePercent = -1;
    const manager = new RiskManager();

    const result = await manager.assessSignal(makeSignal(), 10000);

    expect(result.isAllowed).toBe(false);
    expect(result.reason).toMatch(/position size|risk/i);
  });

  it('rejects invalid zero, negative, and over-100 notional cap configuration', async () => {
    const manager = new RiskManager();

    config.risk.maxPositionNotionalPercent = 0;
    let result = await manager.assessSignal(makeSignal(), 10000);
    expect(result.isAllowed).toBe(false);

    config.risk.maxPositionNotionalPercent = -1;
    result = await manager.assessSignal(makeSignal(), 10000);
    expect(result.isAllowed).toBe(false);

    config.risk.maxPositionNotionalPercent = 101;
    result = await manager.assessSignal(makeSignal(), 10000);
    expect(result.isAllowed).toBe(false);
    expect(result.reason).toMatch(/notional/);
  });

  it('rejects when cooldown is active after a loss', async () => {
    mockRiskState = currentRiskState({ lastLossTime: Date.now() });
    const manager = new RiskManager();

    const result = await manager.assessSignal(makeSignal(), 10000);

    expect(result.isAllowed).toBe(false);
    expect(result.reason).toMatch(/Cooldown active/);
  });

  it('rejects when daily loss limit has been reached', async () => {
    mockRiskState = currentRiskState({ dailyPnl: -600 });
    const manager = new RiskManager();

    const result = await manager.assessSignal(makeSignal(), 10000);

    expect(result.isAllowed).toBe(false);
    expect(result.reason).toMatch(/Daily loss limit/);
  });
});
