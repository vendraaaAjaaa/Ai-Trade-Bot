import type { TradingPair, SmartMoneySignal, MEVDetection, WhaleActivity } from '../utils/types';
import { createLogger } from '../utils/logger';
import { redis, CacheKeys } from '../redis/client';
import { config } from '../config';
import type { Candle, AggregateTrade } from '../utils/types';

const log = createLogger('smartmoney');

// ---- Whale activity tracker ----
const whaleHistory = new Map<TradingPair, AggregateTrade[]>();

export function trackTrade(trade: AggregateTrade): WhaleActivity | null {
  const tradeUsdt = trade.price * trade.quantity;
  const threshold = config.signals.whaleThresholdUsdt;

  if (tradeUsdt < threshold) return null;

  const significance: 'low' | 'medium' | 'high' =
    tradeUsdt >= threshold * 5 ? 'high' : tradeUsdt >= threshold * 2 ? 'medium' : 'low';

  const activity: WhaleActivity = {
    pair: trade.pair,
    type: trade.side === 'BUY' ? 'large_buy' : 'large_sell',
    amount: trade.quantity,
    amountUsdt: tradeUsdt,
    price: trade.price,
    timestamp: trade.timestamp,
    significance,
  };

  // Track in history
  const history = whaleHistory.get(trade.pair) ?? [];
  history.push(trade);
  if (history.length > 200) history.splice(0, history.length - 200);
  whaleHistory.set(trade.pair, history);

  // Cache the whale event
  redis.lpush(
    CacheKeys.whaleActivity(trade.pair),
    JSON.stringify(activity),
  ).catch(() => {});
  redis.ltrim(CacheKeys.whaleActivity(trade.pair), 0, 49).catch(() => {});

  log.info({
    pair: trade.pair,
    amountUsdt: tradeUsdt.toFixed(0),
    side: trade.side,
    significance,
  }, 'Whale activity detected');

  return activity;
}

export function analyzeSmartMoney(pair: TradingPair, candles: Candle[]): SmartMoneySignal {
  if (candles.length < 20) {
    return { pair, action: 'neutral', netFlow: 0, dexInflow: 0, dexOutflow: 0, unusualActivity: false, timestamp: Date.now() };
  }

  const history = whaleHistory.get(pair) ?? [];
  const last15min = history.filter((t) => Date.now() - t.timestamp < 15 * 60 * 1000);

  const buyFlow = last15min.filter((t) => t.side === 'BUY').reduce((s, t) => s + t.price * t.quantity, 0);
  const sellFlow = last15min.filter((t) => t.side === 'SELL').reduce((s, t) => s + t.price * t.quantity, 0);
  const netFlow = buyFlow - sellFlow;

  // Simulate DEX inflow/outflow (exchange inflow = potential selling pressure)
  const recentCandles = candles.slice(-20);
  const volumeTrend = recentCandles.slice(-5).reduce((s, c) => s + c.volume, 0) /
    recentCandles.slice(0, 5).reduce((s, c) => s + c.volume, 0);

  // Rising volume with rising price = accumulation; rising volume with falling price = distribution
  const lastClose = recentCandles[recentCandles.length - 1]!.close;
  const firstClose = recentCandles[0]!.close;
  const priceDirection = lastClose > firstClose ? 1 : -1;

  const dexInflow = volumeTrend > 1.2 && priceDirection < 0 ? sellFlow * 0.3 : sellFlow * 0.1;
  const dexOutflow = volumeTrend > 1.2 && priceDirection > 0 ? buyFlow * 0.2 : buyFlow * 0.1;

  const action: SmartMoneySignal['action'] =
    netFlow > config.signals.whaleThresholdUsdt * 2
      ? 'accumulating'
      : netFlow < -config.signals.whaleThresholdUsdt * 2
      ? 'distributing'
      : 'neutral';

  const unusualActivity = Math.abs(netFlow) > config.signals.whaleThresholdUsdt * 3;

  return {
    pair, action, netFlow, dexInflow, dexOutflow, unusualActivity,
    timestamp: Date.now(),
  };
}

// ---- MEV / Front-running detection ----
const recentTradeSignatures = new Map<TradingPair, { price: number; qty: number; ts: number }[]>();

export function detectMEV(trade: AggregateTrade): MEVDetection | null {
  const sigs = recentTradeSignatures.get(trade.pair) ?? [];
  sigs.push({ price: trade.price, qty: trade.quantity, ts: trade.timestamp });
  if (sigs.length > 50) sigs.splice(0, sigs.length - 50);
  recentTradeSignatures.set(trade.pair, sigs);

  if (sigs.length < 3) return null;

  const last3 = sigs.slice(-3);
  const first = last3[0]!;
  const middle = last3[1]!;
  const last = last3[2]!;

  // Sandwich detection: small trade -> large trade -> small trade, all in same direction
  const timeDiff = last.ts - first.ts;
  if (timeDiff > 2000) return null; // Must be within 2 seconds

  const isSandwich =
    first.qty < middle.qty * 0.3 &&
    last.qty < middle.qty * 0.3 &&
    middle.qty * middle.price > config.signals.whaleThresholdUsdt * 0.5 &&
    Math.abs(last.price - first.price) / first.price > 0.001;

  if (isSandwich) {
    const profitEstimate = (last.price - first.price) * first.qty;
    log.warn({ pair: trade.pair, profitEstimate }, 'Sandwich attack detected');
    return {
      pair: trade.pair,
      type: 'sandwich',
      victimAmount: middle.qty * middle.price,
      profitEstimate: Math.abs(profitEstimate),
      confidence: 72,
      timestamp: Date.now(),
    };
  }

  // Front-running: large buy immediately before price jump
  const priceDiff = (last.price - first.price) / first.price;
  if (first.qty * first.price > config.signals.whaleThresholdUsdt && priceDiff > 0.002) {
    log.info({ pair: trade.pair, priceDiff }, 'Front-running pattern detected');
    return {
      pair: trade.pair,
      type: 'frontrun',
      victimAmount: middle.qty * middle.price,
      profitEstimate: priceDiff * first.qty * first.price,
      confidence: 60,
      timestamp: Date.now(),
    };
  }

  return null;
}

export async function getRecentWhaleActivity(pair: TradingPair): Promise<WhaleActivity[]> {
  try {
    const items = await redis.lrange(CacheKeys.whaleActivity(pair), 0, 9);
    return items.map((i) => JSON.parse(i) as WhaleActivity);
  } catch {
    return [];
  }
}
