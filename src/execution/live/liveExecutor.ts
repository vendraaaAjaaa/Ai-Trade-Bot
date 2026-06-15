/**
 * =============================================
 * LIVE_EXECUTOR — Phase 8 Protective-Order Fail Closed
 * =============================================
 *
 * Changes from Phase 8:
 *   - Live execution returns explicit status codes for protection and emergency-close outcomes.
 *   - Binance orders use exchange filters for quantity and price formatting.
 *   - Failed SL/TP creation triggers a reduce-only emergency close attempt.
 *   - Phase 9 reconciles market fills from exchange data and trips a kill switch
 *     when emergency close fails.
 *
 * Safety preserved:
 *   - riskManager.assessSignal() remains mandatory before every live order.
 *   - Stop-loss and take-profit orders are not downgraded to warnings.
 *   - reduceOnly is used for protective and emergency-close orders.
 */

import axios from 'axios';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../../config';
import { createLogger } from '../../utils/logger';
import { riskManager } from '../../risk/riskManager';
import { db } from '../../database/connection';
import { binanceFilterService, BinanceFilterService } from '../../exchange/binanceFilters';
import { liveCircuitBreaker } from './liveCircuitBreaker';
import { operatorAlertService, type OperatorAlertService } from '../../alerts/operatorAlert';
import type { TradingSignal, Position, TradingPair, OrderSide, RiskAssessment } from '../../utils/types';
import type { LiveCircuitBreaker, LiveCircuitBreakerState, LiveCircuitBreakerTripInput } from './liveCircuitBreaker';

const log = createLogger('live-executor');

export type LiveExecutionStatus =
  | 'EXECUTED_WITH_PROTECTION'
  | 'EXECUTION_FAILED'
  | 'PROTECTION_FAILED_POSITION_CLOSED'
  | 'EMERGENCY_CLOSE_FAILED';

export interface LiveExecutionResult {
  status: LiveExecutionStatus;
  position: Position | null;
  reason?: string;
  exchangeOrderId?: string;
}

interface BinanceAccountAsset {
  asset: string;
  availableBalance: string;
}

interface BinanceAccountResponse {
  assets?: BinanceAccountAsset[];
}

type BinanceApiResponse = Record<string, unknown>;
type HttpMethod = 'GET' | 'POST' | 'DELETE';
type SignedRequestFn = (method: HttpMethod, endpoint: string, params: Record<string, string>) => Promise<BinanceApiResponse>;

interface LiveRiskManager {
  assessSignal(signal: TradingSignal, balance: number): Promise<RiskAssessment>;
  onPositionOpened(): Promise<void>;
}

export interface ReconciledFill {
  orderId?: string;
  avgPrice: number;
  executedQty: number;
  status?: string;
  quantityDiff: number;
  raw: BinanceApiResponse;
}

export interface LiveExecutorOptions {
  filterService?: BinanceFilterService;
  signedRequest?: SignedRequestFn;
  risk?: LiveRiskManager;
  persistPosition?: (position: Position) => Promise<void>;
  baseUrl?: string;
  circuitBreaker?: Pick<LiveCircuitBreaker, 'assertCanTrade' | 'trip'>;
  alertService?: OperatorAlertService;
}

export class LiveExecutor extends EventEmitter {
  private readonly baseUrl: string;
  private readonly filterService: BinanceFilterService;
  private readonly signedRequestOverride?: SignedRequestFn;
  private readonly risk: LiveRiskManager;
  private readonly persistPositionOverride?: (position: Position) => Promise<void>;
  private readonly circuitBreaker: Pick<LiveCircuitBreaker, 'assertCanTrade' | 'trip'>;
  private readonly alertService: OperatorAlertService;

  constructor(options: LiveExecutorOptions = {}) {
    super();
    this.baseUrl = options.baseUrl ?? (config.binance.testnet
      ? config.binance.testnetFuturesUrl
      : config.binance.futuresBaseUrl);
    this.filterService = options.filterService ?? binanceFilterService;
    this.signedRequestOverride = options.signedRequest;
    this.risk = options.risk ?? riskManager;
    this.persistPositionOverride = options.persistPosition;
    this.circuitBreaker = options.circuitBreaker ?? liveCircuitBreaker;
    this.alertService = options.alertService ?? operatorAlertService;
  }

