import type { StrategyMode, FrequencyState, LossStreakState, SystemStatus } from '../utils/types2';
import { redis } from '../redis/client';
import { createLogger } from '../utils/logger';

const log = createLogger('frequency');
const FREQ_KEY = 'frequency:state';
const STREAK_KEY = 'streak:state';
const STATUS_KEY = 'system:status';

const MAX_TRADES_PER_MODE: Record<StrategyMode, number> = {
  scalping: 5, swing: 2, investing: 1, safe: 1, aggressive: 8,
};

const LOSS_STREAK_THRESHOLD = 3;
const COOLDOWN_HOURS = 1.5;

export class FrequencyLimiter {

  async canTrade(mode: StrategyMode): Promise<{ allowed: boolean; reason: string }> {
    const [freq, streak, status] = await Promise.all([
      this.getFrequencyState(mode),
      this.getLossStreakState(),
      this.getSystemStatus(),
    ]);

    if (status === 'disabled') {
      return { allowed: false, reason: 'System is disabled' };
    }

    if (status === 'cooldown' || streak.inCooldown) {
      const remaining = Math.ceil((streak.cooldownUntil - Date.now()) / 60000);
      if (Date.now() < streak.cooldownUntil) {
        return { allowed: false, reason: `Loss streak cooldown — ${remaining}min remaining. Reason: ${streak.cooldownReason}` };
      }
      // Cooldown expired
      await this.exitCooldown();
    }

    if (status === 'observation') {
      return { allowed: false, reason: 'System in observation mode — reassessing market conditions' };
    }

    if (freq.isLimited) {
      return { allowed: false, reason: `Daily trade limit reached: ${freq.tradesToday}/${freq.maxTradesDay} for ${mode} mode` };
    }

    // Selectivity increases after each trade (become progressively more conservative)
    const tradesPct = freq.tradesToday / freq.maxTradesDay;
    if (tradesPct >= 0.8 && mode !== 'aggressive') {
      return { allowed: false, reason: `Near daily limit (${freq.tradesToday}/${freq.maxTradesDay}) — being extra selective` };
    }

    return { allowed: true, reason: `${freq.remainingToday} trades remaining today` };
  }

  async recordTrade(): Promise<void> {
    const state = await this.loadFrequencyState();
    state.tradesToday++;
    state.lastTradeTime = Date.now();
    await redis.setJson(FREQ_KEY, state, 86400);
  }

  async recordLoss(): Promise<void> {
    const state = await this.loadStreakState();
    state.consecutiveLosses++;
    state.lastLossTime = Date.now();

    if (state.consecutiveLosses >= LOSS_STREAK_THRESHOLD) {
      state.inCooldown = true;
      state.cooldownUntil = Date.now() + COOLDOWN_HOURS * 60 * 60 * 1000;
      state.cooldownReason = `${state.consecutiveLosses} consecutive losses — enforcing cooldown`;
      state.observationMode = true;
      await this.setSystemStatus('cooldown');

      log.warn({
        consecutiveLosses: state.consecutiveLosses,
        cooldownUntil: new Date(state.cooldownUntil).toISOString(),
      }, 'LOSS STREAK: Entering cooldown mode');
    }

    await redis.setJson(STREAK_KEY, state, 86400);
  }

  async recordWin(): Promise<void> {
    const state = await this.loadStreakState();
    state.consecutiveLosses = 0; // Reset on win
    await redis.setJson(STREAK_KEY, state, 86400);
  }

  async getFrequencyState(mode: StrategyMode): Promise<FrequencyState> {
    const state = await this.loadFrequencyState();
    const maxTradesDay = MAX_TRADES_PER_MODE[mode];
    const isLimited = state.tradesToday >= maxTradesDay;
    return {
      ...state,
      maxTradesDay,
      isLimited,
      remainingToday: Math.max(0, maxTradesDay - state.tradesToday),
    };
  }

  async getLossStreakState(): Promise<LossStreakState> {
    return this.loadStreakState();
  }

  async getSystemStatus(): Promise<SystemStatus> {
    const status = await redis.get(STATUS_KEY);
    return (status as SystemStatus) ?? 'trading';
  }

  async setSystemStatus(status: SystemStatus): Promise<void> {
    await redis.set(STATUS_KEY, status, 86400);
    log.info({ status }, 'System status changed');
  }

  async exitCooldown(): Promise<void> {
    const state = await this.loadStreakState();
    state.inCooldown = false;
    state.observationMode = false;
    state.cooldownReason = '';
    await redis.setJson(STREAK_KEY, state, 86400);
    await this.setSystemStatus('trading');
    log.info('Cooldown lifted — resuming trading');
  }

  private async loadFrequencyState(): Promise<Omit<FrequencyState, 'maxTradesDay' | 'isLimited' | 'remainingToday'>> {
    const saved = await redis.getJson<FrequencyState>(FREQ_KEY);
    // Reset if it's a new day
    if (saved && this.isToday(saved.lastTradeTime || 0)) {
      return { tradesToday: saved.tradesToday, lastTradeTime: saved.lastTradeTime, minIntervalMinutes: 5 };
    }
    return { tradesToday: 0, lastTradeTime: 0, minIntervalMinutes: 5 };
  }

  private async loadStreakState(): Promise<LossStreakState> {
    const saved = await redis.getJson<LossStreakState>(STREAK_KEY);
    return saved ?? {
      consecutiveLosses: 0, inCooldown: false, cooldownUntil: 0,
      cooldownReason: '', observationMode: false, lastLossTime: 0,
    };
  }

  private isToday(timestamp: number): boolean {
    const stored = new Date(timestamp);
    const now = new Date();
    return stored.getUTCFullYear() === now.getUTCFullYear()
      && stored.getUTCMonth() === now.getUTCMonth()
      && stored.getUTCDate() === now.getUTCDate();
  }
}

export const frequencyLimiter = new FrequencyLimiter();
