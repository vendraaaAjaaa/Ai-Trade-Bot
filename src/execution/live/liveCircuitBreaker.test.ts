let persistedState: unknown = null;
let getFails = false;
let setFails = false;

jest.mock('../../config', () => ({
  config: {
    app: { nodeEnv: 'test', logLevel: 'silent' },
    redis: { host: 'localhost', port: 6379, db: 0 },
  },
}));

jest.mock('../../redis/client', () => ({
  redis: {
    getJson: jest.fn(async () => {
      if (getFails) throw new Error('redis get failed');
      return persistedState;
    }),
    setJson: jest.fn(async (_key: string, value: unknown) => {
      if (setFails) throw new Error('redis set failed');
      persistedState = value;
    }),
  },
  CacheKeys: {
    liveCircuitBreaker: () => 'live:circuit_breaker',
  },
}));

import { LiveCircuitBreaker } from './liveCircuitBreaker';

describe('LiveCircuitBreaker', () => {
  beforeEach(() => {
    persistedState = null;
    getFails = false;
    setFails = false;
  });

  it('trips and persists active circuit breaker state', async () => {
    const breaker = new LiveCircuitBreaker();

    const state = await breaker.trip({
      reason: 'emergency failed',
      pair: 'BTCUSDT',
      direction: 'LONG',
      quantity: 0.1,
      exchangeOrderId: '123',
      lastErrorMessage: 'close rejected',
    });

    expect(state.active).toBe(true);
    expect((persistedState as { active: boolean }).active).toBe(true);
  });

  it('reports active persisted state as not allowed to trade', async () => {
    persistedState = {
      active: true,
      reason: 'manual inspection required',
      timestamp: Date.now(),
    };
    const breaker = new LiveCircuitBreaker();

    const result = await breaker.assertCanTrade();

    expect(result.allowed).toBe(false);
    expect(result.state.reason).toBe('manual inspection required');
  });

  it('resets with an auditable reason', async () => {
    persistedState = {
      active: true,
      reason: 'manual inspection required',
      timestamp: Date.now(),
    };
    const breaker = new LiveCircuitBreaker();

    const state = await breaker.reset('operator inspected exchange account');

    expect(state.active).toBe(false);
    expect(state.resetReason).toBe('operator inspected exchange account');
    expect((persistedState as { active: boolean }).active).toBe(false);
  });

  it('keeps trading disabled when reset persistence fails', async () => {
    persistedState = {
      active: true,
      reason: 'manual inspection required',
      timestamp: Date.now(),
    };
    const breaker = new LiveCircuitBreaker();
    await breaker.assertCanTrade();

    setFails = true;
    let rejected = false;
    try {
      await breaker.reset('operator inspected exchange account');
    } catch {
      rejected = true;
    }
    setFails = false;

    const result = await breaker.assertCanTrade();
    expect(rejected).toBe(true);
    expect(result.allowed).toBe(false);
    expect(result.state.active).toBe(true);
  });

  it('fails closed when persisted state cannot be read', async () => {
    getFails = true;
    const breaker = new LiveCircuitBreaker();

    const result = await breaker.assertCanTrade();

    expect(result.allowed).toBe(false);
    expect(result.state.active).toBe(true);
    expect(result.state.reason).toMatch(/persistence unavailable/);
  });

  it('retains local fail-closed state when trip persistence fails', async () => {
    setFails = true;
    const breaker = new LiveCircuitBreaker();

    await breaker.trip({
      reason: 'emergency failed',
      pair: 'BTCUSDT',
      direction: 'LONG',
      quantity: 0.1,
    });
    const result = await breaker.assertCanTrade();

    expect(result.allowed).toBe(false);
    expect(result.state.active).toBe(true);
  });

  it('does not let stale inactive persistence override a locally tripped breaker', async () => {
    persistedState = {
      active: false,
      reason: 'Live trading circuit breaker clear',
      timestamp: Date.now(),
    };
    setFails = true;
    const breaker = new LiveCircuitBreaker();

    await breaker.trip({
      reason: 'emergency failed',
      pair: 'BTCUSDT',
      direction: 'LONG',
      quantity: 0.1,
    });
    setFails = false;
    const result = await breaker.assertCanTrade();

    expect(result.allowed).toBe(false);
    expect(result.state.reason).toBe('emergency failed');
  });
});
