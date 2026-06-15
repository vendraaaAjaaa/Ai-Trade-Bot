/**
 * =============================================
 * LIVE_CIRCUIT_BREAKER — Phase 9 Kill Switch
 * =============================================
 *
 * Trips live trading off after unrecoverable emergency-close failures.
 * If persisted state cannot be read, live trading fails closed.
 */

import { redis, CacheKeys } from '../../redis/client';
import { createLogger } from '../../utils/logger';
import type { TradeDirection, TradingPair } from '../../utils/types';

const log = createLogger('live-circuit-breaker');

export interface LiveCircuitBreakerState {
  active: boolean;
  reason: string;
  pair?: TradingPair;
  direction?: TradeDirection;
  quantity?: number;
  exchangeOrderId?: string;
  timestamp: number;
  lastErrorMessage?: string;
  resetReason?: string;
  resetAt?: number;
}

export interface LiveCircuitBreakerTripInput {
  reason: string;
  pair: TradingPair;
  direction: TradeDirection;
  quantity: number;
  exchangeOrderId?: string;
  lastErrorMessage?: string;
}

export class LiveCircuitBreaker {
  private localState: LiveCircuitBreakerState | null = null;

  async getState(): Promise<LiveCircuitBreakerState> {
    try {
      const persisted = await redis.getJson<LiveCircuitBreakerState>(CacheKeys.liveCircuitBreaker());
      if (this.localState?.active && (!persisted || !persisted.active)) {
        return this.localState;
      }

      if (persisted) {
        this.localState = persisted;
        return persisted;
      }

      const inactive = this.inactiveState();
      this.localState = inactive;
      return inactive;
    } catch (err) {
      log.error({ err }, 'Live circuit breaker state unavailable; failing closed');
      return this.failClosedState('Circuit breaker persistence unavailable');
    }
  }

  async assertCanTrade(): Promise<{ allowed: boolean; state: LiveCircuitBreakerState }> {
    const state = await this.getState();
    return { allowed: !state.active, state };
  }

  async trip(input: LiveCircuitBreakerTripInput): Promise<LiveCircuitBreakerState> {
    const state: LiveCircuitBreakerState = {
      active: true,
      reason: input.reason,
      pair: input.pair,
      direction: input.direction,
      quantity: input.quantity,
      exchangeOrderId: input.exchangeOrderId,
      timestamp: Date.now(),
      lastErrorMessage: input.lastErrorMessage,
    };

    this.localState = state;
    try {
      await redis.setJson(CacheKeys.liveCircuitBreaker(), state);
    } catch (err) {
      log.error({ err, state }, 'Failed to persist live circuit breaker trip; local fail-closed state retained');
    }

    log.error({ state }, 'CRITICAL: Live circuit breaker tripped');
    return state;
  }

  async reset(reason: string): Promise<LiveCircuitBreakerState> {
    const trimmed = reason.trim();
    if (trimmed.length < 8) {
      throw new Error('Circuit breaker reset requires a reason of at least 8 characters');
    }

    const state: LiveCircuitBreakerState = {
      active: false,
      reason: 'Manual reset',
      timestamp: Date.now(),
      resetReason: trimmed,
      resetAt: Date.now(),
    };

    await redis.setJson(CacheKeys.liveCircuitBreaker(), state);
    this.localState = state;
    log.warn({ resetReason: trimmed }, 'Live circuit breaker reset manually');
    return state;
  }

  private failClosedState(reason: string): LiveCircuitBreakerState {
    if (this.localState?.active) return this.localState;

    this.localState = {
      active: true,
      reason,
      timestamp: Date.now(),
      lastErrorMessage: reason,
    };
    return this.localState;
  }

  private inactiveState(): LiveCircuitBreakerState {
    return {
      active: false,
      reason: 'Live trading circuit breaker clear',
      timestamp: Date.now(),
    };
  }
}

export const liveCircuitBreaker = new LiveCircuitBreaker();
