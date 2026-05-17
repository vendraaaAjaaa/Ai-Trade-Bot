import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../../config';
import { createLogger } from '../../utils/logger';
import { redis, CacheKeys } from '../../redis/client';
import { db } from '../../database/connection';
import { riskManager } from '../../risk/riskManager';
import type { TradingSignal, Position, TradeOrder, RiskAssessment, TradingPair } from '../../utils/types';

const log = createLogger('dryrun');

interface VirtualWallet {
  balance: number;
  equity: number;
  usedMargin: number;
  freeMargin: number;
  unrealizedPnl: number;
  dailyPnl: number;
}

export class DryRunExecutor extends EventEmitter {
  private wallet: VirtualWallet;
  private openPositions = new Map<string, Position>();

  constructor() {
    super();
    this.wallet = {
      balance: config.dryRun.balance,
      equity: config.dryRun.balance,
      usedMargin: 0,
      freeMargin: config.dryRun.balance,
      unrealizedPnl: 0,
      dailyPnl: 0,
    };
    this.loadWallet();
  }

  private async loadWallet(): Promise<void> {
    const cached = await redis.getJson<VirtualWallet>(CacheKeys.dryRunWallet());
    if (cached) this.wallet = cached;
  }

  private async saveWallet(): Promise<void> {
    await redis.setJson(CacheKeys.dryRunWallet(), this.wallet, 86400);
  }

  async executeSignal(signal: TradingSignal): Promise<Position | null> {
    const risk = await riskManager.assessSignal(signal, this.wallet.balance);

    if (!risk.isAllowed) {
      log.warn({ reason: risk.reason, pair: signal.pair }, 'DryRun: Trade rejected');
      return null;
    }

    return this.openPosition(signal, risk);
  }

  private async openPosition(signal: TradingSignal, risk: RiskAssessment): Promise<Position> {
    const isLong = signal.direction === 'LONG';
    const leverage = risk.leverage;
    const quantity = risk.positionSize;

    // Apply simulated slippage
    const slippage = config.dryRun.slippage;
    const filledPrice = isLong
      ? signal.entry * (1 + slippage)
      : signal.entry * (1 - slippage);

    const margin = (quantity * filledPrice) / leverage;
    const fee = quantity * filledPrice * config.dryRun.feeRate;

    // Liquidation price calculation
    const maintenanceMarginRate = 0.004;
    const liquidationPrice = isLong
      ? filledPrice * (1 - (1 / leverage) + maintenanceMarginRate)
      : filledPrice * (1 + (1 / leverage) - maintenanceMarginRate);

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

    // Deduct margin + fee from balance
    this.wallet.balance -= fee;
    this.wallet.usedMargin += margin;
    this.wallet.freeMargin = this.wallet.balance - this.wallet.usedMargin;

    this.openPositions.set(position.id, position);
    await this.saveWallet();
    await this.persistPosition(position);
    await this.createOrder(position, 'BUY', 'MARKET', filledPrice, quantity);

    await riskManager.onPositionOpened();

    log.info({
      id: position.id,
      pair: position.pair,
      direction: position.direction,
      entry: filledPrice.toFixed(4),
      quantity: quantity.toFixed(6),
      leverage,
    }, 'DryRun: Position opened');

    this.emit('position_opened', position);
    return position;
  }

