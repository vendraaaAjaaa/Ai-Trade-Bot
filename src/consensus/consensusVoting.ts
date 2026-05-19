import type { TradingSignal } from '../utils/types';
import type {
  ConsensusResult, AgentVote, VoteDecision,
  RegimeAnalysis, MarketQualityScore, MTFAnalysis, SessionInfo, StrategyMode,
} from '../utils/types2';
import { createLogger } from '../utils/logger';

const log = createLogger('consensus');

export class ConsensusVotingSystem {

  vote(
    signal: TradingSignal,
    regime: RegimeAnalysis,
    quality: MarketQualityScore,
    mtf: MTFAnalysis,
    session: SessionInfo,
    mode: StrategyMode,
  ): ConsensusResult {
    const votes: AgentVote[] = [];

    // ---- Volume Agent Vote ----
    votes.push(this.volumeVote(signal));

    // ---- Pattern Agent Vote ----
    votes.push(this.patternVote(signal));

    // ---- Indicator Agent Vote ----
    votes.push(this.indicatorVote(signal));

    // ---- MEV Agent Vote ----
    votes.push(this.mevVote(signal));

    // ---- Risk Agent Vote ----
    votes.push(this.riskVote(signal, mode));

    // ---- Regime Agent Vote ----
    votes.push(this.regimeVote(regime, session));

    // ---- Patience Agent Vote ----
    votes.push(this.patienceVote(quality, mtf, mode, signal.direction));

    // ---- Tally ----
    const direction = signal.direction;
    const directionVote: VoteDecision = direction === 'LONG' ? 'BUY' : 'SELL';

    const buyVotes    = votes.filter((v) => v.vote === 'BUY').length;
    const sellVotes   = votes.filter((v) => v.vote === 'SELL').length;
    const waitVotes   = votes.filter((v) => v.vote === 'WAIT').length;
    const noTrades    = votes.filter((v) => v.vote === 'NO_TRADE').length;
    const vetoCount   = votes.filter((v) => v.isVeto).length;

    // Hard veto: any single veto kills the trade
    if (vetoCount > 0) {
      const vetoAgents = votes.filter((v) => v.isVeto).map((v) => `${v.agentName}: ${v.reason}`).join('; ');
      return this.buildResult('NO_TRADE', votes, buyVotes, sellVotes, waitVotes, vetoCount, 0,
        false, `VETOED by: ${vetoAgents}`);
    }

    // No trade if majority says no
    if (noTrades >= 3) {
      return this.buildResult('NO_TRADE', votes, buyVotes, sellVotes, waitVotes, vetoCount, 0,
        false, `${noTrades}/7 agents voted NO_TRADE`);
    }

    // Trade requires at least 4/7 in signal direction
    const directionCount = direction === 'LONG' ? buyVotes : sellVotes;
    if (directionCount < 4) {
      return this.buildResult('WAIT', votes, buyVotes, sellVotes, waitVotes, vetoCount,
        Math.round((directionCount / 7) * 100), false,
        `Only ${directionCount}/7 agents agree with ${direction} — need 4+`);
    }

    // Calculate consensus strength
    const consensusScore = Math.round((directionCount / 7) * 100);
    const avgConfidence = votes.reduce((s, v) => s + v.confidence, 0) / votes.length;
    const finalScore = Math.round((consensusScore * 0.6) + (avgConfidence * 0.4));

    const tradingAllowed = finalScore >= 55 && waitVotes <= 2 && noTrades === 0;

    const reasoning = votes
      .map((v) => `${v.agentName}: ${v.vote} (${v.confidence}%) — ${v.reason}`)
      .join('\n');

    return this.buildResult(directionVote, votes, buyVotes, sellVotes, waitVotes,
      vetoCount, finalScore, tradingAllowed, reasoning);
  }

  // ---- Individual Agent Votes ----

  private volumeVote(signal: TradingSignal): AgentVote {
    const v = signal.volumeAnalysis;
    const isLong = signal.direction === 'LONG';
    let vote: VoteDecision = 'WAIT';
    let confidence = 50;
    let reason = '';
    let isVeto = false;

    if (v.isSpoofing) {
      vote = 'NO_TRADE'; confidence = 85; isVeto = true;
      reason = 'Spoofing detected — market manipulated';
    } else if (v.isWhaleActivity && (isLong ? v.buyPressure > 55 : v.buyPressure < 45)) {
      vote = isLong ? 'BUY' : 'SELL'; confidence = 80;
      reason = `Whale activity with ${isLong ? 'bullish' : 'bearish'} pressure`;
    } else if (v.isVolumeSpike && v.isAbsorption) {
      vote = isLong ? 'BUY' : 'SELL'; confidence = 72;
      reason = 'Volume spike with absorption';
    } else if (v.volumeRatio < 0.6) {
      vote = 'WAIT'; confidence = 60;
      reason = 'Insufficient volume for quality entry';
    } else {
      vote = isLong ? 'BUY' : 'SELL'; confidence = 55;
      reason = `Volume imbalance: ${v.buyPressure.toFixed(1)}% buy pressure`;
    }

    return { agentName: 'VolumeAgent', vote, confidence, reason, isVeto };
  }

