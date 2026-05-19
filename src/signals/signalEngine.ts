import { EventEmitter } from 'events';
import { createLogger } from '../utils/logger';
import { marketDataService } from '../market/marketDataService';
import { confluenceEngine } from '../confluence/confluenceEngine';
import { reasoningEngine } from '../ai/reasoning/reasoningEngine';
import { marketRegimeEngine } from '../regime/marketRegimeEngine';
import { marketQualityEngine } from '../quality/marketQualityScore';
import { sessionFilter } from '../session/sessionFilter';
import { mtfAnalysis } from '../mtf/multiTimeframeAnalysis';
import { patienceEngine } from '../patience/patienceEngine';
import { consensusVoting } from '../consensus/consensusVoting';
import { strategyManager } from '../strategy/strategyModes';
import { frequencyLimiter } from '../strategy/frequencyLimiter';
import { redis, CacheKeys } from '../redis/client';
import { db } from '../database/connection';
import { config } from '../config';
import type { TradingSignal, TradingPair, Timeframe, Candle } from '../utils/types';
import type { NoTradeDecision, ConsensusResult } from '../utils/types2';

const log = createLogger('signal-engine-v2');

export interface EnrichedSignal extends TradingSignal {
  noTradeDecision?: NoTradeDecision;
  consensusResult?: ConsensusResult;
  regimeDescription?: string;
  qualityScore?: number;
  qualityGrade?: string;
  sessionName?: string;
  mtfAligned?: boolean;
  patienceApproved?: boolean;
  systemStatus?: string;
}

export class SignalEngine extends EventEmitter {
  private lastSignalTime = new Map<TradingPair, number>();
  private candleBuffers = new Map<string, Candle[]>();

  constructor() {
    super();
    this.setMaxListeners(50);
  }

  async onCandleClose(pair: TradingPair, timeframe: Timeframe, newCandle: Candle): Promise<void> {
    const key = `${pair}:${timeframe}`;
    const buffer = this.candleBuffers.get(key) ?? [];
    buffer.push(newCandle);
    if (buffer.length > 500) buffer.splice(0, buffer.length - 500);
    this.candleBuffers.set(key, buffer);

    // Log ALL candle close events (including non-primary TF)
    log.info({ pair, timeframe, bufferSize: buffer.length, isClosed: true }, '📊 Candle closed received');

    if (timeframe !== config.trading.defaultTimeframe) return;

    const minIntervalMs = config.signals.minSignalIntervalMinutes * 60 * 1000;
    const lastTime = this.lastSignalTime.get(pair) ?? 0;
    const elapsed = Date.now() - lastTime;
    if (elapsed < minIntervalMs) {
      log.info({ pair, elapsed: Math.round(elapsed / 1000), minInterval: config.signals.minSignalIntervalMinutes }, 'Skipped: too soon since last signal');
      return;
    }

    log.info({ pair, timeframe, candles: buffer.length }, '🚀 Evaluating signal...');
    await this.evaluateSignal(pair, timeframe, buffer);
  }

