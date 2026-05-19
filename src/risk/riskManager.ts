import { config } from '../config';
import { createLogger } from '../utils/logger';
import { redis, CacheKeys } from '../redis/client';
import { db } from '../database/connection';
import type { TradingSignal, RiskAssessment, Position } from '../utils/types';

const log = createLogger('risk');

interface RiskState {
  dailyPnl: number;
  dailyLossCount: number;
  openPositions: number;
  lastLossTime: number;
  lastUpdated: number;
}

export class RiskManager {
  private state: RiskState = {
    dailyPnl: 0,
    dailyLossCount: 0,
    openPositions: 0,
    lastLossTime: 0,
    lastUpdated: 0,
  };

  async loadState(): Promise<void> {
    const cached = await redis.getJson<RiskState>(CacheKeys.riskState());
    if (cached && this.isSameDay(cached.lastUpdated)) {
      this.state = cached;
    } else {
      await this.resetDailyState();
    }
  }

  async assessSignal(signal: TradingSignal, balance: number): Promise<RiskAssessment> {
    await this.loadState();
    const warnings: string[] = [];

    // ---- Max daily loss check ----
    const maxDailyLoss = balance * (config.risk.maxDailyLossPercent / 100);
    const currentDailyLoss = Math.abs(Math.min(this.state.dailyPnl, 0));
    if (currentDailyLoss >= maxDailyLoss) {
      return this.reject(`Daily loss limit reached ($${currentDailyLoss.toFixed(2)} / $${maxDailyLoss.toFixed(2)})`, balance, signal);
    }

    // ---- Max open positions ----
    if (this.state.openPositions >= config.risk.maxOpenPositions) {
      return this.reject(`Max open positions reached (${this.state.openPositions}/${config.risk.maxOpenPositions})`, balance, signal);
    }

    // ---- Cooldown after loss ----
    const cooldownMs = config.risk.cooldownAfterLossMinutes * 60 * 1000;
    if (this.state.lastLossTime > 0 && Date.now() - this.state.lastLossTime < cooldownMs) {
      const remainMin = Math.ceil((cooldownMs - (Date.now() - this.state.lastLossTime)) / 60000);
      return this.reject(`Cooldown active after loss. ${remainMin}min remaining.`, balance, signal);
    }

    // ---- Volatility check ----
    const atr = signal.indicators.atr;
    const priceVolatility = atr / signal.entry;
    if (priceVolatility > config.risk.volatilityThreshold) {
      warnings.push(`High volatility detected (ATR/Price: ${(priceVolatility * 100).toFixed(2)}%)`);
    }

    // ---- RR check ----
    if (signal.riskReward < config.risk.riskRewardMin) {
      return this.reject(
        `RR ${signal.riskReward.toFixed(2)} below minimum ${config.risk.riskRewardMin}`,
        balance,
        signal,
      );
    }

    // ---- Confidence check ----
    if (signal.confidence < config.signals.minConfidenceScore) {
      return this.reject(
        `Confidence ${signal.confidence}% below minimum ${config.signals.minConfidenceScore}%`,
        balance,
        signal,
      );
    }

    // ---- Position sizing (Kelly-adjusted, max 10% balance) ----
    const slDistance = Math.abs(signal.stopLoss - signal.entry) / signal.entry;
    const maxRiskAmount = balance * (config.risk.maxPositionSizePercent / 100);
    const riskPerUnit = slDistance * signal.entry;
    const rawQuantity = riskPerUnit > 0 ? maxRiskAmount / (riskPerUnit) : 0;
    const positionSize = Math.min(rawQuantity, balance * 0.1 / signal.entry);

    // ---- Spread check ----
    const leverage = Math.min(config.risk.defaultLeverage, config.risk.maxLeverage);

    log.info({
      pair: signal.pair,
      direction: signal.direction,
      confidence: signal.confidence,
      rr: signal.riskReward,
      positionSize: positionSize.toFixed(6),
    }, 'Risk assessment passed');

    return {
      isAllowed: true,
      positionSize,
      riskAmount: positionSize * riskPerUnit,
      leverage,
      stopLossDistance: slDistance,
      riskReward: signal.riskReward,
      currentDrawdown: currentDailyLoss,
      dailyLoss: this.state.dailyPnl,
      openPositions: this.state.openPositions,
      warnings,
    };
  }

  async onPositionOpened(): Promise<void> {
    this.state.openPositions++;
    await this.saveState();
  }

  async onPositionClosed(pnl: number): Promise<void> {
    this.state.openPositions = Math.max(0, this.state.openPositions - 1);
    this.state.dailyPnl += pnl;
    if (pnl < 0) {
      this.state.dailyLossCount++;
      this.state.lastLossTime = Date.now();
    }
    await this.saveState();
    await this.logRiskEvent(pnl < 0 ? 'position_loss' : 'position_win', pnl);
  }

  async getCurrentState(): Promise<RiskState> {
    await this.loadState();
    return { ...this.state };
  }

  private reject(reason: string, balance: number, signal: TradingSignal): RiskAssessment {
    log.warn({ reason, pair: signal.pair }, 'Trade rejected by risk manager');
    return {
      isAllowed: false,
      reason,
      positionSize: 0,
      riskAmount: 0,
      leverage: 0,
      stopLossDistance: 0,
      riskReward: signal.riskReward,
      currentDrawdown: 0,
      dailyLoss: this.state.dailyPnl,
      openPositions: this.state.openPositions,
      warnings: [reason],
    };
  }

  private async resetDailyState(): Promise<void> {
    this.state = {
      dailyPnl: 0,
      dailyLossCount: 0,
      openPositions: await this.countOpenPositions(),
      lastLossTime: 0,
      lastUpdated: Date.now(),
    };
    await this.saveState();
  }

  private async saveState(): Promise<void> {
    this.state.lastUpdated = Date.now();
    await redis.setJson(CacheKeys.riskState(), this.state, 86400);
  }

  private isSameDay(timestamp: number): boolean {
    const today = new Date();
    const stored = new Date(timestamp);
    return today.getUTCFullYear() === stored.getUTCFullYear()
      && today.getUTCMonth() === stored.getUTCMonth()
      && today.getUTCDate() === stored.getUTCDate();
  }

  private async countOpenPositions(): Promise<number> {
    const rows = await db.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM positions WHERE status='OPEN'`,
    );
    return parseInt(rows[0]?.count ?? '0');
  }

  private async logRiskEvent(type: string, pnl: number): Promise<void> {
    await db.query(
      `INSERT INTO risk_events (event_type, severity, description, metadata) VALUES ($1,$2,$3,$4)`,
      [
        type,
        pnl < -100 ? 'high' : 'medium',
        `Position closed with PnL: $${pnl.toFixed(2)}`,
        JSON.stringify({ pnl, dailyPnl: this.state.dailyPnl }),
      ],
    ).catch(() => {});
  }
}

export const riskManager = new RiskManager();
