import { EventEmitter } from 'events';
import { createLogger } from '../utils/logger';
import { marketDataService } from '../market/marketDataService';
import { confluenceEngine } from '../confluence/confluenceEngine';
import { reasoningEngine } from '../ai/reasoning/reasoningEngine';
import { redis, CacheKeys } from '../redis/client';
import { db } from '../database/connection';
import { config } from '../config';
import type { TradingSignal, TradingPair, Timeframe, Candle } from '../utils/types';

const log = createLogger('signal-engine');

export class SignalEngine extends EventEmitter {
  private lastSignalTime = new Map<TradingPair, number>();
  private candleBuffers = new Map<string, Candle[]>();

  constructor() {
    super();
    this.setMaxListeners(50);
  }

  // Called by WebSocket handler when a candle closes
  async onCandleClose(pair: TradingPair, timeframe: Timeframe, newCandle: Candle): Promise<void> {
    const key = `${pair}:${timeframe}`;
    const buffer = this.candleBuffers.get(key) ?? [];

    buffer.push(newCandle);
    if (buffer.length > 500) buffer.splice(0, buffer.length - 500);
    this.candleBuffers.set(key, buffer);

    // Only process on primary timeframe
    if (timeframe !== config.trading.defaultTimeframe) return;

    // Rate limit: minimum interval between signals
    const minIntervalMs = config.signals.minSignalIntervalMinutes * 60 * 1000;
    const lastTime = this.lastSignalTime.get(pair) ?? 0;
    if (Date.now() - lastTime < minIntervalMs) return;

    await this.evaluateSignal(pair, timeframe, buffer);
  }

  async evaluateSignal(pair: TradingPair, timeframe: Timeframe, candles?: Candle[]): Promise<TradingSignal | null> {
    try {
      // Use provided candles or fetch fresh ones
      const candleData = candles ?? await marketDataService.fetchCandles(pair, timeframe, 300);

      if (candleData.length < 210) {
        log.debug({ pair, count: candleData.length }, 'Not enough candles for signal evaluation');
        return null;
      }

      // Build signal from confluence engine
      const signal = await confluenceEngine.buildSignal(pair, candleData, timeframe);
      if (!signal) return null;

      // Confidence gate
      if (signal.confidence < config.signals.minConfidenceScore) {
        log.debug({ pair, confidence: signal.confidence }, 'Signal below confidence threshold');
        return null;
      }

      // AI validation
      const aiValidation = await reasoningEngine.validateSignal(signal);
      signal.aiValidation = aiValidation;

      // AI veto: if AI marks invalid AND confidence is low, skip
      if (!aiValidation.isValid && signal.confidence < 75) {
        log.info({ pair, aiConfidence: aiValidation.confidence }, 'Signal rejected by AI validation');
        return null;
      }

      // Persist signal to DB
      await this.persistSignal(signal);

      // Cache latest signal per pair
      await redis.setJson(CacheKeys.signal(pair), signal, 3600);

      // Update last signal time
      this.lastSignalTime.set(pair, Date.now());

      log.info({
        pair,
        direction: signal.direction,
        confidence: signal.confidence,
        strength: signal.strength,
        entry: signal.entry.toFixed(2),
        sl: signal.stopLoss.toFixed(2),
        tp: signal.takeProfit.toFixed(2),
        rr: signal.riskReward.toFixed(2),
      }, 'Signal generated');

      this.emit('signal', signal);
      return signal;
    } catch (err) {
      log.error({ err, pair }, 'Signal evaluation failed');
      return null;
    }
  }

  async getLatestSignal(pair: TradingPair): Promise<TradingSignal | null> {
    return redis.getJson<TradingSignal>(CacheKeys.signal(pair));
  }

  async getAllLatestSignals(): Promise<TradingSignal[]> {
    const signals: TradingSignal[] = [];
    for (const pair of config.trading.pairs as TradingPair[]) {
      const s = await this.getLatestSignal(pair);
      if (s) signals.push(s);
    }
    return signals;
  }

  async initializeBuffers(): Promise<void> {
    log.info('Initializing candle buffers...');
    for (const pair of config.trading.pairs as TradingPair[]) {
      for (const tf of [config.trading.defaultTimeframe, config.trading.secondaryTimeframe] as Timeframe[]) {
        const candles = await marketDataService.fetchCandles(pair, tf, 300);
        this.candleBuffers.set(`${pair}:${tf}`, candles);
        log.info({ pair, tf, count: candles.length }, 'Buffer initialized');
      }
    }
  }

  getBuffer(pair: TradingPair, timeframe: Timeframe): Candle[] {
    return this.candleBuffers.get(`${pair}:${timeframe}`) ?? [];
  }

  private async persistSignal(signal: TradingSignal): Promise<void> {
    await db.query(
      `INSERT INTO signals (id,pair,direction,confidence,buy_score,sell_score,strength,
       entry,stop_loss,take_profit,risk_reward,reasons,indicators,volume_analysis,
       pattern_analysis,ai_validation,timeframe,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       ON CONFLICT (id) DO NOTHING`,
      [
        signal.id, signal.pair, signal.direction, signal.confidence,
        signal.buyScore, signal.sellScore, signal.strength, signal.entry,
        signal.stopLoss, signal.takeProfit, signal.riskReward,
        JSON.stringify(signal.reasons), JSON.stringify(signal.indicators),
        JSON.stringify(signal.volumeAnalysis), JSON.stringify(signal.patternAnalysis),
        signal.aiValidation ? JSON.stringify(signal.aiValidation) : null,
        signal.timeframe, signal.expiresAt,
      ],
    ).catch((err) => log.warn({ err }, 'Failed to persist signal'));
  }
}

export const signalEngine = new SignalEngine();
