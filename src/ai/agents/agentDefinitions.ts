import type { TradingSignal, AgentResult } from '../../utils/types';

// =============================================
// DETERMINISTIC RULE-BASED AGENTS
// =============================================
// These agents require NO API key and NO CLI.
// All logic is pure TypeScript — always available.
//
// Agents:
//   1. VolumeAgent      — volume spikes, whale, absorption, imbalance
//   2. PatternAgent     — BOS, CHOCH, OB, FVG, breakout, reversal
//   3. IndicatorAgent   — EMA stacks, RSI, MACD, VWAP divergence
//   4. MEVAgent         — MEV risk, spoofing, smart money alignment
//   5. RiskAgent        — RR validation, SL sizing, ATR check
// =============================================

export abstract class BaseAgent {
  abstract readonly name: string;
  abstract analyzeSignal(signal: TradingSignal): Promise<AgentResult>;

  protected buildResult(name: string, score: number, analysis: string, flags: string[]): AgentResult {
    return { agentName: name, analysis, score: Math.min(100, Math.max(0, score)), flags };
  }
}

// ---- 1. Volume Agent ----
export class VolumeAgent extends BaseAgent {
  readonly name = 'VolumeAgent';

  async analyzeSignal(signal: TradingSignal): Promise<AgentResult> {
    const v = signal.volumeAnalysis;
    const flags: string[] = [];
    let score = 50;

    if (v.isVolumeSpike)    { score += 18; flags.push(`Volume spike: ${v.volumeRatio.toFixed(2)}x avg`); }
    if (v.isWhaleActivity)  { score += 22; flags.push('Whale-size position detected'); }
    if (v.isAbsorption)     { score += 14; flags.push('Volume absorption at key level'); }
    if (v.isLiquiditySweep) { score += 12; flags.push('Liquidity sweep confirmed'); }

    const imbalance = v.buyPressure > 65 ? 'bullish' : v.buyPressure < 35 ? 'bearish' : 'neutral';
    if (v.buyPressure > 65) { score += 8; }
    if (v.buyPressure < 35) { score -= 8; }
    flags.push(`Volume imbalance: ${imbalance} (${v.buyPressure.toFixed(1)}% buy)`);

    if (v.isSpoofing) { score -= 18; flags.push('WARN: Spoofing pattern in order flow'); }

    // Direction alignment check
    const dirAligned =
      (signal.direction === 'LONG'  && v.buyPressure > 50) ||
      (signal.direction === 'SHORT' && v.buyPressure < 50);
    if (!dirAligned) { score -= 10; flags.push('WARN: Volume pressure opposes signal direction'); }

    const analysis = `Volume ${v.isVolumeSpike ? 'spike confirmed' : 'normal'}, ${imbalance} imbalance. ` +
      `${v.isWhaleActivity ? 'Whale activity detected. ' : ''}` +
      `${v.isAbsorption ? 'Absorption at level. ' : ''}` +
      `Delta: ${v.deltaVolume > 0 ? '+' : ''}${v.deltaVolume.toFixed(4)}.`;

    return this.buildResult(this.name, score, analysis, flags);
  }
}

// ---- 2. Pattern Agent ----
export class PatternAgent extends BaseAgent {
  readonly name = 'PatternAgent';

  async analyzeSignal(signal: TradingSignal): Promise<AgentResult> {
    const p = signal.patternAnalysis;
    const flags: string[] = [];
    let score = 50;

    if (p.isBreakout)         { score += 16; flags.push('Breakout confirmed'); }
    if (p.isFakeBreakout)     { score -= 28; flags.push('WARN: Fake breakout — reversal likely'); }
    if (p.isBOS)              { score += 18; flags.push('Break of structure confirmed'); }
    if (p.isCHOCH)            { score += 14; flags.push('Change of character detected'); }
    if (p.hasOrderBlock)      { score += 20; flags.push(`Order block @ ${p.orderBlockLevel?.toFixed(2)}`); }
    if (p.hasFairValueGap)    { score += 10; flags.push(`FVG: ${p.fvgLow?.toFixed(2)}–${p.fvgHigh?.toFixed(2)}`); }
    if (p.isTrendContinuation){ score += 14; flags.push('Trend continuation structure intact'); }
    if (p.isReversal)         { score += 8;  flags.push('Reversal candlestick pattern'); }

    const topReasons = flags.filter((f) => !f.startsWith('WARN')).slice(0, 3).join(', ');
    const analysis = topReasons.length > 0
      ? `Pattern confluence: ${topReasons}.`
      : 'No strong pattern confluence detected.';

    return this.buildResult(this.name, score, analysis, flags);
  }
}

// ---- 3. Indicator Agent ----
export class IndicatorAgent extends BaseAgent {
  readonly name = 'IndicatorAgent';