  async evaluateSignal(pair: TradingPair, timeframe: Timeframe, candles?: Candle[]): Promise<EnrichedSignal | null> {
    try {
      const mode = strategyManager.getMode();
      const modeConfig = strategyManager.getConfig();

      // Step 1: Frequency & cooldown check (fast path)
      const freqCheck = await frequencyLimiter.canTrade(mode);
      if (!freqCheck.allowed) {
        log.info({ pair, reason: freqCheck.reason }, 'Trade skipped: frequency limit');
        this.emitNoTrade(pair, 'frequency', freqCheck.reason);
        return null;
      }

      // Step 2: Get candles
      const candleData = candles ?? await marketDataService.fetchCandles(pair, timeframe, 300);
      if (candleData.length < 210) return null;

      // Step 3: Market regime analysis
      const regime = await marketRegimeEngine.analyze(pair, candleData);

      // Step 4: Session analysis
      const session = sessionFilter.getCurrentSession();

      // Step 5: Market quality score
      const quality = await marketQualityEngine.score(pair, candleData, regime, session);

      // Step 6: Regime and session hard gates
      if (!regime.tradingAllowed) {
        log.info({ pair, regime: regime.regime }, 'Trade skipped: regime blocks trading');
        this.emitNoTrade(pair, 'regime', regime.description);
        return null;
      }

      if (!session.tradingAllowed) {
        log.info({ pair, session: session.name }, 'Trade skipped: session blocks trading');
        this.emitNoTrade(pair, 'session', session.description);
        return null;
      }

      if (!strategyManager.isRegimeAllowed(regime.regime)) {
        const reason = `Regime '${regime.regime}' not allowed in ${mode} mode`;
        log.info({ pair, regime: regime.regime, mode }, 'Trade skipped: regime not in mode allowlist');
        this.emitNoTrade(pair, 'regime', reason);
        return null;
      }

      if (!strategyManager.isSessionAllowed(session.name)) {
        const reason = `Session '${session.name}' not allowed in ${mode} mode`;
        this.emitNoTrade(pair, 'session', reason);
        return null;
      }

      // Step 7: Quality gate
      if (quality.total < modeConfig.minMarketQuality) {
        const reason = `Market quality ${quality.total}/100 below ${modeConfig.minMarketQuality} for ${mode} mode`;
        log.info({ pair, quality: quality.total }, 'Trade skipped: quality gate');
        this.emitNoTrade(pair, 'quality', reason);
        return null;
      }

      // Step 8: Generate signal from confluence
      const signal = await confluenceEngine.buildSignal(pair, candleData, timeframe);
      if (!signal) return null;

      // Step 9: Confidence gate (mode-specific)
      if (signal.confidence < modeConfig.minConfidence) {
        const reason = `Confidence ${signal.confidence}% below minimum ${modeConfig.minConfidence}%`;
        log.info({ pair, confidence: signal.confidence }, 'Trade skipped: low confidence');
        this.emitNoTrade(pair, 'quality', reason);
        return null;
      }

      // Step 10: Multi-timeframe analysis
      const mtf = await mtfAnalysis.analyze(pair, mode, signal.direction);

      // Step 11: Patience engine evaluation
      const patience = patienceEngine.evaluate(signal, regime, quality, session, mtf, mode);
      if (!patience.shouldTrade) {
        log.info({ pair, reason: patience.reason, quality: patience.quality }, 'Trade skipped: patience engine');
        this.emitNoTrade(pair, 'patience', patience.reason);
        return null;
      }

      // Step 12: AI multi-agent validation
      const aiValidation = await reasoningEngine.validateSignal(signal);
      signal.aiValidation = aiValidation;

      // Step 13: Consensus voting
      const consensus = consensusVoting.vote(signal, regime, quality, mtf, session, mode);
      if (!consensus.tradingAllowed) {
        log.info({ pair, decision: consensus.finalDecision, score: consensus.consensusScore }, 'Trade skipped: consensus vote');
        this.emitNoTrade(pair, 'consensus', `Consensus: ${consensus.finalDecision} (${consensus.consensusScore}/100)`);
        return null;
      }

      // Step 14: Consensus score gate
      if (consensus.consensusScore < modeConfig.minConsensusScore) {
        const reason = `Consensus ${consensus.consensusScore}/100 below ${modeConfig.minConsensusScore} for ${mode} mode`;
        this.emitNoTrade(pair, 'consensus', reason);
        return null;
      }

      // Step 15: RR gate (mode-specific)
      if (signal.riskReward < modeConfig.minRR) {
        const reason = `RR ${signal.riskReward.toFixed(2)}:1 below ${modeConfig.minRR}:1 for ${mode} mode`;
        this.emitNoTrade(pair, 'risk', reason);
        return null;
      }

      // ---- ALL GATES PASSED — Signal approved ----
      const enriched: EnrichedSignal = {
        ...signal,
        consensusResult: consensus,
        regimeDescription: regime.description,
        qualityScore: quality.total,
        qualityGrade: quality.grade,
        sessionName: session.name,
        mtfAligned: mtf.overallAligned,
        patienceApproved: patience.shouldTrade,
        systemStatus: 'trading',
      };

      await this.persistSignal(enriched);
      await redis.setJson(CacheKeys.signal(pair), enriched, 3600);
      this.lastSignalTime.set(pair, Date.now());

      log.info({
        pair,
        direction: signal.direction,
        confidence: signal.confidence,
        consensus: consensus.consensusScore,
        quality: quality.total,
        regime: regime.regime,
        session: session.name,
        rr: signal.riskReward.toFixed(2),
        mode,
      }, '✅ SIGNAL APPROVED — All filters passed');

      this.emit('signal', enriched);
      return enriched;

    } catch (err) {
      log.error({ err, pair }, 'Signal evaluation error');
      return null;
    }
  }

  private emitNoTrade(pair: TradingPair, category: NoTradeDecision['category'], reason: string): void {
    const decision: NoTradeDecision = {
      shouldSkip: true,
      reasons: [reason],
      primaryReason: reason,
      category,
      resumeCondition: `Resolve: ${reason}`,
    };
    this.emit('no_trade', { pair, decision });
  }

  async getLatestSignal(pair: TradingPair): Promise<EnrichedSignal | null> {
    return redis.getJson<EnrichedSignal>(CacheKeys.signal(pair));
  }

  async getAllLatestSignals(): Promise<EnrichedSignal[]> {
    const signals: EnrichedSignal[] = [];
    for (const pair of config.trading.pairs as TradingPair[]) {
      const s = await this.getLatestSignal(pair);
      if (s) signals.push(s);
    }
    return signals;
  }

  async initializeBuffers(): Promise<void> {
    log.info('Initializing candle buffers...');
    await strategyManager.initialize();
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

  private async persistSignal(signal: EnrichedSignal): Promise<void> {
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
