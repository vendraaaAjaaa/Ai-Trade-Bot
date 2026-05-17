import type { Candle, VolumeSnapshot, AggregateTrade, TradingPair } from '../utils/types';
import { createLogger } from '../utils/logger';
import { config } from '../config';

const log = createLogger('volume');

interface TradeBuffer {
  trades: AggregateTrade[];
  buyVolume: number;
  sellVolume: number;
  lastUpdate: number;
}

const tradeBuffers = new Map<TradingPair, TradeBuffer>();

export function updateTradeBuffer(trade: AggregateTrade): void {
  const buf = tradeBuffers.get(trade.pair) ?? {
    trades: [],
    buyVolume: 0,
    sellVolume: 0,
    lastUpdate: 0,
  };

  buf.trades.push(trade);
  if (trade.side === 'BUY') buf.buyVolume += trade.quantity;
  else buf.sellVolume += trade.quantity;
  buf.lastUpdate = trade.timestamp;

  // Keep last 1000 trades
  if (buf.trades.length > 1000) {
    const removed = buf.trades.splice(0, buf.trades.length - 1000);
    for (const t of removed) {
      if (t.side === 'BUY') buf.buyVolume -= t.quantity;
      else buf.sellVolume -= t.quantity;
    }
  }

  tradeBuffers.set(trade.pair, buf);
}

export function analyzeVolume(pair: TradingPair, candles: Candle[]): VolumeSnapshot {
  if (candles.length < 20) {
    return buildEmptySnapshot();
  }

  const recent = candles.slice(-20);
  const current = candles[candles.length - 1]!;

  // Average volume of last 20 candles (excluding current)
  const avgVolume = recent.slice(0, -1).reduce((s, c) => s + c.volume, 0) / 19;
  const volumeRatio = avgVolume > 0 ? current.volume / avgVolume : 1;
  const isVolumeSpike = volumeRatio >= config.signals.volumeSpikeMultiplier;

  // Delta volume (buy - sell pressure in candle)
  const deltaVolume = current.takerBuyVolume - current.takerSellVolume;
  const buyVolume = current.takerBuyVolume;
  const sellVolume = current.takerSellVolume;
  const totalVolume = buyVolume + sellVolume;
  const buyPressure = totalVolume > 0 ? (buyVolume / totalVolume) * 100 : 50;
  const imbalancePercent = Math.abs(buyPressure - 50) * 2;

  // Trade buffer analysis
  const buf = tradeBuffers.get(pair);
  const bufBuy = buf?.buyVolume ?? buyVolume;
  const bufSell = buf?.sellVolume ?? sellVolume;
  const aggressiveBuys = bufBuy;
  const aggressiveSells = bufSell;

  // Absorption detection: large volume but small price move
  const priceRange = current.high - current.low;
  const isAbsorption = isVolumeSpike && priceRange < (current.close * 0.002);

  // Liquidity sweep: price breaks key level then reverses
  const isLiquiditySweep = detectLiquiditySweep(candles);

  // Whale activity detection
  const whaleThreshold = config.signals.whaleThresholdUsdt;
  const currentVolumeUsdt = current.volume * current.close;
  const isWhaleActivity = currentVolumeUsdt >= whaleThreshold && isVolumeSpike;

  // Spoofing detection (large order appears then vanishes — inferred from volume patterns)
  const isSpoofing = detectSpoofing(candles);

  log.debug({
    pair, volumeRatio: volumeRatio.toFixed(2), isVolumeSpike, isWhaleActivity,
  }, 'Volume analysis');

  return {
    currentVolume: current.volume,
    avgVolume,
    volumeRatio,
    isVolumeSpike,
    deltaVolume,
    buyVolume,
    sellVolume,
    buyPressure,
    isAbsorption,
    isLiquiditySweep,
    isWhaleActivity,
    isSpoofing,
    aggressiveBuys,
    aggressiveSells,
    imbalancePercent,
  };
}

function detectLiquiditySweep(candles: Candle[]): boolean {
  if (candles.length < 10) return false;
  const recent = candles.slice(-10);
  const current = recent[recent.length - 1]!;
  const prev = recent.slice(0, -1);

  // Find recent swing high and low
  const swingHigh = Math.max(...prev.map((c) => c.high));
  const swingLow = Math.min(...prev.map((c) => c.low));

  // Price swept above swing high then closed below it
  const upwardSweep =
    current.high > swingHigh && current.close < swingHigh && current.close < current.open;

  // Price swept below swing low then closed above it
  const downwardSweep =
    current.low < swingLow && current.close > swingLow && current.close > current.open;

  return upwardSweep || downwardSweep;
}

function detectSpoofing(candles: Candle[]): boolean {
  if (candles.length < 5) return false;
  const last5 = candles.slice(-5);

  // Spoofing indicator: sudden high-volume candle with very long wicks
  // suggesting fake orders that got cancelled
  let spoofCount = 0;
  for (const c of last5) {
    const body = Math.abs(c.close - c.open);
    const totalRange = c.high - c.low;
    const wickRatio = totalRange > 0 ? body / totalRange : 1;
    if (c.volume > 0 && wickRatio < 0.3) spoofCount++;
  }

  return spoofCount >= 3;
}

export function detectBuySellImbalance(candles: Candle[], threshold = 65): {
  hasBuyImbalance: boolean;
  hasSellImbalance: boolean;
  buyPressureAvg: number;
} {
  const recent = candles.slice(-10);
  if (recent.length === 0) return { hasBuyImbalance: false, hasSellImbalance: false, buyPressureAvg: 50 };

  const pressures = recent.map((c) => {
    const total = c.takerBuyVolume + c.takerSellVolume;
    return total > 0 ? (c.takerBuyVolume / total) * 100 : 50;
  });

  const buyPressureAvg = pressures.reduce((a, b) => a + b, 0) / pressures.length;
  return {
    hasBuyImbalance: buyPressureAvg >= threshold,
    hasSellImbalance: buyPressureAvg <= 100 - threshold,
    buyPressureAvg,
  };
}

function buildEmptySnapshot(): VolumeSnapshot {
  return {
    currentVolume: 0, avgVolume: 0, volumeRatio: 1, isVolumeSpike: false,
    deltaVolume: 0, buyVolume: 0, sellVolume: 0, buyPressure: 50,
    isAbsorption: false, isLiquiditySweep: false, isWhaleActivity: false,
    isSpoofing: false, aggressiveBuys: 0, aggressiveSells: 0, imbalancePercent: 0,
  };
}