  async updatePositionPrice(pair: TradingPair, currentPrice: number): Promise<void> {
    for (const [id, pos] of this.openPositions) {
      if (pos.pair !== pair) continue;
      const isLong = pos.direction === 'LONG';

      // PnL calculation
      const priceDiff = isLong
        ? currentPrice - pos.entryPrice
        : pos.entryPrice - currentPrice;

      pos.currentPrice = currentPrice;
      pos.unrealizedPnl = priceDiff * pos.quantity * pos.leverage;
      pos.roe = pos.margin > 0 ? (pos.unrealizedPnl / pos.margin) * 100 : 0;

      // Check liquidation
      if (
        (isLong && currentPrice <= pos.liquidationPrice) ||
        (!isLong && currentPrice >= pos.liquidationPrice)
      ) {
        await this.liquidatePosition(id, currentPrice);
        continue;
      }

      // Check stop loss
      if (
        (isLong && currentPrice <= pos.stopLoss) ||
        (!isLong && currentPrice >= pos.stopLoss)
      ) {
        await this.closePosition(id, currentPrice, 'SL_HIT');
        continue;
      }

      // Check take profit
      if (
        (isLong && currentPrice >= pos.takeProfit) ||
        (!isLong && currentPrice <= pos.takeProfit)
      ) {
        await this.closePosition(id, currentPrice, 'TP_HIT');
      }
    }

    // Update wallet equity
    const totalUnrealizedPnl = Array.from(this.openPositions.values())
      .filter((p) => p.pair === pair)
      .reduce((s, p) => s + p.unrealizedPnl, 0);

    this.wallet.unrealizedPnl = totalUnrealizedPnl;
    this.wallet.equity = this.wallet.balance + totalUnrealizedPnl;
    await this.saveWallet();
  }

  async closePosition(
    positionId: string,
    price: number,
    reason: 'TP_HIT' | 'SL_HIT' | 'MANUAL',
  ): Promise<void> {
    const pos = this.openPositions.get(positionId);
    if (!pos) return;

    const isLong = pos.direction === 'LONG';
    const closeFee = pos.quantity * price * config.dryRun.feeRate;

    // Apply slippage on close
    const exitPrice = isLong
      ? price * (1 - config.dryRun.slippage)
      : price * (1 + config.dryRun.slippage);

    const priceDiff = isLong
      ? exitPrice - pos.entryPrice
      : pos.entryPrice - exitPrice;

    pos.realizedPnl = priceDiff * pos.quantity - pos.fees - closeFee;
    pos.currentPrice = exitPrice;
    pos.status = 'CLOSED';
    pos.closedAt = Date.now();

    // Update wallet
    this.wallet.balance += pos.realizedPnl + pos.margin;
    this.wallet.usedMargin = Math.max(0, this.wallet.usedMargin - pos.margin);
    this.wallet.freeMargin = this.wallet.balance - this.wallet.usedMargin;
    this.wallet.dailyPnl += pos.realizedPnl;

    this.openPositions.delete(positionId);
    await this.saveWallet();
    await this.updatePositionInDb(pos);
    await this.createOrder(pos, isLong ? 'SELL' : 'BUY', 'MARKET', exitPrice, pos.quantity);

    await riskManager.onPositionClosed(pos.realizedPnl);

    log.info({
      id: pos.id,
      reason,
      pnl: pos.realizedPnl.toFixed(4),
      exitPrice: exitPrice.toFixed(4),
    }, 'DryRun: Position closed');

    this.emit('position_closed', { position: pos, reason });
  }

  private async liquidatePosition(positionId: string, price: number): Promise<void> {
    const pos = this.openPositions.get(positionId);
    if (!pos) return;

    pos.realizedPnl = -pos.margin; // Full margin lost
    pos.status = 'LIQUIDATED';
    pos.closedAt = Date.now();
    pos.currentPrice = price;

    this.wallet.usedMargin = Math.max(0, this.wallet.usedMargin - pos.margin);
    this.wallet.freeMargin = this.wallet.balance - this.wallet.usedMargin;
    this.wallet.dailyPnl -= pos.margin;

    this.openPositions.delete(positionId);
    await this.saveWallet();
    await this.updatePositionInDb(pos);
    await riskManager.onPositionClosed(-pos.margin);

    log.warn({ id: pos.id, price: price.toFixed(4) }, 'DryRun: Position LIQUIDATED');
    this.emit('position_liquidated', pos);
  }

  getWallet(): VirtualWallet {
    return { ...this.wallet };
  }

  getOpenPositions(): Position[] {
    return Array.from(this.openPositions.values());
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

  private async createOrder(pos: Position, side: string, type: string, price: number, qty: number): Promise<void> {
    await db.query(
      `INSERT INTO orders (id,position_id,pair,side,type,price,quantity,status,filled_at,filled_price,mode)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [uuidv4(), pos.id, pos.pair, side, type, price, qty, 'FILLED', Date.now(), price, 'dryrun'],
    ).catch(() => {});
  }
}

export const dryRunExecutor = new DryRunExecutor();