  private patternVote(signal: TradingSignal): AgentVote {
    const p = signal.patternAnalysis;
    const isLong = signal.direction === 'LONG';
    let vote: VoteDecision = 'WAIT';
    let confidence = 50;
    let reason = '';
    let isVeto = false;

    if (p.isFakeBreakout) {
      vote = 'NO_TRADE'; confidence = 80; isVeto = true;
      reason = 'Fake breakout detected — reversal risk is high';
    } else if (p.isBOS && p.hasOrderBlock) {
      vote = isLong ? 'BUY' : 'SELL'; confidence = 82;
      reason = 'BOS + Order Block confluence';
    } else if (p.isCHOCH && p.hasFairValueGap) {
      vote = isLong ? 'BUY' : 'SELL'; confidence = 75;
      reason = 'CHOCH + FVG fill setup';
    } else if (p.isBOS) {
      vote = isLong ? 'BUY' : 'SELL'; confidence = 65;
      reason = 'Break of structure confirmed';
    } else if (!p.isTrendContinuation && !p.isReversal) {
      vote = 'WAIT'; confidence = 55;
      reason = 'No clear pattern structure';
    } else {
      vote = isLong ? 'BUY' : 'SELL'; confidence = 58;
      reason = p.isTrendContinuation ? 'Trend continuation' : 'Reversal pattern';
    }

    return { agentName: 'PatternAgent', vote, confidence, reason, isVeto };
  }

  private indicatorVote(signal: TradingSignal): AgentVote {
    const i = signal.indicators;
    const isLong = signal.direction === 'LONG';
    let vote: VoteDecision = 'WAIT';
    let confidence = 50;
    let reason = '';
    const isVeto = false;

    const bullStack = i.ema20 > i.ema50 && i.ema50 > i.ema200;
    const bearStack = i.ema20 < i.ema50 && i.ema50 < i.ema200;
    const trendAligned = (isLong && bullStack) || (!isLong && bearStack);
    const rsiExtreme = (isLong && i.rsi > 78) || (!isLong && i.rsi < 22);
    const divergenceAligned = (isLong && i.rsiDivergence === 'bullish') || (!isLong && i.rsiDivergence === 'bearish');

    if (rsiExtreme) {
      vote = 'WAIT'; confidence = 70;
      reason = `RSI in extreme zone (${i.rsi.toFixed(1)}) — pullback risk`;
    } else if (trendAligned && divergenceAligned) {
      vote = isLong ? 'BUY' : 'SELL'; confidence = 85;
      reason = `EMA stack + RSI ${isLong ? 'bullish' : 'bearish'} divergence aligned`;
    } else if (trendAligned && i.macdHistogram * (isLong ? 1 : -1) > 0) {
      vote = isLong ? 'BUY' : 'SELL'; confidence = 72;
      reason = 'EMA + MACD aligned with direction';
    } else if (!trendAligned) {
      vote = 'WAIT'; confidence = 65;
      reason = `EMA trend (${i.trend}) conflicts with ${signal.direction}`;
    } else {
      vote = isLong ? 'BUY' : 'SELL'; confidence = 55;
      reason = `Moderate indicator alignment — RSI: ${i.rsi.toFixed(1)}`;
    }

    return { agentName: 'IndicatorAgent', vote, confidence, reason, isVeto };
  }

  private mevVote(signal: TradingSignal): AgentVote {
    const v = signal.volumeAnalysis;
    const isLong = signal.direction === 'LONG';
    let vote: VoteDecision = 'WAIT';
    let confidence = 50;
    let reason = '';
    let isVeto = false;

    if (v.isSpoofing) {
      vote = 'NO_TRADE'; confidence = 90; isVeto = true;
      reason = 'MEV/spoofing manipulation — capital at risk';
    } else if (v.isLiquiditySweep && v.isWhaleActivity) {
      vote = isLong ? 'BUY' : 'SELL'; confidence = 78;
      reason = 'Smart money liquidity sweep with whale participation';
    } else if (v.isLiquiditySweep) {
      vote = isLong ? 'BUY' : 'SELL'; confidence = 65;
      reason = 'Liquidity sweep — stop hunt likely complete';
    } else {
      vote = 'WAIT'; confidence = 50;
      reason = 'No clear smart money signal';
    }

    return { agentName: 'MEVAgent', vote, confidence, reason, isVeto };
  }