  async executeSignal(signal: TradingSignal, balance: number): Promise<LiveExecutionResult> {
    if (config.trading.mode !== 'live') {
      log.warn('LiveExecutor called but mode is not live');
      return { status: 'EXECUTION_FAILED', position: null, reason: 'Trading mode is not live' };
    }

    const breaker = await this.canTradeWithCircuitBreaker();
    if (!breaker.allowed) {
      log.error({ state: breaker.state, pair: signal.pair }, 'Live: Trade rejected by active circuit breaker');
      return {
        status: 'EXECUTION_FAILED',
        position: null,
        reason: `Live circuit breaker active: ${breaker.state.reason}`,
      };
    }

    const risk = await this.risk.assessSignal(signal, balance);
    if (!risk.isAllowed) {
      log.warn({ reason: risk.reason }, 'Live: Trade rejected by risk manager');
      return { status: 'EXECUTION_FAILED', position: null, reason: risk.reason ?? 'Rejected by risk manager' };
    }

    const orderSide: OrderSide = signal.direction === 'LONG' ? 'BUY' : 'SELL';
    const exitSide: OrderSide = signal.direction === 'LONG' ? 'SELL' : 'BUY';
    const positionId = uuidv4();

    try {
      const normalized = await this.filterService.normalizeMarketOrder(signal.pair, risk.positionSize, signal.entry);

      await this.setLeverage(signal.pair, risk.leverage);

      const order = await this.placeMarketOrder(signal.pair, orderSide, normalized.quantityText);
      const exchangeOrderId = this.stringField(order, 'orderId');
      let fill: ReconciledFill;

      try {
        fill = await this.reconcileFilledOrder(signal.pair, order, normalized.quantity);
      } catch (fillError) {
        log.error({
          err: fillError,
          pair: signal.pair,
          direction: signal.direction,
          exchangeOrderId,
        }, 'CRITICAL: Live fill reconciliation failed after market order; attempting emergency close');

        const emergency = await this.emergencyClose(signal.pair, exitSide, normalized.quantity, signal.entry);
        if (!emergency.success) {
          return this.handleEmergencyCloseFailed({
            reason: 'Fill reconciliation failed and emergency close failed',
            pair: signal.pair,
            direction: signal.direction,
            quantity: normalized.quantity,
            exchangeOrderId,
            lastErrorMessage: emergency.errorMessage ?? this.errorMessage(fillError),
          });
        }

        await this.cancelOpenOrders(signal.pair).catch((cancelError: unknown) => {
          log.error({ err: cancelError, pair: signal.pair }, 'Live: Failed to cancel orphan orders after fill reconciliation emergency close');
        });
        return {
          status: 'EXECUTION_FAILED',
          position: null,
          reason: 'Fill reconciliation failed; position was emergency closed',
          exchangeOrderId,
        };
      }

      const filledPrice = fill.avgPrice;
      const executedQuantity = fill.executedQty;

      try {
        await this.placeSLTPOrders(
          signal.pair,
          signal.direction,
          exitSide,
          executedQuantity,
          filledPrice,
          signal.stopLoss,
          signal.takeProfit,
        );
      } catch (protectionError) {
        log.error({
          err: protectionError,
          pair: signal.pair,
          direction: signal.direction,
          exchangeOrderId,
        }, 'CRITICAL: Live protective order placement failed; attempting emergency close');

        const emergency = await this.emergencyClose(signal.pair, exitSide, executedQuantity, filledPrice);
        if (emergency.success) {
          await this.cancelOpenOrders(signal.pair).catch((cancelError: unknown) => {
            log.error({ err: cancelError, pair: signal.pair }, 'Live: Failed to cancel orphan orders after emergency close');
          });
          return {
            status: 'PROTECTION_FAILED_POSITION_CLOSED',
            position: null,
            reason: 'Protective order placement failed; position was emergency closed',
            exchangeOrderId,
          };
        }

        return this.handleEmergencyCloseFailed({
          reason: 'Protective order placement failed and emergency close failed',
          pair: signal.pair,
          direction: signal.direction,
          quantity: executedQuantity,
          exchangeOrderId,
          lastErrorMessage: emergency.errorMessage ?? this.errorMessage(protectionError),
        });
      }

      const position: Position = {
        id: positionId,
        pair: signal.pair,
        direction: signal.direction,
        entryPrice: filledPrice,
        currentPrice: filledPrice,
        quantity: executedQuantity,
        leverage: risk.leverage,
        margin: (executedQuantity * filledPrice) / risk.leverage,
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
      await this.risk.onPositionOpened();

      log.info({
        pair: signal.pair,
        direction: signal.direction,
        entry: filledPrice,
        qty: executedQuantity,
      }, 'Live: Position opened with SL/TP protection');

      this.emit('position_opened', position);
      return { status: 'EXECUTED_WITH_PROTECTION', position, exchangeOrderId };
    } catch (err) {
      log.error({ err, pair: signal.pair }, 'Live: Failed to execute signal');
      return { status: 'EXECUTION_FAILED', position: null, reason: this.errorMessage(err) };
    }
  }

  private async setLeverage(pair: TradingPair, leverage: number): Promise<void> {
    await this.signedRequest('POST', '/fapi/v1/leverage', {
      symbol: pair,
      leverage: leverage.toString(),
    });
  }

  async reconcileFilledOrder(pair: TradingPair, order: BinanceApiResponse, requestedQuantity: number): Promise<ReconciledFill> {
    const immediate = this.parseFill(order, requestedQuantity);
    if (immediate) return immediate;

    const orderId = this.stringField(order, 'orderId');
    if (!orderId) {
      throw new Error('Market order response missing fill data and orderId');
    }

    const queried = await this.signedRequest('GET', '/fapi/v1/order', {
      symbol: pair,
      orderId,
    });
    const reconciled = this.parseFill(queried, requestedQuantity);
    if (!reconciled) {
      throw new Error('Queried order response missing usable fill data');
    }

    return reconciled;
  }

  private async placeMarketOrder(pair: TradingPair, side: OrderSide, quantity: string): Promise<BinanceApiResponse> {
    return this.signedRequest('POST', '/fapi/v1/order', {
      symbol: pair,
      side,
      type: 'MARKET',
      quantity,
      newOrderRespType: 'RESULT',
    });
  }

  private async placeSLTPOrders(
    pair: TradingPair,
    direction: 'LONG' | 'SHORT',
    side: OrderSide,
    qty: number,
    referencePrice: number,
    sl: number,
    tp: number,
  ): Promise<void> {
    const normalizedQuantity = await this.filterService.normalizeReduceOnlyQuantity(pair, qty, referencePrice);
    const slPrice = await this.filterService.normalizePrice(pair, sl, direction === 'LONG' ? 'ceil' : 'floor');
    const tpPrice = await this.filterService.normalizePrice(pair, tp, direction === 'LONG' ? 'floor' : 'ceil');

    await this.signedRequest('POST', '/fapi/v1/order', {
      symbol: pair,
      side,
      type: 'STOP_MARKET',
      stopPrice: slPrice.priceText,
      quantity: normalizedQuantity.quantityText,
      reduceOnly: 'true',
      workingType: 'MARK_PRICE',
    });

    await this.signedRequest('POST', '/fapi/v1/order', {
      symbol: pair,
      side,
      type: 'TAKE_PROFIT_MARKET',
      stopPrice: tpPrice.priceText,
      quantity: normalizedQuantity.quantityText,
      reduceOnly: 'true',
      workingType: 'MARK_PRICE',
    });
  }

  async closePosition(pair: TradingPair, side: OrderSide, quantity: number): Promise<void> {
    const referencePrice = await this.getReferencePrice(pair);
    const normalized = await this.filterService.normalizeReduceOnlyQuantity(pair, quantity, referencePrice);
    await this.signedRequest('POST', '/fapi/v1/order', {
      symbol: pair,
      side,
      type: 'MARKET',
      quantity: normalized.quantityText,
      reduceOnly: 'true',
      newOrderRespType: 'RESULT',
    });
  }

  async getAccountBalance(): Promise<number> {
    const result = await this.signedRequest('GET', '/fapi/v2/account', {});
    const account = result as BinanceAccountResponse;
    const usdtAsset = account.assets?.find((asset) => asset.asset === 'USDT');
    return Number(usdtAsset?.availableBalance ?? '0');
  }

  private async emergencyClose(pair: TradingPair, side: OrderSide, quantity: number, referencePrice: number): Promise<{ success: boolean; errorMessage?: string }> {
    try {
      const normalized = await this.filterService.normalizeReduceOnlyQuantity(pair, quantity, referencePrice);
      await this.signedRequest('POST', '/fapi/v1/order', {
        symbol: pair,
        side,
        type: 'MARKET',
        quantity: normalized.quantityText,
        reduceOnly: 'true',
        newOrderRespType: 'RESULT',
      });
      log.error({ pair, side, quantity: normalized.quantityText }, 'Live: Emergency reduce-only close succeeded');
      return { success: true };
    } catch (err) {
      log.error({ err, pair, side }, 'CRITICAL: Live emergency reduce-only close failed');
      return { success: false, errorMessage: this.errorMessage(err) };
    }
  }

  private async canTradeWithCircuitBreaker(): Promise<{ allowed: boolean; state: LiveCircuitBreakerState }> {
    try {
      return this.circuitBreaker.assertCanTrade();
    } catch (err) {
      const state: LiveCircuitBreakerState = {
        active: true,
        reason: 'Circuit breaker check failed',
        timestamp: Date.now(),
        lastErrorMessage: this.errorMessage(err),
      };
      return { allowed: false, state };
    }
  }

  private async handleEmergencyCloseFailed(input: LiveCircuitBreakerTripInput): Promise<LiveExecutionResult> {
    const state = await this.circuitBreaker.trip(input);
    try {
      await this.alertService.sendEmergencyCloseFailed({
        pair: input.pair,
        direction: input.direction,
        quantity: input.quantity,
        exchangeOrderId: input.exchangeOrderId,
        timestamp: state.timestamp,
        lastErrorMessage: input.lastErrorMessage,
      });
    } catch (alertError) {
      log.error({ err: alertError, pair: input.pair, exchangeOrderId: input.exchangeOrderId }, 'Emergency-close alert failed; breaker remains active');
    }

    return {
      status: 'EMERGENCY_CLOSE_FAILED',
      position: null,
      reason: input.reason,
      exchangeOrderId: input.exchangeOrderId,
    };
  }

  private async cancelOpenOrders(pair: TradingPair): Promise<void> {
    await this.signedRequest('DELETE', '/fapi/v1/allOpenOrders', { symbol: pair });
  }

  private async getReferencePrice(pair: TradingPair): Promise<number> {
    const response = await axios.get<{ price: string }>(`${this.baseUrl}/fapi/v1/ticker/price`, {
      params: { symbol: pair },
      timeout: 5000,
    });
    const price = Number(response.data.price);
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(`Invalid ticker price for ${pair}`);
    }
    return price;
  }

