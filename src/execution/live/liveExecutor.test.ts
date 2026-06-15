import type { TradingSignal } from '../../utils/types';

jest.mock('../../config', () => ({
  config: {
    app: {
      nodeEnv: 'test',
      logLevel: 'silent',
    },
    trading: { mode: 'live' },
    telegram: { botToken: '', chatId: '' },
    binance: {
      testnet: true,
      testnetFuturesUrl: 'https://testnet.binancefuture.com',
      futuresBaseUrl: 'https://fapi.binance.com',
      apiKey: 'valid_key',
      apiSecret: 'valid_secret',
    },
  },
}));

jest.mock('../../redis/client', () => ({
  redis: {
    getJson: jest.fn().mockResolvedValue(null),
    setJson: jest.fn().mockResolvedValue(undefined),
  },
  CacheKeys: {
    liveCircuitBreaker: () => 'live:circuit_breaker',
  },
}));

jest.mock('../../risk/riskManager', () => ({
  riskManager: {
    assessSignal: jest.fn(),
    onPositionOpened: jest.fn(),
  },
}));

jest.mock('../../database/connection', () => ({
  db: { query: jest.fn().mockResolvedValue([]) },
}));

jest.mock('../../alerts/operatorAlert', () => ({
  operatorAlertService: {
    sendEmergencyCloseFailed: jest.fn().mockResolvedValue(undefined),
  },
}));

import { BinanceFilterService, type SymbolFilters } from '../../exchange/binanceFilters';
import { LiveExecutor, type LiveExecutorOptions } from './liveExecutor';

