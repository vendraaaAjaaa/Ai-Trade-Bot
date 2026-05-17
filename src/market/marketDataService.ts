import axios from 'axios';
import { config } from '../config';
import { createLogger } from '../utils/logger';
import { redis, CacheKeys } from '../redis/client';
import { db } from '../database/connection';
import type { Candle, TradingPair, Timeframe, FundingRate } from '../utils/types';

const log = createLogger('market');

interface BinanceKline {
  0: number; 1: string; 2: string; 3: string; 4: string; 5: string;
  6: number; 7: string; 8: number; 9: string; 10: string;
}

export class MarketDataService {
  private baseUrl: string;

  constructor() {
    this.baseUrl = config.binance.testnet
      ? config.binance.testnetFuturesUrl
      : config.binance.futuresBaseUrl;
  }

  async fetchCandles(pair: TradingPair, timeframe: Timeframe, limit = 500): Promise<Candle[]> {
    const cacheKey = CacheKeys.candles(pair, timeframe);
    const cached = await redis.lrange(cacheKey, 0, limit - 1);

    if (cached.length >= limit * 0.8) {
      return cached
        .map((c) => JSON.parse(c) as Candle)
        .sort((a, b) => a.openTime - b.openTime);
    }

    return this.fetchFromBinance(pair, timeframe, limit);
  }

  async fetchFromBinance(pair: TradingPair, timeframe: Timeframe, limit = 500): Promise<Candle[]> {
    try {
      const url = `${this.baseUrl}/fapi/v1/klines`;
      const response = await axios.get<BinanceKline[]>(url, {
        params: { symbol: pair, interval: timeframe, limit },
        timeout: 10000,
      });

      const candles: Candle[] = response.data.map((k) => ({
        openTime: k[0],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
        closeTime: k[6],
        quoteVolume: parseFloat(k[7]),
        trades: k[8],
        takerBuyVolume: parseFloat(k[9]),
        takerSellVolume: parseFloat(k[5]) - parseFloat(k[9]),
      }));

      // Cache and persist
      await this.cacheCandles(pair, timeframe, candles);
      await this.persistCandles(pair, timeframe, candles);

      log.info({ pair, timeframe, count: candles.length }, 'Fetched candles from Binance');
      return candles;
    } catch (err) {
      log.error({ err, pair, timeframe }, 'Failed to fetch candles from Binance');
      return this.fetchFromDatabase(pair, timeframe, limit);
    }
  }

  private async cacheCandles(pair: TradingPair, tf: Timeframe, candles: Candle[]): Promise<void> {
    const key = CacheKeys.candles(pair, tf);
    const pipeline = redis.getClient().pipeline();
    pipeline.del(key);
    for (const c of [...candles].reverse()) {
      pipeline.lpush(key, JSON.stringify(c));
    }
    pipeline.ltrim(key, 0, 499);
    pipeline.expire(key, 86400);
    await pipeline.exec();
  }

  private async persistCandles(pair: TradingPair, tf: Timeframe, candles: Candle[]): Promise<void> {
    if (candles.length === 0) return;
    const values = candles
      .map(
        (c) =>
          `('${pair}','${tf}',${c.openTime},${c.open},${c.high},${c.low},${c.close},${c.volume},${c.closeTime},${c.quoteVolume},${c.trades},${c.takerBuyVolume},${c.takerSellVolume})`,
      )
      .join(',');

    await db
      .query(
        `INSERT INTO candles (pair,timeframe,open_time,open,high,low,close,volume,close_time,
         quote_volume,trades,taker_buy_volume,taker_sell_volume) VALUES ${values}
         ON CONFLICT (pair,timeframe,open_time) DO UPDATE SET
         close=EXCLUDED.close, high=EXCLUDED.high, low=EXCLUDED.low, volume=EXCLUDED.volume`,
      )
      .catch((err) => log.warn({ err }, 'Failed to persist candles'));
  }

