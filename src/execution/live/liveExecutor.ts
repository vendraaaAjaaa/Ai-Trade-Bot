import axios from 'axios';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../../config';
import { createLogger } from '../../utils/logger';
import { riskManager } from '../../risk/riskManager';
import { db } from '../../database/connection';
import type { TradingSignal, Position, TradingPair } from '../../utils/types';

const log = createLogger('live-executor');

export class LiveExecutor extends EventEmitter {
  private baseUrl: string;

  constructor() {
    super();
    this.baseUrl = config.binance.testnet
      ? config.binance.testnetFuturesUrl
      : config.binance.futuresBaseUrl;
  }

  async executeSignal(signal: TradingSignal, balance: number): Promise<Position | null> {
    if (config.trading.mode !== 'live') {
      log.warn('LiveExecutor called but mode is not live');
      return null;
    }

    const risk = await riskManager.assessSignal(signal, balance);
    if (!risk.isAllowed) {
      log.warn({ reason: risk.reason }, 'Live: Trade rejected by risk manager');
      return null;
    }

    try {
      // Set leverage first
      await this.setLeverage(signal.pair, risk.leverage);

      // Place market order
      const order = await this.placeMarketOrder(
        signal.pair,
        signal.direction === 'LONG' ? 'BUY' : 'SELL',
        risk.positionSize,
      );

      if (!order) return null;

      const filledPrice = parseFloat(order.avgPrice || order.price);
      const positionId = uuidv4();

      // Set stop loss order
      await this.placeSLTPOrders(
        signal.pair,
        signal.direction === 'LONG' ? 'SELL' : 'BUY',
        risk.positionSize,
        signal.stopLoss,
        signal.takeProfit,
      );

      const position: Position = {
        id: positionId,
        pair: signal.pair,
        direction: signal.direction,
        entryPrice: filledPrice,
        currentPrice: filledPrice,
        quantity: risk.positionSize,
        leverage: risk.leverage,
        margin: (risk.positionSize * filledPrice) / risk.leverage,
        unrealizedPnl: 0,
        realizedPnl: 0,
        stopLoss: signal.stopLoss,
        takeProfit: signal.takeProfit,
        liquidationPrice: signal.direction === 'LONG'
          ? filledPrice * (1 - 1 / risk.leverage + 0.004)
          : filledPrice * (1 + 1 / risk.leverage - 0.004),
        roe: 0,
        status: 'OPEN',
        openedAt: Date.now(),
        mode: 'live',
        signalId: signal.id,
        fees: 0,
      };

      await this.persistPosition(position);
      await riskManager.onPositionOpened();

      log.info({
        pair: signal.pair,
        direction: signal.direction,
        entry: filledPrice,
        qty: risk.positionSize,
      }, 'Live: Position opened');

      this.emit('position_opened', position);
      return position;
    } catch (err) {
      log.error({ err, pair: signal.pair }, 'Live: Failed to execute signal');
      return null;
    }
  }

  private async setLeverage(pair: TradingPair, leverage: number): Promise<void> {
    await this.signedRequest('POST', '/fapi/v1/leverage', {
      symbol: pair,
      leverage: leverage.toString(),
    });
  }

  private async placeMarketOrder(pair: TradingPair, side: string, quantity: number) {
    return this.signedRequest('POST', '/fapi/v1/order', {
      symbol: pair,
      side,
      type: 'MARKET',
      quantity: quantity.toFixed(6),
    });
  }

  private async placeSLTPOrders(
    pair: TradingPair,
    side: string,
    qty: number,
    sl: number,
    tp: number,
  ): Promise<void> {
    // Stop loss
    await this.signedRequest('POST', '/fapi/v1/order', {
      symbol: pair,
      side,
      type: 'STOP_MARKET',
      stopPrice: sl.toFixed(2),
      quantity: qty.toFixed(6),
      reduceOnly: 'true',
    }).catch((err) => log.warn({ err }, 'Failed to set SL'));

    // Take profit
    await this.signedRequest('POST', '/fapi/v1/order', {
      symbol: pair,
      side,
      type: 'TAKE_PROFIT_MARKET',
      stopPrice: tp.toFixed(2),
      quantity: qty.toFixed(6),
      reduceOnly: 'true',
    }).catch((err) => log.warn({ err }, 'Failed to set TP'));
  }

  async closePosition(pair: TradingPair, side: string, quantity: number): Promise<void> {
    await this.signedRequest('POST', '/fapi/v1/order', {
      symbol: pair,
      side,
      type: 'MARKET',
      quantity: quantity.toFixed(6),
      reduceOnly: 'true',
    });
  }

  async getAccountBalance(): Promise<number> {
    const result = await this.signedRequest('GET', '/fapi/v2/account', {});
    if (!result) return 0;
    const usdtAsset = result.assets?.find((a: { asset: string }) => a.asset === 'USDT');
    return parseFloat(usdtAsset?.availableBalance ?? '0');
  }

  private async signedRequest(method: string, endpoint: string, params: Record<string, string>): Promise<any> {
    const timestamp = Date.now().toString();
    const allParams = { ...params, timestamp };
    const queryString = new URLSearchParams(allParams).toString();
    const signature = crypto
      .createHmac('sha256', config.binance.apiSecret)
      .update(queryString)
      .digest('hex');

    const url = `${this.baseUrl}${endpoint}?${queryString}&signature=${signature}`;
    const headers = { 'X-MBX-APIKEY': config.binance.apiKey };

    if (method === 'GET') {
      const res = await axios.get(url, { headers, timeout: 10000 });
      return res.data;
    }

    const res = await axios.post(url, null, { headers, timeout: 10000 });
    return res.data;
  }

  private async persistPosition(pos: Position): Promise<void> {
    await db.query(
      `INSERT INTO positions (id,pair,direction,entry_price,current_price,quantity,leverage,
       margin,unrealized_pnl,realized_pnl,stop_loss,take_profit,liquidation_price,
       roe,status,opened_at,mode,signal_id,fees)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [pos.id, pos.pair, pos.direction, pos.entryPrice, pos.currentPrice, pos.quantity,
       pos.leverage, pos.margin, 0, 0, pos.stopLoss, pos.takeProfit, pos.liquidationPrice,
       0, 'OPEN', pos.openedAt, 'live', pos.signalId, 0],
    ).catch((err) => log.warn({ err }, 'Failed to persist live position'));
  }
}

export const liveExecutor = new LiveExecutor();