const filters: SymbolFilters = {
  symbol: 'BTCUSDT',
  priceFilter: { minPrice: '0.10', maxPrice: '1000000', tickSize: '0.10' },
  lotSize: { minQty: '0.001', maxQty: '1000', stepSize: '0.001' },
  marketLotSize: { minQty: '0.001', maxQty: '1000', stepSize: '0.001' },
  minNotional: '100',
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
    entry: 65000,
    stopLoss: 64000,
    takeProfit: 68000,
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
      atr: 100,
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

function makeRisk() {
  return {
    assessSignal: jest.fn().mockResolvedValue({
      isAllowed: true,
      positionSize: 0.123456,
      riskAmount: 100,
      leverage: 5,
      stopLossDistance: 0.01,
      riskReward: 2,
      currentDrawdown: 0,
      dailyLoss: 0,
      openPositions: 0,
      warnings: [],
    }),
    onPositionOpened: jest.fn().mockResolvedValue(undefined),
  };
}

describe('LiveExecutor protective order handling and fill reconciliation', () => {
  function buildExecutor(options: {
    failStop?: boolean;
    failTakeProfit?: boolean;
    failEmergency?: boolean;
    activeBreaker?: boolean;
    alertFails?: boolean;
    marketOrderResponse?: Record<string, unknown>;
    queryOrderResponse?: Record<string, unknown>;
  } = {}) {
    const calls: Array<{ method: string; endpoint: string; params: Record<string, string> }> = [];
    const signedRequest = jest.fn(async (method: string, endpoint: string, params: Record<string, string>) => {
      calls.push({ method, endpoint, params });

      if (endpoint === '/fapi/v1/order' && method === 'GET') {
        return options.queryOrderResponse ?? { orderId: 123, status: 'FILLED', avgPrice: '65000', executedQty: '0.123' };
      }

      if (endpoint === '/fapi/v1/order' && params.type === 'STOP_MARKET' && options.failStop) {
        throw new Error('stop failed');
      }

      if (endpoint === '/fapi/v1/order' && params.type === 'TAKE_PROFIT_MARKET' && options.failTakeProfit) {
        throw new Error('tp failed');
      }

      if (endpoint === '/fapi/v1/order' && params.type === 'MARKET' && params.reduceOnly === 'true' && options.failEmergency) {
        throw new Error('emergency close failed');
      }

      if (endpoint === '/fapi/v1/order' && params.type === 'MARKET') {
        return options.marketOrderResponse ?? { orderId: 123, status: 'FILLED', avgPrice: '65000', executedQty: '0.123' };
      }

      return { orderId: 456 };
    });

    const risk = makeRisk();
    const persistPosition = jest.fn().mockResolvedValue(undefined);
    const circuitBreaker = {
      assertCanTrade: jest.fn().mockResolvedValue({
        allowed: !options.activeBreaker,
        state: {
          active: Boolean(options.activeBreaker),
          reason: options.activeBreaker ? 'manual inspection required' : 'clear',
          timestamp: Date.now(),
        },
      }),
      trip: jest.fn().mockResolvedValue({
        active: true,
        reason: 'emergency failed',
        timestamp: 123456,
      }),
    };
    const alertService = {
      sendEmergencyCloseFailed: jest.fn(async () => {
        if (options.alertFails) throw new Error('telegram down');
      }),
    };

    const executor = new LiveExecutor({
      filterService: new BinanceFilterService(async () => filters),
      signedRequest,
      risk: risk as unknown as LiveExecutorOptions['risk'],
      persistPosition: persistPosition as unknown as LiveExecutorOptions['persistPosition'],
      circuitBreaker: circuitBreaker as unknown as LiveExecutorOptions['circuitBreaker'],
      alertService,
    });

    return { executor, calls, risk, persistPosition, circuitBreaker, alertService };
  }

  it('returns EXECUTED_WITH_PROTECTION after market order and SL/TP succeed', async () => {
    const { executor, calls, risk, persistPosition } = buildExecutor();

    const result = await executor.executeSignal(makeSignal(), 10000);

    expect(result.status).toBe('EXECUTED_WITH_PROTECTION');
    expect(result.position?.quantity).toBe(0.123);
    expect(result.position?.entryPrice).toBe(65000);
    expect(persistPosition).toHaveBeenCalledTimes(1);
    expect(risk.onPositionOpened).toHaveBeenCalledTimes(1);
    expect(calls.filter((call) => call.endpoint === '/fapi/v1/order')).toHaveLength(3);
    expect(calls[1]?.params.quantity).toBe('0.123');
    expect(calls[2]?.params.reduceOnly).toBe('true');
    expect(calls[3]?.params.reduceOnly).toBe('true');
  });

  it('computes average fill price from cumQuote and executedQty', async () => {
    const { executor } = buildExecutor({
      marketOrderResponse: { orderId: 123, status: 'FILLED', executedQty: '0.123', cumQuote: '7995' },
    });

    const result = await executor.executeSignal(makeSignal(), 10000);

    expect(result.status).toBe('EXECUTED_WITH_PROTECTION');
    expect(result.position?.entryPrice).toBe(65000);
  });

  it('queries order status when immediate market response lacks fill data', async () => {
    const { executor, calls } = buildExecutor({
      marketOrderResponse: { orderId: 123, status: 'NEW' },
      queryOrderResponse: { orderId: 123, status: 'FILLED', avgPrice: '65010', executedQty: '0.122' },
    });

    const result = await executor.executeSignal(makeSignal(), 10000);

    expect(result.status).toBe('EXECUTED_WITH_PROTECTION');
    expect(result.position?.entryPrice).toBe(65010);
    expect(result.position?.quantity).toBe(0.122);
    expect(calls.some((call) => call.method === 'GET' && call.endpoint === '/fapi/v1/order')).toBe(true);
  });

  it('emergency closes when fill reconciliation fails after market order', async () => {
    const { executor, calls, persistPosition } = buildExecutor({
      marketOrderResponse: { orderId: 123, status: 'NEW' },
      queryOrderResponse: { orderId: 123, status: 'NEW' },
    });

    const result = await executor.executeSignal(makeSignal(), 10000);

    expect(result.status).toBe('EXECUTION_FAILED');
    expect(result.reason).toMatch(/Fill reconciliation failed/);
    expect(persistPosition).not.toHaveBeenCalled();
    expect(calls.some((call) => call.params.reduceOnly === 'true' && call.params.type === 'MARKET')).toBe(true);
  });

  it('emergency closes when stop-loss order creation fails', async () => {
    const { executor, calls, risk, persistPosition } = buildExecutor({ failStop: true });

    const result = await executor.executeSignal(makeSignal(), 10000);

    expect(result.status).toBe('PROTECTION_FAILED_POSITION_CLOSED');
    expect(result.position).toBeNull();
    expect(persistPosition).not.toHaveBeenCalled();
    expect(risk.onPositionOpened).not.toHaveBeenCalled();
    expect(calls.some((call) => call.params.reduceOnly === 'true' && call.params.type === 'MARKET')).toBe(true);
    expect(calls.some((call) => call.method === 'DELETE' && call.endpoint === '/fapi/v1/allOpenOrders')).toBe(true);
  });

  it('emergency closes and cancels orphan orders when take-profit creation fails', async () => {
    const { executor, calls } = buildExecutor({ failTakeProfit: true });

    const result = await executor.executeSignal(makeSignal(), 10000);

    expect(result.status).toBe('PROTECTION_FAILED_POSITION_CLOSED');
    expect(calls.some((call) => call.params.type === 'STOP_MARKET')).toBe(true);
    expect(calls.some((call) => call.params.reduceOnly === 'true' && call.params.type === 'MARKET')).toBe(true);
    expect(calls.some((call) => call.method === 'DELETE' && call.endpoint === '/fapi/v1/allOpenOrders')).toBe(true);
  });

  it('trips the circuit breaker and sends one alert when emergency close fails', async () => {
    const { executor, calls, risk, persistPosition, circuitBreaker, alertService } = buildExecutor({ failStop: true, failEmergency: true });

    const result = await executor.executeSignal(makeSignal(), 10000);

    expect(result.status).toBe('EMERGENCY_CLOSE_FAILED');
    expect(result.position).toBeNull();
    expect(persistPosition).not.toHaveBeenCalled();
    expect(risk.onPositionOpened).not.toHaveBeenCalled();
    expect(circuitBreaker.trip).toHaveBeenCalledTimes(1);
    expect(alertService.sendEmergencyCloseFailed).toHaveBeenCalledTimes(1);
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
  });

  it('keeps EMERGENCY_CLOSE_FAILED when the urgent alert fails', async () => {
    const { executor, circuitBreaker, alertService } = buildExecutor({ failStop: true, failEmergency: true, alertFails: true });

    const result = await executor.executeSignal(makeSignal(), 10000);

    expect(result.status).toBe('EMERGENCY_CLOSE_FAILED');
    expect(circuitBreaker.trip).toHaveBeenCalledTimes(1);
    expect(alertService.sendEmergencyCloseFailed).toHaveBeenCalledTimes(1);
  });

  it('rejects new live trades while the circuit breaker is active', async () => {
    const { executor, risk } = buildExecutor({ activeBreaker: true });

    const result = await executor.executeSignal(makeSignal(), 10000);

    expect(result.status).toBe('EXECUTION_FAILED');
    expect(result.reason).toMatch(/circuit breaker active/);
    expect(risk.assessSignal).not.toHaveBeenCalled();
  });

  it('trips breaker if fill reconciliation and emergency close both fail', async () => {
    const { executor, circuitBreaker, alertService } = buildExecutor({
      failEmergency: true,
      marketOrderResponse: { orderId: 123, status: 'NEW' },
      queryOrderResponse: { orderId: 123, status: 'NEW' },
    });

    const result = await executor.executeSignal(makeSignal(), 10000);

    expect(result.status).toBe('EMERGENCY_CLOSE_FAILED');
    expect(circuitBreaker.trip).toHaveBeenCalledTimes(1);
    expect(alertService.sendEmergencyCloseFailed).toHaveBeenCalledTimes(1);
  });
});
