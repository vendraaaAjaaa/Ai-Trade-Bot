import type { TradingSignal } from '../../utils/types';

const mockRedisStore = new Map<string, unknown>();
let mockPositionRows: Array<Record<string, unknown>> = [];
let mockDbFails = false;

jest.mock('../../config', () => ({
  config: {
    app: {
      nodeEnv: 'test',
      logLevel: 'silent',
    },
    trading: {
      mode: 'dryrun',
    },
    dryRun: {
      balance: 10000,
      leverage: 10,
      feeRate: 0.001,
      slippage: 0,
      restoreOpenPositions: true,
      strictRestore: false,
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
  db: {
    query: jest.fn(async (sql: string) => {
      if (sql.includes('FROM positions WHERE mode=$1')) {
        if (mockDbFails) throw new Error('db unavailable');
        return mockPositionRows;
      }
      return [];
    }),
  },
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
import { db } from '../../database/connection';
import { config } from '../../config';
import { DryRunExecutor, type VirtualWallet } from './dryRunExecutor';

const riskMock = riskManager as unknown as {
  assessSignal: jest.Mock;
  onPositionOpened: jest.Mock;
  onPositionClosed: jest.Mock;
};
const dbMock = db as unknown as { query: jest.Mock };

function makePositionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'restored-1',
    pair: 'BTCUSDT',
    direction: 'LONG',
    entry_price: 100,
    current_price: 100,
    quantity: 1,
    leverage: 10,
    margin: 10,
    unrealized_pnl: 0,
    realized_pnl: 0,
    stop_loss: 90,
    take_profit: 120,
    liquidation_price: 90,
    roe: 0,
    status: 'OPEN',
    opened_at: Date.now(),
    closed_at: null,
    mode: 'dryrun',
    signal_id: 'signal-restored',
    fees: 0.1,
    ...overrides,
  };
}

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
    mockPositionRows = [];
    mockDbFails = false;
    config.trading.mode = 'dryrun';
    config.dryRun.restoreOpenPositions = true;
    config.dryRun.strictRestore = false;
    dbMock.query.mockClear();
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

  it('restores one open dry-run position from DB on startup', async () => {
    mockRedisStore.set('dryrun:wallet', {
      balance: 9999.9,
      equity: 9999.9,
      usedMargin: 10,
      freeMargin: 9989.9,
      unrealizedPnl: 0,
      realizedPnl: 0,
      dailyPnl: 0,
      fees: 0.1,
    });
    mockPositionRows = [makePositionRow()];

    const executor = await createExecutor();
    const positions = executor.getOpenPositions();
    const wallet = executor.getWallet();

    expect(positions).toHaveLength(1);
    expect(positions[0]?.id).toBe('restored-1');
    expect(wallet.balance).toBeCloseTo(9999.9);
    expect(wallet.usedMargin).toBeCloseTo(10);
    expect(wallet.freeMargin).toBeCloseTo(9989.9);
  });

  it('restores multiple open dry-run positions and recalculates used margin', async () => {
    mockPositionRows = [
      makePositionRow({ id: 'restored-1', margin: 10 }),
      makePositionRow({ id: 'restored-2', pair: 'ETHUSDT', margin: 20, entry_price: 200, current_price: 200, stop_loss: 180, take_profit: 240, liquidation_price: 180 }),
    ];

    const executor = await createExecutor();
    const wallet = executor.getWallet();

    expect(executor.getOpenPositions()).toHaveLength(2);
    expect(wallet.usedMargin).toBeCloseTo(30);
    expect(wallet.freeMargin).toBeCloseTo(9970);
  });

  it('skips invalid restored position rows in non-strict mode', async () => {
    mockPositionRows = [
      makePositionRow({ id: 'valid-row' }),
      makePositionRow({ id: 'invalid-row', quantity: -1 }),
    ];

    const executor = await createExecutor();

    expect(executor.getOpenPositions()).toHaveLength(1);
    expect(executor.getOpenPositions()[0]?.id).toBe('valid-row');
  });

  it('closes a restored position without double-counting margin', async () => {
    mockRedisStore.set('dryrun:wallet', {
      balance: 9999.9,
      equity: 9999.9,
      usedMargin: 10,
      freeMargin: 9989.9,
      unrealizedPnl: 0,
      realizedPnl: 0,
      dailyPnl: 0,
      fees: 0.1,
    });
    mockPositionRows = [makePositionRow()];

    const executor = await createExecutor();
    await executor.closePosition('restored-1', 120, 'TP_HIT');
    const wallet = executor.getWallet();

    expect(executor.getOpenPositions()).toHaveLength(0);
    expect(wallet.balance).toBeCloseTo(10019.78);
    expect(wallet.usedMargin).toBe(0);
    expect(wallet.realizedPnl).toBeCloseTo(19.78);
    expect(wallet.fees).toBeCloseTo(0.22);
  });

  it('continues safely when DB restore fails and no margin is reserved', async () => {
    mockDbFails = true;

    const executor = await createExecutor();

    expect(executor.getOpenPositions()).toHaveLength(0);
    expect(executor.getWallet().usedMargin).toBe(0);
  });

  it('refuses initialization when DB restore fails with reserved wallet margin', async () => {
    mockDbFails = true;
    mockRedisStore.set('dryrun:wallet', {
      balance: 9999.9,
      equity: 9999.9,
      usedMargin: 10,
      freeMargin: 9989.9,
      unrealizedPnl: 0,
      realizedPnl: 0,
      dailyPnl: 0,
      fees: 0.1,
    });

    let rejected = false;
    try {
      await createExecutor();
    } catch {
      rejected = true;
    }

    expect(rejected).toBe(true);
  });
});
