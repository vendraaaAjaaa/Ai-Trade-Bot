import type { StrategyMode, StrategyConfig, MarketRegime, SessionName } from '../utils/types2';
import { redis } from '../redis/client';
import { createLogger } from '../utils/logger';

const log = createLogger('strategy');
const MODE_KEY = 'strategy:mode';

const STRATEGY_CONFIGS: Record<StrategyMode, StrategyConfig> = {
  scalping: {
    mode: 'scalping',
    maxTradesPerDay: 5,
    minConfidence: 72,
    minRR: 1.5,
    maxLeverage: 15,
    minConsensusScore: 60,
    minMarketQuality: 65,
    allowedRegimes: ['trending_up', 'trending_down', 'high_volatility'],
    allowedSessions: ['london', 'new_york', 'overlap'],
    description: 'Fast execution, momentum-based, strict confirmation, low hold time',
  },
  swing: {
    mode: 'swing',
    maxTradesPerDay: 5,
    minConfidence: 75,
    minRR: 2.0,
    maxLeverage: 10,
    minConsensusScore: 65,
    minMarketQuality: 70,
    allowedRegimes: ['trending_up', 'trending_down', 'ranging'],
    allowedSessions: ['london', 'new_york', 'overlap', 'asia'],
    description: 'Patient entries, trend continuation, higher RR, institutional focus',
  },
  investing: {
    mode: 'investing',
    maxTradesPerDay: 1,
    minConfidence: 70,
    minRR: 2.5,
    maxLeverage: 3,
    minConsensusScore: 60,
    minMarketQuality: 65,
    allowedRegimes: ['trending_up', 'trending_down', 'ranging'],
    allowedSessions: ['london', 'new_york', 'overlap', 'asia', 'dead'],
    description: 'Long-term accumulation, spot trading, whale tracking, DCA',
  },
  safe: {
    mode: 'safe',
    maxTradesPerDay: 1,
    minConfidence: 90,
    minRR: 2.5,
    maxLeverage: 5,
    minConsensusScore: 80,
    minMarketQuality: 80,
    allowedRegimes: ['trending_up', 'trending_down'],
    allowedSessions: ['london', 'new_york', 'overlap'],
    description: 'Ultra-conservative, only perfect setups, maximum capital preservation',
  },
  aggressive: {
    mode: 'aggressive',
    maxTradesPerDay: 8,
    minConfidence: 60,
    minRR: 1.2,
    maxLeverage: 20,
    minConsensusScore: 50,
    minMarketQuality: 50,
    allowedRegimes: ['trending_up', 'trending_down', 'ranging', 'high_volatility'],
    allowedSessions: ['london', 'new_york', 'overlap', 'asia'],
    description: 'Experimental mode, higher frequency, lower threshold — use with caution',
  },
};

export class StrategyModeManager {
  private currentMode: StrategyMode = 'swing';

  async initialize(): Promise<void> {
    const saved = await redis.get(MODE_KEY);
    if (saved && saved in STRATEGY_CONFIGS) {
      this.currentMode = saved as StrategyMode;
    }
    log.info({ mode: this.currentMode }, 'Strategy mode initialized');
  }

  async setMode(mode: StrategyMode): Promise<void> {
    this.currentMode = mode;
    await redis.set(MODE_KEY, mode);
    log.info({ mode }, 'Strategy mode changed');
  }

  getMode(): StrategyMode {
    return this.currentMode;
  }

  getConfig(): StrategyConfig {
    return STRATEGY_CONFIGS[this.currentMode];
  }

  getConfigFor(mode: StrategyMode): StrategyConfig {
    return STRATEGY_CONFIGS[mode];
  }

  isRegimeAllowed(regime: MarketRegime): boolean {
    return this.getConfig().allowedRegimes.includes(regime);
  }

  isSessionAllowed(session: SessionName): boolean {
    return this.getConfig().allowedSessions.includes(session);
  }

  getLeverage(): number {
    return this.getConfig().maxLeverage;
  }

  getAllModes(): StrategyConfig[] {
    return Object.values(STRATEGY_CONFIGS);
  }
}

export const strategyManager = new StrategyModeManager();