  private riskVote(signal: TradingSignal, mode: StrategyMode): AgentVote {
    const minRR = { scalping: 1.5, swing: 2.0, investing: 2.5, safe: 2.5, aggressive: 1.2 }[mode];
    const rr = signal.riskReward;
    let vote: VoteDecision = 'WAIT';
    let confidence = 50;
    let reason = '';
    let isVeto = false;

    if (rr < 1.0) {
      vote = 'NO_TRADE'; confidence = 95; isVeto = true;
      reason = `RR ${rr.toFixed(2)}:1 is below 1:1 — never acceptable`;
    } else if (rr < minRR) {
      vote = 'WAIT'; confidence = 70;
      reason = `RR ${rr.toFixed(2)}:1 below ${minRR}:1 minimum for ${mode} mode`;
    } else if (rr >= 2.5) {
      vote = signal.direction === 'LONG' ? 'BUY' : 'SELL'; confidence = 85;
      reason = `Excellent RR ${rr.toFixed(2)}:1`;
    } else {
      vote = signal.direction === 'LONG' ? 'BUY' : 'SELL'; confidence = 68;
      reason = `Acceptable RR ${rr.toFixed(2)}:1`;
    }

    return { agentName: 'RiskAgent', vote, confidence, reason, isVeto };
  }

  private regimeVote(regime: RegimeAnalysis, session: SessionInfo): AgentVote {
    let vote: VoteDecision = 'WAIT';
    let confidence = 50;
    let reason = '';
    let isVeto = false;

    if (regime.isManipulative) {
      vote = 'NO_TRADE'; confidence = 90; isVeto = true;
      reason = `Regime VETO: ${regime.description}`;
    } else if (!regime.tradingAllowed) {
      vote = 'WAIT'; confidence = 75; isVeto = false;
      reason = `Regime caution: ${regime.description}`;
    } else if (!session.tradingAllowed) {
      vote = 'NO_TRADE'; confidence = 85; isVeto = true;
      reason = `Session VETO: ${session.description}`;
    } else if (regime.regime === 'trending_up' || regime.regime === 'trending_down') {
      vote = regime.regime === 'trending_up' ? 'BUY' : 'SELL';
      confidence = Math.min(85, 50 + regime.trendStrength * 0.5);
      reason = `${regime.regime.replace('_', ' ')} confirmed`;
    } else if (regime.regime === 'ranging' && session.isHighQuality) {
      vote = 'WAIT'; confidence = 60;
      reason = 'Ranging market — wait for breakout';
    } else {
      vote = 'WAIT'; confidence = 55;
      reason = `Regime: ${regime.regime} — ${regime.description.slice(0, 50)}`;
    }

    return { agentName: 'RegimeAgent', vote, confidence, reason, isVeto };
  }

  private patienceVote(quality: MarketQualityScore, mtf: MTFAnalysis, mode: StrategyMode, direction?: 'LONG' | 'SHORT'): AgentVote {
    let vote: VoteDecision = 'WAIT';
    let confidence = 50;
    let reason = '';
    let isVeto = false;

    const minQuality = { scalping: 65, swing: 70, investing: 65, safe: 80, aggressive: 50 }[mode];
    const dirVote: VoteDecision = direction === 'SHORT' ? 'SELL' : 'BUY';

    if (!quality.tradingAllowed) {
      vote = 'NO_TRADE'; confidence = 85; isVeto = mode === 'safe';
      reason = `Quality ${quality.total}/100 (${quality.grade}) — trading not allowed`;
    } else if (!mtf.overallAligned) {
      vote = 'WAIT'; confidence = 75;
      reason = mtf.rejectionReason ?? 'MTF alignment incomplete';
    } else if (quality.total >= 85) {
      vote = dirVote; confidence = 85;
      reason = `Excellent market quality: ${quality.total}/100`;
    } else if (quality.total >= minQuality) {
      vote = dirVote; confidence = 65;
      reason = `Market quality ${quality.total}/100 meets ${mode} threshold`;
    } else {
      vote = 'WAIT'; confidence = 60;
      reason = `Quality ${quality.total}/100 below ${minQuality} for ${mode} mode`;
    }

    return { agentName: 'PatienceAgent', vote, confidence, reason, isVeto };
  }

  private buildResult(
    finalDecision: VoteDecision,
    votes: AgentVote[],
    buyVotes: number,
    sellVotes: number,
    waitVotes: number,
    vetoCount: number,
    consensusScore: number,
    tradingAllowed: boolean,
    reasoning: string,
  ): ConsensusResult {
    return {
      finalDecision, votes, buyVotes, sellVotes, waitVotes,
      vetoCount, consensusScore, tradingAllowed, reasoning,
      timestamp: Date.now(),
    };
  }
}

export const consensusVoting = new ConsensusVotingSystem();
