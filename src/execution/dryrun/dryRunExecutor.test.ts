import type { TradingSignal } from '../../utils/types';

const mockRedisStore = new Map<string, unknown>();

jest.mock('../../config', () => ({
  config: {
    app: {
      nodeEnv: 'test',
      logLevel: 'silent',
    },
    dryRun: {
      balance: 10000,
      leverage: 10,
      feeRate: 0.001,
      slippage: 0,
    },
  },
}));

jest.mock('../../redis/client', () => ({
  redis: {
    getJson: jest.fn(async (key: string) => mockRedisStore.get(key) ?? null),
    setJson: jest.fn(async (key: string, value: unknown) => {
      mockRedisStore.set(key, JSON.parse(JSON.stringify(value)));
    }),
  },
  CacheKeys: {
    dryRunWallet: () => 'dryrun:wallet',
  },
}));

jest.mock('../../database/connection', () => ({
  db: { query: jest.fn().mockResolvedValue([]) },
}));

jest.mock('../../risk/riskManager', () => ({
  riskManager: {
    assessSignal: jest.fn(),
    onPositionOpened: jest.fn().mockResolvedValue(undefined),
    onPositionClosed: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../../strategy/frequencyLimiter', () => ({
  frequencyLimiter: {
    recordTrade: jest.fn().mockResolvedValue(undefined),
    recordWin: jest.fn().mockResolvedValue(undefined),
    recordLoss: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../../regime/marketRegimeEngine', () => ({
  marketRegimeEngine: {
    getCached: jest.fn().mockResolvedValue({ regime: 'trending_up' }),
  },
}));

jest.mock('../../session/sessionFilter', () => ({
  sessionFilter: {
    getCurrentSession: jest.fn(() => ({ name: 'london' })),
  },
}));

jest.mock('../../review/selfReviewEngine', () => ({
  selfReviewEngine: {
    reviewTrade: jest.fn().mockResolvedValue(undefined),
  },
}));

import { riskManager } from '../../risk/riskManager';
import { DryRunExecutor, type VirtualWallet } from './dryRunExecutor';

const riskMock = riskManager as unknown as {
  assessSignal: jest.Mock;
  onPositionOpened: jest.Mock;
  onPositionClosed: jest.Mock;
};

function makeSignal(): TradingSignal {
  return {
    id: 'signal-1',
    pair: 'BTCUSDT',
    direction: 'LONG',
    confidence: 90,
    buyScore: 90,
    sellScore: 10,
    strength: 'STRONG',
    entry: 100,
    stopLoss: 90,
    takeProfit: 120,
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
  };
}

async function createExecutor(): Promise<DryRunExecutor> {
  const executor = new DryRunExecutor();
  await executor.init();
  return executor;
}

describe('DryRunExecutor wallet accounting', () => {
  beforeEach(() => {
    mockRedisStore.clear();
    riskMock.assessSignal.mockResolvedValue({
      isAllowed: true,
      positionSize: 1,
      riskAmount: 10,
      leverage: 10,
      stopLossDistance: 0.1,
      riskReward: 2,
      currentDrawdown: 0,
      dailyLoss: 0,
      openPositions: 0,
      warnings: [],
    });
    riskMock.onPositionOpened.mockClear();
    riskMock.onPositionClosed.mockClear();
  });

  it('opens a position by reserving margin and deducting entry fee only', async () => {
    const executor = await createExecutor();

    const position = await executor.executeSignal(makeSignal());
    const wallet = executor.getWallet();

    expect(position?.margin).toBe(10);
    expect(position?.fees).toBe(0.1);
    expect(wallet.balance).toBeCloseTo(9999.9);
    expect(wallet.usedMargin).toBeCloseTo(10);
    expect(wallet.equity).toBeCloseTo(9999.9);
    expect(wallet.freeMargin).toBeCloseTo(9989.9);
    expect(wallet.fees).toBeCloseTo(0.1);
  });

  it('closes a profitable position without adding back undeducted margin', async () => {
    const executor = await createExecutor();
    const position = await executor.executeSignal(makeSignal());

    await executor.closePosition(position!.id, 120, 'TP_HIT');
    const wallet = executor.getWallet();

    expect(wallet.balance).toBeCloseTo(10019.78);
    expect(wallet.usedMargin).toBe(0);
    expect(wallet.realizedPnl).toBeCloseTo(19.78);
    expect(wallet.dailyPnl).toBeCloseTo(19.78);
    expect(wallet.fees).toBeCloseTo(0.22);
  });

  it('closes a losing position with internally consistent fee accounting', async () => {
    const executor = await createExecutor();
    const position = await executor.executeSignal(makeSignal());

    await executor.closePosition(position!.id, 90, 'SL_HIT');
    const wallet = executor.getWallet();

    expect(wallet.balance).toBeCloseTo(9989.81);
    expect(wallet.usedMargin).toBe(0);
    expect(wallet.realizedPnl).toBeCloseTo(-10.19);
    expect(wallet.dailyPnl).toBeCloseTo(-10.19);
    expect(wallet.fees).toBeCloseTo(0.19);
  });

  it('liquidation consumes margin and records a loss without leaving used margin', async () => {
    const executor = await createExecutor();
    await executor.executeSignal(makeSignal());

    await executor.updatePositionPrice('BTCUSDT', 90);
    const wallet = executor.getWallet();

    expect(executor.getOpenPositions()).toHaveLength(0);
    expect(wallet.balance).toBeCloseTo(9989.81);
    expect(wallet.usedMargin).toBe(0);
    expect(wallet.realizedPnl).toBeCloseTo(-10.19);
    expect(wallet.freeMargin).toBeCloseTo(wallet.equity);
  });

  it('reloads wallet state from persistence before the first signal can execute', async () => {
    const persistedWallet: VirtualWallet = {
      balance: 1234,
      equity: 1234,
      usedMargin: 0,
      freeMargin: 1234,
      unrealizedPnl: 0,
      realizedPnl: 10,
      dailyPnl: 10,
      fees: 1,
    };
    mockRedisStore.set('dryrun:wallet', persistedWallet);

    const executor = await createExecutor();
    await executor.executeSignal(makeSignal());

    expect(riskMock.assessSignal).toHaveBeenCalledWith(expect.anything(), 1234);
  });
});
