import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../../config';
import { createLogger } from '../../utils/logger';
import { redis, CacheKeys } from '../../redis/client';
import { db } from '../../database/connection';
import { riskManager } from '../../risk/riskManager';
import { selfReviewEngine } from '../../review/selfReviewEngine';
import { frequencyLimiter } from '../../strategy/frequencyLimiter';
import { sessionFilter } from '../../session/sessionFilter';
import { marketRegimeEngine } from '../../regime/marketRegimeEngine';
import type { TradingSignal, Position, RiskAssessment, TradingPair } from '../../utils/types';
import type { ExecutionQuality, MarketRegime, SessionName } from '../../utils/types2';

const log = createLogger('dryrun-v2');

interface PositionRow {
  id: string;
  pair: string;
  direction: string;
  entry_price: string | number;
  current_price: string | number;
  quantity: string | number;
  leverage: string | number;
  margin: string | number;
  unrealized_pnl: string | number | null;
  realized_pnl: string | number | null;
  stop_loss: string | number;
  take_profit: string | number;
  liquidation_price: string | number;
  roe: string | number | null;
  status: string;
  opened_at: string | number | Date;
  closed_at?: string | number | Date | null;
  mode: string;
  signal_id: string | null;
  fees: string | number | null;
}

export interface VirtualWallet {
  balance: number;
  equity: number;
  usedMargin: number;
  freeMargin: number;
  unrealizedPnl: number;
  realizedPnl: number;
  dailyPnl: number;
  fees: number;
}

export class DryRunExecutor extends EventEmitter {
  private wallet: VirtualWallet;
  private openPositions = new Map<string, Position>();
  private positionRegimes = new Map<string, string>();
  private positionSessions = new Map<string, string>();
  private initPromise: Promise<void>;
  private initialized = false;

  constructor() {
    super();
    this.wallet = this.defaultWallet();
    this.initPromise = this.initializeState()
      .then(() => {
        this.recalculateWallet();
        this.initialized = true;
      });
  }

  async init(): Promise<void> {
    await this.initPromise;
  }