  async analyzeSignal(signal: TradingSignal): Promise<AgentResult> {
    const i = signal.indicators;
    const price = signal.entry;
    const flags: string[] = [];
    let score = 50;

    // EMA stack
    const bullStack = i.ema20 > i.ema50 && i.ema50 > i.ema200;
    const bearStack = i.ema20 < i.ema50 && i.ema50 < i.ema200;
    if (bullStack) { score += 16; flags.push('Bullish EMA stack (20 > 50 > 200)'); }
    if (bearStack) { score -= 16; flags.push('Bearish EMA stack (20 < 50 < 200)'); }

    // RSI
    if (i.rsi < 33)  { score += 12; flags.push(`RSI oversold: ${i.rsi.toFixed(1)}`); }
    if (i.rsi > 72)  { score -= 12; flags.push(`RSI overbought: ${i.rsi.toFixed(1)}`); }

    // RSI divergence
    if (i.rsiDivergence === 'bullish') { score += 14; flags.push('Bullish RSI divergence'); }
    if (i.rsiDivergence === 'bearish') { score -= 14; flags.push('WARN: Bearish RSI divergence'); }

    // MACD
    if (i.macdHistogram > 0) { score += 8;  flags.push('MACD histogram positive'); }
    else                     { score -= 8;  flags.push('MACD histogram negative'); }

    // VWAP
    const aboveVwap = price > i.vwap;
    if (aboveVwap)  { score += 7;  flags.push(`Price above VWAP (${i.vwap.toFixed(2)})`); }
    else            { score -= 7;  flags.push(`Price below VWAP (${i.vwap.toFixed(2)})`); }

    // Direction alignment
    const aligned =
      (signal.direction === 'LONG'  && i.trend === 'bullish') ||
      (signal.direction === 'SHORT' && i.trend === 'bearish');

    if (!aligned && i.trend !== 'ranging') {
      score -= 14;
      flags.push(`WARN: ${i.trend} trend opposes ${signal.direction} direction`);
    }

    const analysis =
      `EMA ${i.trend} (20:${i.ema20.toFixed(0)}/50:${i.ema50.toFixed(0)}/200:${i.ema200.toFixed(0)}). ` +
      `RSI ${i.rsi.toFixed(1)}${i.rsiDivergence !== 'none' ? ` + ${i.rsiDivergence} divergence` : ''}. ` +
      `MACD ${i.macdHistogram > 0 ? '▲' : '▼'}, ${aboveVwap ? 'above' : 'below'} VWAP.`;

    return this.buildResult(this.name, score, analysis, flags);
  }
}

// ---- 4. MEV Agent ----
export class MEVAgent extends BaseAgent {
  readonly name = 'MEVAgent';

  async analyzeSignal(signal: TradingSignal): Promise<AgentResult> {
    const v = signal.volumeAnalysis;
    const flags: string[] = [];
    let score = 50;

    if (v.isSpoofing)       { score -= 22; flags.push('WARN: Spoofing detected — potential manipulation'); }
    if (v.isWhaleActivity)  { score += 18; flags.push('Smart money position aligns with signal'); }
    if (v.isLiquiditySweep) { score += 14; flags.push('Liquidity sweep — stop-hunt may be complete'); }

    // Aggressive order imbalance in direction
    const netAggression = v.aggressiveBuys - v.aggressiveSells;
    const dirAligned =
      (signal.direction === 'LONG'  && netAggression > 0) ||
      (signal.direction === 'SHORT' && netAggression < 0);

    if (dirAligned)  { score += 10; flags.push('Aggressive order flow aligned with signal'); }
    else             { score -= 8;  flags.push('WARN: Aggressive flow opposes signal direction'); }

    flags.push(`Net flow: buy ${v.aggressiveBuys.toFixed(4)} / sell ${v.aggressiveSells.toFixed(4)}`);

    const analysis =
      `MEV risk: ${v.isSpoofing ? 'ELEVATED' : 'LOW'}. ` +
      `Smart money: ${v.isWhaleActivity ? 'active' : 'quiet'}. ` +
      `${v.isLiquiditySweep ? 'Liquidity sweep detected.' : ''}`;

    return this.buildResult(this.name, score, analysis, flags);
  }
}

// ---- 5. Risk Agent ----
export class RiskAgent extends BaseAgent {
  readonly name = 'RiskAgent';

  async analyzeSignal(signal: TradingSignal): Promise<AgentResult> {
    const flags: string[] = [];
    let score = 50;

    const rr = signal.riskReward;
    const atr = signal.indicators.atr;
    const slDist = Math.abs(signal.stopLoss - signal.entry);
    const atrMult = atr > 0 ? slDist / atr : 0;

    // RR check
    if      (rr >= 2.5) { score += 22; flags.push(`Excellent RR: ${rr.toFixed(2)}:1`); }
    else if (rr >= 1.5) { score += 10; flags.push(`Acceptable RR: ${rr.toFixed(2)}:1`); }
    else                { score -= 22; flags.push(`WARN: Poor RR: ${rr.toFixed(2)}:1 (min 1.5)`); }

    // SL sizing vs ATR
    if (atrMult < 0.5)     { score -= 14; flags.push(`WARN: SL too tight (${atrMult.toFixed(2)}x ATR)`); }
    else if (atrMult > 3)  { score -= 10; flags.push(`WARN: SL too wide (${atrMult.toFixed(2)}x ATR)`); }
    else                   { score += 8;  flags.push(`SL well-sized: ${atrMult.toFixed(2)}x ATR`); }

    // Confidence gate
    if (signal.confidence >= 80) { score += 16; flags.push(`High confidence: ${signal.confidence}%`); }
    else if (signal.confidence >= 65) { score += 8; }
    else { score -= 12; flags.push(`WARN: Low confidence: ${signal.confidence}%`); }

    const analysis =
      `RR ${rr.toFixed(2)}:1, SL ${atrMult.toFixed(1)}x ATR from entry. ` +
      `Confidence ${signal.confidence}%. ` +
      `${rr >= 1.5 ? 'Meets minimum risk criteria.' : 'Does NOT meet minimum risk criteria — skip.'}`;

    return this.buildResult(this.name, score, analysis, flags);
  }
}