  private async fetchFromDatabase(pair: TradingPair, tf: Timeframe, limit: number): Promise<Candle[]> {
    const rows = await db.query<{
      open_time: string; open: string; high: string; low: string; close: string;
      volume: string; close_time: string; quote_volume: string; trades: number;
      taker_buy_volume: string; taker_sell_volume: string;
    }>(
      `SELECT * FROM candles WHERE pair=$1 AND timeframe=$2 ORDER BY open_time DESC LIMIT $3`,
      [pair, tf, limit],
    );

    return rows.map((r) => ({
      openTime: parseInt(r.open_time),
      open: parseFloat(r.open),
      high: parseFloat(r.high),
      low: parseFloat(r.low),
      close: parseFloat(r.close),
      volume: parseFloat(r.volume),
      closeTime: parseInt(r.close_time),
      quoteVolume: parseFloat(r.quote_volume),
      trades: r.trades,
      takerBuyVolume: parseFloat(r.taker_buy_volume),
      takerSellVolume: parseFloat(r.taker_sell_volume),
    })).reverse();
  }

  async getCurrentPrice(pair: TradingPair): Promise<number> {
    try {
      const ticker = await redis.getJson<{ price: number }>(CacheKeys.ticker(pair));
      if (ticker) return ticker.price;

      const url = `${this.baseUrl}/fapi/v1/ticker/price`;
      const res = await axios.get<{ price: string }>(url, {
        params: { symbol: pair },
        timeout: 5000,
      });
      return parseFloat(res.data.price);
    } catch (err) {
      log.error({ err, pair }, 'Failed to get current price');
      throw err;
    }
  }

  async getFundingRate(pair: TradingPair): Promise<FundingRate> {
    try {
      const url = `${this.baseUrl}/fapi/v1/fundingRate`;
      const res = await axios.get<{ fundingRate: string; nextFundingTime: number }[]>(url, {
        params: { symbol: pair, limit: 1 },
        timeout: 5000,
      });

      const data = res.data[0];
      const rate = parseFloat(data?.fundingRate || '0');
      return {
        pair,
        rate,
        nextFundingTime: data?.nextFundingTime || 0,
        isNegative: rate < 0,
        isExtreme: Math.abs(rate) > 0.001,
      };
    } catch (err) {
      log.warn({ err, pair }, 'Failed to get funding rate');
      return { pair, rate: 0, nextFundingTime: 0, isNegative: false, isExtreme: false };
    }
  }

  async getHistoricalCandles(
    pair: TradingPair,
    timeframe: Timeframe,
    startTime: number,
    endTime: number,
  ): Promise<Candle[]> {
    const allCandles: Candle[] = [];
    let currentStart = startTime;
    const limitPerRequest = 500;

    while (currentStart < endTime) {
      try {
        const url = `${this.baseUrl}/fapi/v1/klines`;
        const response = await axios.get<BinanceKline[]>(url, {
          params: {
            symbol: pair,
            interval: timeframe,
            startTime: currentStart,
            endTime,
            limit: limitPerRequest,
          },
          timeout: 15000,
        });

        if (!response.data.length) break;

        const batch: Candle[] = response.data.map((k) => ({
          openTime: k[0],
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5]),
          closeTime: k[6],
          quoteVolume: parseFloat(k[7]),
          trades: k[8],
          takerBuyVolume: parseFloat(k[9]),
          takerSellVolume: parseFloat(k[5]) - parseFloat(k[9]),
        }));

        allCandles.push(...batch);
        const lastCandle = batch[batch.length - 1];
        if (!lastCandle) break;
        currentStart = lastCandle.closeTime + 1;

        // Rate limit respect
        await new Promise((r) => setTimeout(r, 100));
      } catch (err) {
        log.error({ err }, 'Failed to fetch historical candles batch');
        break;
      }
    }

    log.info({ pair, timeframe, count: allCandles.length }, 'Fetched historical candles');
    return allCandles;
  }
}

export const marketDataService = new MarketDataService();