  private async signedRequest(method: HttpMethod, endpoint: string, params: Record<string, string>): Promise<BinanceApiResponse> {
    if (this.signedRequestOverride) {
      return this.signedRequestOverride(method, endpoint, params);
    }

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
      const res = await axios.get<BinanceApiResponse>(url, { headers, timeout: 10000 });
      return res.data;
    }

    if (method === 'DELETE') {
      const res = await axios.delete<BinanceApiResponse>(url, { headers, timeout: 10000 });
      return res.data;
    }

    const res = await axios.post<BinanceApiResponse>(url, null, { headers, timeout: 10000 });
    return res.data;
  }

  private async persistPosition(pos: Position): Promise<void> {
    if (this.persistPositionOverride) {
      await this.persistPositionOverride(pos);
      return;
    }

    await db.query(
      `INSERT INTO positions (id,pair,direction,entry_price,current_price,quantity,leverage,
       margin,unrealized_pnl,realized_pnl,stop_loss,take_profit,liquidation_price,
       roe,status,opened_at,mode,signal_id,fees)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [pos.id, pos.pair, pos.direction, pos.entryPrice, pos.currentPrice, pos.quantity,
       pos.leverage, pos.margin, 0, 0, pos.stopLoss, pos.takeProfit, pos.liquidationPrice,
       0, 'OPEN', pos.openedAt, 'live', pos.signalId, 0],
    ).catch((err: unknown) => log.warn({ err }, 'Failed to persist live position'));
  }

  private parseFill(order: BinanceApiResponse, requestedQuantity: number): ReconciledFill | null {
    const executedQty = this.numberField(order, 'executedQty');
    if (!Number.isFinite(executedQty) || executedQty <= 0) return null;

    const avgPrice = this.numberField(order, 'avgPrice');
    const cumQuote = this.numberField(order, 'cumQuote');
    const computedAvgPrice = avgPrice > 0 ? avgPrice : cumQuote > 0 ? cumQuote / executedQty : 0;
    if (!Number.isFinite(computedAvgPrice) || computedAvgPrice <= 0) return null;

    const quantityDiff = Math.abs(executedQty - requestedQuantity);
    const tolerance = Math.max(1e-8, requestedQuantity * 0.001);
    if (quantityDiff > tolerance) {
      log.warn({ requestedQuantity, executedQty, quantityDiff }, 'Live: Executed quantity differs materially from requested quantity; using exchange executed quantity');
    }

    return {
      orderId: this.stringField(order, 'orderId'),
      avgPrice: computedAvgPrice,
      executedQty,
      status: this.stringField(order, 'status'),
      quantityDiff,
      raw: order,
    };
  }

  private numberField(value: BinanceApiResponse, key: string): number {
    const raw = value[key];
    if (typeof raw === 'number') return raw;
    if (typeof raw === 'string') return Number(raw);
    return 0;
  }

  private stringField(value: BinanceApiResponse, key: string): string | undefined {
    const raw = value[key];
    if (typeof raw === 'string') return raw;
    if (typeof raw === 'number') return raw.toString();
    return undefined;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'Unknown execution error';
  }
}

export const liveExecutor = new LiveExecutor();