  private defaultWallet(): VirtualWallet {
    return {
      balance: config.dryRun.balance,
      equity: config.dryRun.balance,
      usedMargin: 0,
      freeMargin: config.dryRun.balance,
      unrealizedPnl: 0,
      realizedPnl: 0,
      dailyPnl: 0,
      fees: 0,
    };
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) await this.initPromise;
  }

  private async initializeState(): Promise<void> {
    await this.loadWallet()
      .catch((err: unknown) => log.warn({ err }, 'DryRun: Failed to load wallet; using configured dry-run balance'));

    if (!config.dryRun.restoreOpenPositions || config.trading.mode === 'live') return;

    try {
      await this.restoreOpenPositionsFromDb();
    } catch (err) {
      log.warn({ err }, 'DryRun: Failed to restore open positions from DB');
      if (config.dryRun.strictRestore || this.wallet.usedMargin > 0) {
        throw err;
      }
    }
  }

  private async loadWallet(): Promise<void> {
    const cached = await redis.getJson<VirtualWallet>(CacheKeys.dryRunWallet());
    if (cached) this.wallet = this.normalizeWallet(cached);
  }

  private async restoreOpenPositionsFromDb(): Promise<void> {
    const rows = await db.query<PositionRow>(
      `SELECT id,pair,direction,entry_price,current_price,quantity,leverage,margin,
       unrealized_pnl,realized_pnl,stop_loss,take_profit,liquidation_price,roe,
       status,opened_at,closed_at,mode,signal_id,fees
       FROM positions WHERE mode=$1 AND status=$2`,
      ['dryrun', 'OPEN'],
    );

    this.openPositions.clear();
    for (const row of rows) {
      const position = this.positionFromRow(row);
      if (!position) {
        const message = `Invalid dry-run open position row skipped: ${row.id ?? 'unknown'}`;
        if (config.dryRun.strictRestore) throw new Error(message);
        log.warn({ rowId: row.id }, message);
        continue;
      }
      this.openPositions.set(position.id, position);
    }

    this.wallet.usedMargin = Array.from(this.openPositions.values())
      .reduce((sum, position) => sum + position.margin, 0);
    this.recalculateWallet();
    log.info({ restored: this.openPositions.size }, 'DryRun: Restored open positions from DB');
  }

  private positionFromRow(row: PositionRow): Position | null {
    const pair = row.pair;
    const direction = row.direction;
    const entryPrice = this.toFiniteNumber(row.entry_price);
    const currentPrice = this.toFiniteNumber(row.current_price);
    const quantity = this.toFiniteNumber(row.quantity);
    const leverage = this.toFiniteNumber(row.leverage);
    const margin = this.toFiniteNumber(row.margin);
    const stopLoss = this.toFiniteNumber(row.stop_loss);
    const takeProfit = this.toFiniteNumber(row.take_profit);
    const liquidationPrice = this.toFiniteNumber(row.liquidation_price);
    const openedAt = this.toTimestamp(row.opened_at);

    if (!['BTCUSDT', 'ETHUSDT', 'SOLUSDT'].includes(pair)) return null;
    if (direction !== 'LONG' && direction !== 'SHORT') return null;
    if ([entryPrice, currentPrice, quantity, leverage, margin, stopLoss, takeProfit, liquidationPrice].some((value) => !Number.isFinite(value) || value <= 0)) return null;
    if (!Number.isFinite(openedAt) || openedAt <= 0) return null;

    return {
      id: row.id,
      pair: pair as TradingPair,
      direction,
      entryPrice,
      currentPrice,
      quantity,
      leverage,
      margin,
      unrealizedPnl: this.toFiniteNumber(row.unrealized_pnl, 0),
      realizedPnl: this.toFiniteNumber(row.realized_pnl, 0),
      stopLoss,
      takeProfit,
      liquidationPrice,
      roe: this.toFiniteNumber(row.roe, 0),
      status: 'OPEN',
      openedAt,
      mode: 'dryrun',
      signalId: row.signal_id ?? 'restored',
      fees: this.toFiniteNumber(row.fees, 0),
    };
  }

  private toFiniteNumber(value: string | number | null | undefined, fallback = NaN): number {
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  private toTimestamp(value: string | number | Date): number {
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'number') return value;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    return new Date(value).getTime();
  }

  private normalizeWallet(wallet: Partial<VirtualWallet>): VirtualWallet {
    const balance = this.finiteOr(wallet.balance, config.dryRun.balance);
    const usedMargin = this.finiteOr(wallet.usedMargin, 0);
    const unrealizedPnl = this.finiteOr(wallet.unrealizedPnl, 0);
    const equity = this.finiteOr(wallet.equity, balance + unrealizedPnl);
    return {
      balance,
      equity,
      usedMargin,
      freeMargin: this.finiteOr(wallet.freeMargin, equity - usedMargin),
      unrealizedPnl,
      realizedPnl: this.finiteOr(wallet.realizedPnl, 0),
      dailyPnl: this.finiteOr(wallet.dailyPnl, 0),
      fees: this.finiteOr(wallet.fees, 0),
    };
  }

  private finiteOr(value: number | undefined, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  }

  private async saveWallet(): Promise<void> {
    await redis.setJson(CacheKeys.dryRunWallet(), this.wallet, 86400)
      .catch((err: unknown) => log.warn({ err }, 'DryRun: Failed to persist wallet'));
  }

  async executeSignal(signal: TradingSignal): Promise<Position | null> {
    await this.ensureInitialized();
    const risk = await riskManager.assessSignal(signal, this.wallet.balance);
    if (!risk.isAllowed) {
      log.warn({ reason: risk.reason, pair: signal.pair }, 'DryRun: Trade rejected by risk manager');
      return null;
    }
    return this.openPosition(signal, risk);
  }

  private async openPosition(signal: TradingSignal, risk: RiskAssessment): Promise<Position | null> {
    const isLong = signal.direction === 'LONG';
    const leverage = risk.leverage;
    const quantity = risk.positionSize;
    const slippage = config.dryRun.slippage;

    const entryStart = Date.now();
    const filledPrice = isLong ? signal.entry * (1 + slippage) : signal.entry * (1 - slippage);
    const latencyMs = Date.now() - entryStart;

    const margin = (quantity * filledPrice) / leverage;
    const fee = quantity * filledPrice * config.dryRun.feeRate;
    if (!Number.isFinite(margin) || margin <= 0 || !Number.isFinite(fee) || fee < 0) {
      log.warn({ pair: signal.pair, margin, fee }, 'DryRun: Invalid margin or fee; refusing position');
      return null;
    }

    if (margin + fee > this.wallet.freeMargin) {
      log.warn({
        pair: signal.pair,
        required: margin + fee,
        freeMargin: this.wallet.freeMargin,
      }, 'DryRun: Insufficient free margin; refusing position');
      return null;
    }

    const maintenanceMarginRate = 0.004;
    const liquidationPrice = isLong
      ? filledPrice * (1 - 1 / leverage + maintenanceMarginRate)
      : filledPrice * (1 + 1 / leverage - maintenanceMarginRate);

    const position: Position = {
      id: uuidv4(),
      pair: signal.pair,
      direction: signal.direction,
      entryPrice: filledPrice,
      currentPrice: filledPrice,
      quantity,
      leverage,
      margin,
      unrealizedPnl: 0,
      realizedPnl: 0,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      liquidationPrice,
      roe: 0,
      status: 'OPEN',
      openedAt: Date.now(),
      mode: 'dryrun',
      signalId: signal.id,
      fees: fee,
    };

    // Record regime and session at entry for later self-review
    const regime = await marketRegimeEngine.getCached(signal.pair);
    const session = sessionFilter.getCurrentSession();
    this.positionRegimes.set(position.id, regime?.regime ?? 'unknown');
    this.positionSessions.set(position.id, session.name);

    // Execution quality analysis
    const execQuality: ExecutionQuality = {
      positionId: position.id,
      requestedPrice: signal.entry,
      filledPrice,
      slippage: Math.abs(filledPrice - signal.entry),
      slippagePercent: slippage * 100,
      spread: signal.entry * 0.0001,
      latencyMs,
      fillQuality: slippage < 0.001 ? 'excellent' : slippage < 0.003 ? 'good' : 'poor',
      timestamp: Date.now(),
    };

    this.wallet.balance -= fee;
    this.wallet.fees += fee;
    this.wallet.usedMargin += margin;
    this.recalculateWallet();

    this.openPositions.set(position.id, position);
    await this.saveWallet();
    await this.persistPosition(position);
    await frequencyLimiter.recordTrade();

    await riskManager.onPositionOpened();

    log.info({
      id: position.id,
      pair: position.pair,
      direction: position.direction,
      entry: filledPrice.toFixed(4),
      quantity: quantity.toFixed(6),
      leverage,
      regime: regime?.regime,
      session: session.name,
      execQuality: execQuality.fillQuality,
    }, 'DryRun: Position opened');

    this.emit('position_opened', { position, execQuality });
    return position;
  }

  async updatePositionPrice(pair: TradingPair, currentPrice: number): Promise<void> {
    await this.ensureInitialized();
    for (const [id, pos] of this.openPositions) {
      if (pos.pair !== pair) continue;
      const isLong = pos.direction === 'LONG';

      const priceDiff = isLong ? currentPrice - pos.entryPrice : pos.entryPrice - currentPrice;
      pos.currentPrice = currentPrice;
      pos.unrealizedPnl = priceDiff * pos.quantity;
      pos.roe = pos.margin > 0 ? (pos.unrealizedPnl / pos.margin) * 100 : 0;

      if ((isLong && currentPrice <= pos.liquidationPrice) || (!isLong && currentPrice >= pos.liquidationPrice)) {
        await this.liquidatePosition(id, currentPrice);
        continue;
      }
      if ((isLong && currentPrice <= pos.stopLoss) || (!isLong && currentPrice >= pos.stopLoss)) {
        await this.closePosition(id, currentPrice, 'SL_HIT');
        continue;
      }
      if ((isLong && currentPrice >= pos.takeProfit) || (!isLong && currentPrice <= pos.takeProfit)) {
        await this.closePosition(id, currentPrice, 'TP_HIT');
      }
    }

    this.recalculateWallet();
    await this.saveWallet();
  }

  async closePosition(positionId: string, price: number, reason: 'TP_HIT' | 'SL_HIT' | 'MANUAL'): Promise<void> {
    await this.ensureInitialized();
    const pos = this.openPositions.get(positionId);
    if (!pos) return;

    const isLong = pos.direction === 'LONG';
    const exitPrice = isLong ? price * (1 - config.dryRun.slippage) : price * (1 + config.dryRun.slippage);
    const closeFee = pos.quantity * exitPrice * config.dryRun.feeRate;
    const priceDiff = isLong ? exitPrice - pos.entryPrice : pos.entryPrice - exitPrice;
    const grossPnl = priceDiff * pos.quantity;

    pos.realizedPnl = grossPnl - pos.fees - closeFee;
    pos.fees += closeFee;
    pos.unrealizedPnl = 0;
    pos.currentPrice = exitPrice;
    pos.status = 'CLOSED';
    pos.closedAt = Date.now();

    this.wallet.balance += grossPnl - closeFee;
    this.wallet.usedMargin = Math.max(0, this.wallet.usedMargin - pos.margin);
    this.wallet.realizedPnl += pos.realizedPnl;
    this.wallet.dailyPnl += pos.realizedPnl;
    this.wallet.fees += closeFee;

    this.openPositions.delete(positionId);
    this.recalculateWallet();
    await this.saveWallet();
    await this.updatePositionInDb(pos);

    // Record win/loss for streak tracking
    if (pos.realizedPnl < 0) await frequencyLimiter.recordLoss();
    else await frequencyLimiter.recordWin();

    await riskManager.onPositionClosed(pos.realizedPnl);

    // Self-review
    const regimeAtEntry = (this.positionRegimes.get(positionId) ?? 'unknown') as MarketRegime;
    const sessionAtEntry = (this.positionSessions.get(positionId) ?? 'dead') as SessionName;
    this.positionRegimes.delete(positionId);
    this.positionSessions.delete(positionId);

    selfReviewEngine.reviewTrade(pos, regimeAtEntry, sessionAtEntry, 70, 60, reason).catch(() => {});

    log.info({
      id: pos.id, reason, pnl: pos.realizedPnl.toFixed(4), exitPrice: exitPrice.toFixed(4),
    }, 'DryRun: Position closed');

    this.emit('position_closed', { position: pos, reason });
  }

  private async liquidatePosition(positionId: string, price: number): Promise<void> {
    await this.ensureInitialized();
    const pos = this.openPositions.get(positionId);
    if (!pos) return;

    const liquidationFee = pos.quantity * price * config.dryRun.feeRate;
    pos.realizedPnl = -pos.margin - pos.fees - liquidationFee;
    pos.fees += liquidationFee;
    pos.unrealizedPnl = 0;
    pos.status = 'LIQUIDATED';
    pos.closedAt = Date.now();
    pos.currentPrice = price;

    this.wallet.balance -= pos.margin + liquidationFee;
    this.wallet.usedMargin = Math.max(0, this.wallet.usedMargin - pos.margin);
    this.wallet.realizedPnl += pos.realizedPnl;
    this.wallet.dailyPnl += pos.realizedPnl;
    this.wallet.fees += liquidationFee;

    this.openPositions.delete(positionId);
    this.recalculateWallet();
    await this.saveWallet();
    await this.updatePositionInDb(pos);

    await frequencyLimiter.recordLoss();
    await riskManager.onPositionClosed(pos.realizedPnl);

    log.warn({ id: pos.id, price: price.toFixed(4) }, 'DryRun: Position LIQUIDATED');
    this.emit('position_liquidated', pos);
  }

  getWallet(): VirtualWallet { return { ...this.wallet }; }
  getOpenPositions(): Position[] { return Array.from(this.openPositions.values()); }

  private recalculateWallet(): void {
    const totalUnrealized = Array.from(this.openPositions.values())
      .reduce((sum, position) => sum + position.unrealizedPnl, 0);
    this.wallet.unrealizedPnl = totalUnrealized;
    this.wallet.equity = this.wallet.balance + totalUnrealized;
    this.wallet.freeMargin = this.wallet.equity - this.wallet.usedMargin;
  }

  private async persistPosition(pos: Position): Promise<void> {
    await db.query(
      `INSERT INTO positions (id,pair,direction,entry_price,current_price,quantity,leverage,
       margin,unrealized_pnl,realized_pnl,stop_loss,take_profit,liquidation_price,
       roe,status,opened_at,mode,signal_id,fees)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [pos.id, pos.pair, pos.direction, pos.entryPrice, pos.currentPrice, pos.quantity,
       pos.leverage, pos.margin, pos.unrealizedPnl, pos.realizedPnl, pos.stopLoss,
       pos.takeProfit, pos.liquidationPrice, pos.roe, pos.status, pos.openedAt,
       pos.mode, pos.signalId, pos.fees],
    ).catch((err) => log.warn({ err }, 'Failed to persist position'));
  }

  private async updatePositionInDb(pos: Position): Promise<void> {
    await db.query(
      `UPDATE positions SET current_price=$1,unrealized_pnl=$2,realized_pnl=$3,
       roe=$4,status=$5,closed_at=$6,updated_at=NOW() WHERE id=$7`,
      [pos.currentPrice, pos.unrealizedPnl, pos.realizedPnl, pos.roe, pos.status, pos.closedAt, pos.id],
    ).catch((err) => log.warn({ err }, 'Failed to update position'));
  }
}

export const dryRunExecutor = new DryRunExecutor();
