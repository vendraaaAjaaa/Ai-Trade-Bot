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
import {
  generateEntryReport,
  recordRejection,
  recordExecution,
} from '../telemetry/signalTelemetry';
import {
  signalScoreEngine,
  SignalScoreEngine,
  USE_SCORING_ENGINE,
} from '../scoring/SignalScoreEngine';
import type { TradingSignal, TradingPair, Timeframe, Candle } from '../utils/types';
import type { NoTradeDecision, ConsensusResult } from '../utils/types2';
import type { FilterCheckResult } from '../telemetry/types';

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

      // Telemetry: accumulate filter check results as we proceed
      const checks: FilterCheckResult[] = [];

      // ─────────────────────────────────────────────────────────
      // Step 1: Frequency & cooldown check (fast path)
      // ─────────────────────────────────────────────────────────
      const freqCheck = await frequencyLimiter.canTrade(mode);
      checks.push({
        name: 'Frequency',
        result: freqCheck.allowed ? 'PASS' : 'FAIL',
        detail: freqCheck.allowed ? undefined : freqCheck.reason,
      });
      if (!freqCheck.allowed) {
        log.info({ pair, reason: freqCheck.reason }, 'Trade skipped: frequency limit');
        generateEntryReport(pair, mode, checks, { approved: false });
        await recordRejection('frequency');
        this.emitNoTrade(pair, 'frequency', freqCheck.reason);
        return null;
      }

      // ─────────────────────────────────────────────────────────
      // Step 2: Get candles
      // ─────────────────────────────────────────────────────────
      const candleData = candles ?? await marketDataService.fetchCandles(pair, timeframe, 300);
      if (candleData.length < 210) return null;

      // ─────────────────────────────────────────────────────────
      // Step 3: Market regime analysis
      // ─────────────────────────────────────────────────────────
      const regime = await marketRegimeEngine.analyze(pair, candleData);

      // ─────────────────────────────────────────────────────────
      // Step 4: Session analysis
      // ─────────────────────────────────────────────────────────
      const session = sessionFilter.getCurrentSession();

      // ─────────────────────────────────────────────────────────
      // Step 5: Market quality score
      // ─────────────────────────────────────────────────────────
      const quality = await marketQualityEngine.score(pair, candleData, regime, session);

      // ─────────────────────────────────────────────────────────
      // Step 6: Regime and session hard gates
      // ─────────────────────────────────────────────────────────
      const regimeGlobalOk = regime.tradingAllowed;
      checks.push({
        name: 'Regime',
        result: regimeGlobalOk ? 'PASS' : 'FAIL',
        detail: regimeGlobalOk ? undefined : regime.description,
      });
      if (!regimeGlobalOk) {
        log.info({ pair, regime: regime.regime }, 'Trade skipped: regime blocks trading');
        generateEntryReport(pair, mode, checks, { approved: false });
        await recordRejection('regime');
        this.emitNoTrade(pair, 'regime', regime.description);
        return null;
      }

      const sessionGlobalOk = session.tradingAllowed;
      checks.push({
        name: 'Session',
        result: sessionGlobalOk ? 'PASS' : 'FAIL',
        detail: sessionGlobalOk ? undefined : session.description,
      });
      if (!sessionGlobalOk) {
        log.info({ pair, session: session.name }, 'Trade skipped: session blocks trading');
        generateEntryReport(pair, mode, checks, { approved: false });
        await recordRejection('session');
        this.emitNoTrade(pair, 'session', session.description);
        return null;
      }

      const regimeModeOk = strategyManager.isRegimeAllowed(regime.regime);
      if (!regimeModeOk) {
        const reason = `Regime '${regime.regime}' not allowed in ${mode} mode`;
        checks.push({ name: 'RegimeMode', result: 'FAIL', detail: reason });
        log.info({ pair, regime: regime.regime, mode }, 'Trade skipped: regime not in mode allowlist');
        generateEntryReport(pair, mode, checks, { approved: false });
        await recordRejection('regime');
        this.emitNoTrade(pair, 'regime', reason);
        return null;
      }
      checks.push({ name: 'RegimeMode', result: 'PASS' });

      const sessionModeOk = strategyManager.isSessionAllowed(session.name);
      if (!sessionModeOk) {
        const reason = `Session '${session.name}' not allowed in ${mode} mode`;
        checks.push({ name: 'SessionMode', result: 'FAIL', detail: reason });
        generateEntryReport(pair, mode, checks, { approved: false });
        await recordRejection('session');
        this.emitNoTrade(pair, 'session', reason);
        return null;
      }
      checks.push({ name: 'SessionMode', result: 'PASS' });

      // ─────────────────────────────────────────────────────────
      // Step 7: Quality gate
      // ─────────────────────────────────────────────────────────
      const qualityOk = quality.total >= modeConfig.minMarketQuality;
      checks.push({
        name: 'Quality',
        result: qualityOk ? 'PASS' : 'FAIL',
        value: quality.total,
        threshold: modeConfig.minMarketQuality,
        detail: qualityOk ? undefined : `${quality.total} < ${modeConfig.minMarketQuality}`,
      });
      if (!qualityOk) {
        const reason = `Market quality ${quality.total}/100 below ${modeConfig.minMarketQuality} for ${mode} mode`;
        log.info({ pair, quality: quality.total }, 'Trade skipped: quality gate');
        generateEntryReport(pair, mode, checks, { approved: false });
        await recordRejection('quality');
        this.emitNoTrade(pair, 'quality', reason);
        return null;
      }

      // ─────────────────────────────────────────────────────────
      // Step 8: Generate signal from confluence
      // ─────────────────────────────────────────────────────────
      const signal = await confluenceEngine.buildSignal(pair, candleData, timeframe);
      if (!signal) return null;

      // ─────────────────────────────────────────────────────────
      // Step 9: Confidence gate (mode-specific)
      // ─────────────────────────────────────────────────────────
      const confOk = signal.confidence >= modeConfig.minConfidence;
      checks.push({
        name: 'Confidence',
        result: confOk ? 'PASS' : 'FAIL',
        value: signal.confidence,
        threshold: modeConfig.minConfidence,
        detail: confOk ? undefined : `${signal.confidence} < ${modeConfig.minConfidence}`,
      });
      if (!confOk) {
        const reason = `Confidence ${signal.confidence}% below minimum ${modeConfig.minConfidence}%`;
        log.info({ pair, confidence: signal.confidence }, 'Trade skipped: low confidence');
        generateEntryReport(pair, mode, checks, { approved: false, direction: signal.direction, confidence: signal.confidence });
        await recordRejection('confidence');
        this.emitNoTrade(pair, 'quality', reason);
        return null;
      }

      // ─────────────────────────────────────────────────────────
      // Step 10: Multi-timeframe analysis
      // ─────────────────────────────────────────────────────────
      const mtf = await mtfAnalysis.analyze(pair, mode, signal.direction);
      checks.push({
        name: 'MTF',
        result: mtf.overallAligned ? 'PASS' : 'FAIL',
        value: mtf.alignmentScore,
        detail: mtf.overallAligned ? undefined : (mtf.rejectionReason ?? 'MTF alignment incomplete'),
      });

      // ─────────────────────────────────────────────────────────
      // Step 11: Patience engine evaluation
      // ─────────────────────────────────────────────────────────
      const patience = patienceEngine.evaluate(signal, regime, quality, session, mtf, mode);
      checks.push({
        name: 'Patience',
        result: patience.shouldTrade ? 'PASS' : 'FAIL',
        detail: patience.shouldTrade ? undefined : patience.reason,
      });
      if (!patience.shouldTrade) {
        log.info({ pair, reason: patience.reason, quality: patience.quality }, 'Trade skipped: patience engine');
        generateEntryReport(pair, mode, checks, { approved: false, direction: signal.direction, confidence: signal.confidence });
        await recordRejection('patience');
        this.emitNoTrade(pair, 'patience', patience.reason);
        return null;
      }

      // ─────────────────────────────────────────────────────────
      // Step 12: AI multi-agent validation
      // ─────────────────────────────────────────────────────────
      const aiValidation = await reasoningEngine.validateSignal(signal);
      signal.aiValidation = aiValidation;

      // ─────────────────────────────────────────────────────────
      // Step 13: Consensus voting
      // ─────────────────────────────────────────────────────────
      const consensus = consensusVoting.vote(signal, regime, quality, mtf, session, mode);
      const consensusDirectionOk = consensus.tradingAllowed;
      checks.push({
        name: 'Consensus',
        result: consensusDirectionOk ? 'PASS' : 'FAIL',
        value: consensus.consensusScore,
        detail: consensusDirectionOk ? undefined : `${consensus.finalDecision} (${consensus.consensusScore}/100)`,
      });
      if (!consensusDirectionOk) {
        log.info({ pair, decision: consensus.finalDecision, score: consensus.consensusScore }, 'Trade skipped: consensus vote');
        generateEntryReport(pair, mode, checks, { approved: false, direction: signal.direction, confidence: signal.confidence, consensusScore: consensus.consensusScore });
        await recordRejection('consensus');
        this.emitNoTrade(pair, 'consensus', `Consensus: ${consensus.finalDecision} (${consensus.consensusScore}/100)`);
        return null;
      }

      // ─────────────────────────────────────────────────────────
      // Step 14: Consensus score gate
      // ─────────────────────────────────────────────────────────
      const consensusScoreOk = consensus.consensusScore >= modeConfig.minConsensusScore;
      if (!consensusScoreOk) {
        const reason = `Consensus ${consensus.consensusScore}/100 below ${modeConfig.minConsensusScore} for ${mode} mode`;
        checks.push({ name: 'ConsensusScore', result: 'FAIL', value: consensus.consensusScore, threshold: modeConfig.minConsensusScore, detail: reason });
        generateEntryReport(pair, mode, checks, { approved: false, direction: signal.direction, confidence: signal.confidence, consensusScore: consensus.consensusScore });
        await recordRejection('consensus');
        this.emitNoTrade(pair, 'consensus', reason);
        return null;
      }
      checks.push({ name: 'ConsensusScore', result: 'PASS', value: consensus.consensusScore, threshold: modeConfig.minConsensusScore });

      // ─────────────────────────────────────────────────────────
      // Step 15: RR gate (mode-specific)
      // ─────────────────────────────────────────────────────────
      const rrOk = signal.riskReward >= modeConfig.minRR;
      checks.push({
        name: 'RiskReward',
        result: rrOk ? 'PASS' : 'FAIL',
        value: signal.riskReward,
        threshold: modeConfig.minRR,
        detail: rrOk ? undefined : `${signal.riskReward.toFixed(2)} < ${modeConfig.minRR}`,
      });
      if (!rrOk) {
        const reason = `RR ${signal.riskReward.toFixed(2)}:1 below ${modeConfig.minRR}:1 for ${mode} mode`;
        generateEntryReport(pair, mode, checks, { approved: false, direction: signal.direction, confidence: signal.confidence, consensusScore: consensus.consensusScore });
        await recordRejection('rr');
        this.emitNoTrade(pair, 'risk', reason);
        return null;
      }

      // ─────────────────────────────────────────────────────────
      // ─────────────────────────────────────────────────────────
      // Phase 7: Shadow scoring engine — runs in parallel for comparison.
      // Does NOT affect trade decisions until USE_SCORING_ENGINE=true.
      // ─────────────────────────────────────────────────────────
      try {
        const scoreCtx = SignalScoreEngine.buildContext({
          mode,
          confidence:       signal.confidence,
          consensusScore:   consensus.consensusScore,
          qualityScore:     quality.total,
          riskReward:       signal.riskReward,
          mtfAlignmentScore: mtf.alignmentScore,
          regime:           regime.regime,
          isManipulative:   regime.isManipulative,
          isChoppy:         regime.isChoppy,
          isFakeBreakout:   signal.patternAnalysis?.isFakeBreakout ?? false,
          isSpoofing:       signal.volumeAnalysis?.isSpoofing ?? false,
          sessionAllowed:   session.tradingAllowed,
          regimeAllowed:    regime.tradingAllowed,
          direction:        signal.direction,
        });
        await signalScoreEngine.evaluate(scoreCtx);
      } catch (scoreErr) {
        // Shadow mode — scoring errors never block a trade
        log.warn({ scoreErr }, '[Phase7] Shadow score engine error — non-critical');
      }

      // ✅ ALL GATES PASSED — Signal approved
      // ─────────────────────────────────────────────────────────
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

      // Telemetry: record approved signal
      generateEntryReport(pair, mode, checks, {
        approved: true,
        direction: signal.direction,
        confidence: signal.confidence,
        consensusScore: consensus.consensusScore,
      });
      await recordExecution(signal.confidence, consensus.consensusScore);

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
