import { runCLI, parseCLIResponse } from '../shared/cliRunner';
import { createLogger } from '../../utils/logger';
import type { TradingSignal, AgentResult } from '../../utils/types';

const log = createLogger('gemini-cli');

// =============================================
// GEMINI CLI AGENT
// =============================================
// Invokes the Google Gemini CLI as a subprocess via stdin pipe.
//
// FREE TIER — no billing, no API key needed:
//   gemini auth login         (one-time browser OAuth with Google account)
//   Free quota: 60 requests/min on gemini-2.0-flash
//
// Supported invocation styles (tried in order):
//   1. gemini                 (global install, reads stdin)
//   2. npx @google/gemini-cli (npx fallback)
//
// Specialisation: smart money flow, market structure, order blocks, FVGs.
// =============================================

/** Gemini invocation candidates — stdin pipe is the most portable. */
const GEMINI_CANDIDATES = [
  // Standard global install — reads full prompt from stdin when no -p flag
  { cmd: 'gemini', args: [] },
  // Some versions need explicit model
  { cmd: 'gemini', args: ['--model', 'gemini-2.0-flash'] },
  // npx fallback
  { cmd: 'npx', args: ['--yes', '@google/gemini-cli'] },
];

export class GeminiTradingAgent {
  readonly name = 'GeminiCLIAgent';

  async analyzeSignal(signal: TradingSignal): Promise<AgentResult> {
    log.info({ pair: signal.pair, direction: signal.direction }, 'GeminiCLI: running analysis');

    const prompt = buildGeminiPrompt(signal);

    const { output, usedCommand, fromFallback } = await runCLI(
      GEMINI_CANDIDATES,
      prompt,
      deterministicFallback,
      { timeoutMs: 40_000 },
    );

    if (fromFallback) {
      log.warn({ pair: signal.pair }, 'GeminiCLI: using deterministic fallback');
    } else {
      log.info({ pair: signal.pair, cmd: usedCommand }, 'GeminiCLI: response received');
    }

    const parsed = parseCLIResponse(
      output,
      `Gemini smart money analysis for ${signal.pair} ${signal.direction}.`,
    );

    const flags = parsed.risks;
    if (fromFallback) flags.push('INFO: Gemini CLI unavailable — deterministic analysis used');

    return {
      agentName: this.name,
      analysis: parsed.journal,
      score: parsed.score,
      flags,
    };
  }
}

// ---- Prompt ----
// Gemini is specialised on smart money + structure — keeps prompts focused.

function buildGeminiPrompt(s: TradingSignal): string {
  const p = s.patternAnalysis;
  const v = s.volumeAnalysis;
  const i = s.indicators;

  return `You are a smart money and market structure analyst for crypto futures.
Evaluate the setup and reply ONLY in the exact format below — nothing else.

SIGNAL
${s.pair} ${s.direction} | Entry: ${s.entry.toFixed(4)} | RR: ${s.riskReward.toFixed(2)}:1
SL: ${s.stopLoss.toFixed(4)} | TP: ${s.takeProfit.toFixed(4)} | Confidence: ${s.confidence}%

STRUCTURE
BOS: ${p.isBOS} | CHOCH: ${p.isCHOCH} | Trend continuation: ${p.isTrendContinuation}
Order Block: ${p.hasOrderBlock} @ ${p.orderBlockLevel?.toFixed(4) ?? 'N/A'}
Fair Value Gap: ${p.hasFairValueGap} | Range: ${p.fvgLow?.toFixed(4) ?? 'N/A'} – ${p.fvgHigh?.toFixed(4) ?? 'N/A'}
Fake breakout: ${p.isFakeBreakout} | Reversal pattern: ${p.isReversal}

SMART MONEY
Whale activity: ${v.isWhaleActivity} | Volume ${v.volumeRatio.toFixed(2)}x avg
Absorption: ${v.isAbsorption} | Liquidity sweep: ${v.isLiquiditySweep}
Buy pressure: ${v.buyPressure.toFixed(1)}% | Spoofing: ${v.isSpoofing}

TREND
EMA: ${i.trend} | RSI: ${i.rsi.toFixed(1)} | Divergence: ${i.rsiDivergence}
Price vs VWAP: ${s.entry > i.vwap ? 'above' : 'below'}

Reply in this EXACT format (nothing else):
SCORE: <integer 0-100>
JOURNAL: <one sentence about smart money / structure confluence>
RISK: <one risk per line prefixed with RISK:, omit entirely if no risks>`;
}

// ---- Deterministic fallback (no CLI, no auth) ----

function deterministicFallback(prompt: string): string {
  const isLong    = prompt.includes('Direction: LONG') || prompt.includes('LONG |');
  const hasOB     = prompt.includes('Order Block: true');
  const hasFVG    = prompt.includes('Fair Value Gap: true');
  const hasBOS    = prompt.includes('BOS: true');
  const hasCHOCH  = prompt.includes('CHOCH: true');
  const fakeBO    = prompt.includes('Fake breakout: true');
  const whale     = prompt.includes('Whale activity: true');
  const sweep     = prompt.includes('Liquidity sweep: true');
  const absorb    = prompt.includes('Absorption: true');
  const spoof     = prompt.includes('Spoofing: true');
  const bullDiv   = prompt.includes('Divergence: bullish');
  const bearDiv   = prompt.includes('Divergence: bearish');
  const above     = prompt.includes('Price vs VWAP: above');
  const bullTrend = prompt.includes('EMA: bullish');
  const bearTrend = prompt.includes('EMA: bearish');

  let score = 50;
  const keyPoints: string[] = [];
  const risks: string[] = [];

  // Structure
  if (hasBOS)  { score += 15; keyPoints.push('BOS'); }
  if (hasCHOCH){ score += 10; keyPoints.push('CHOCH'); }
  if (hasOB)   { score += 12; keyPoints.push('order block'); }
  if (hasFVG)  { score += 8;  keyPoints.push('FVG fill'); }

  // Smart money
  if (whale)   { score += 12; keyPoints.push('whale participation'); }
  if (sweep)   { score += 8;  keyPoints.push('liquidity sweep'); }
  if (absorb)  { score += 6;  keyPoints.push('absorption'); }

  // Trend alignment
  if (isLong && bullTrend)  { score += 10; keyPoints.push('bullish EMA'); }
  if (!isLong && bearTrend) { score += 10; keyPoints.push('bearish EMA'); }
  if (isLong && above)      { score += 5; }

  // Divergence
  if (isLong && bullDiv)    { score += 10; keyPoints.push('bullish RSI divergence'); }
  if (!isLong && bearDiv)   { score += 10; keyPoints.push('bearish RSI divergence'); }

  // Negatives
  if (fakeBO)  { score -= 22; risks.push('Fake breakout — high reversal risk'); }
  if (spoof)   { score -= 15; risks.push('Order book spoofing detected'); }
  if (isLong && bearTrend)  { score -= 12; risks.push('EMA trend opposes LONG direction'); }
  if (!isLong && bullTrend) { score -= 12; risks.push('EMA trend opposes SHORT direction'); }

  score = Math.min(95, Math.max(10, score));

  const journal = keyPoints.length > 0
    ? `Smart money confluence: ${keyPoints.slice(0, 3).join(', ')} support the ${isLong ? 'long' : 'short'} thesis.`
    : 'No clear smart money confluence — neutral structure.';

  const lines = [`SCORE: ${score}`, `JOURNAL: ${journal}`];
  for (const r of risks) lines.push(`RISK: ${r}`);
  return lines.join('\n');
}

export const geminiTradingAgent = new GeminiTradingAgent();
