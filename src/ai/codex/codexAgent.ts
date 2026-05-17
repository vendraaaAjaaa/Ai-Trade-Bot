import { runCLI, parseCLIResponse } from '../shared/cliRunner';
import { createLogger } from '../../utils/logger';
import type { TradingSignal, AgentResult } from '../../utils/types';

const log = createLogger('codex-cli');

// =============================================
// CODEX CLI AGENT
// =============================================
// Invokes the Codex CLI as a subprocess via stdin pipe.
// No API key required when using local or already-authenticated sessions.
//
// Supported invocation styles (tried in order):
//   1. codex                  (global install, stdin mode)
//   2. npx @openai/codex      (npx fallback)
//
// Authentication (one-time setup, no key in .env needed):
//   codex auth login          (browser-based OAuth)
//   OR set OPENAI_API_KEY if you have one
//
// Prompt format sent via stdin:
//   The CLI receives the full structured prompt and must reply with:
//     SCORE: <0-100>
//     JOURNAL: <one sentence>
//     RISK: <flag>    (repeat as needed, omit if none)
// =============================================

/** Codex invocation candidates — stdin pipe is the most reliable. */
const CODEX_CANDIDATES = [
  { cmd: 'codex', args: ['--quiet'] },
  { cmd: 'npx', args: ['--yes', '@openai/codex', '--quiet'] },
];

export class CodexTradingAgent {
  readonly name = 'CodexCLIAgent';

  async analyzeSignal(signal: TradingSignal): Promise<AgentResult> {
    log.info({ pair: signal.pair, direction: signal.direction }, 'CodexCLI: running analysis');

    const prompt = buildCodexPrompt(signal);

    const { output, usedCommand, fromFallback } = await runCLI(
      CODEX_CANDIDATES,
      prompt,
      deterministicFallback,
    );

    if (fromFallback) {
      log.warn({ pair: signal.pair }, 'CodexCLI: using deterministic fallback');
    } else {
      log.info({ pair: signal.pair, cmd: usedCommand }, 'CodexCLI: response received');
    }

    const parsed = parseCLIResponse(
      output,
      `Codex analysis for ${signal.pair} ${signal.direction} at ${signal.entry.toFixed(2)}.`,
    );

    const flags = parsed.risks;
    if (fromFallback) flags.push('INFO: Codex CLI unavailable — deterministic analysis used');

    return {
      agentName: this.name,
      analysis: parsed.journal,
      score: parsed.score,
      flags,
    };
  }
}

// ---- Prompt ----

function buildCodexPrompt(s: TradingSignal): string {
  const v = s.volumeAnalysis;
  const p = s.patternAnalysis;
  const i = s.indicators;

  return `You are a quant trading analyst. Evaluate this crypto futures signal and reply ONLY in the exact format below — no extra text.

SIGNAL
Pair: ${s.pair} | Direction: ${s.direction} | Entry: ${s.entry.toFixed(4)}
Stop Loss: ${s.stopLoss.toFixed(4)} | Take Profit: ${s.takeProfit.toFixed(4)} | RR: ${s.riskReward.toFixed(2)}:1
Confluence confidence: ${s.confidence}%

VOLUME
Spike: ${v.isVolumeSpike} (${v.volumeRatio.toFixed(2)}x avg) | Whale: ${v.isWhaleActivity}
Absorption: ${v.isAbsorption} | Liquidity sweep: ${v.isLiquiditySweep}
Buy pressure: ${v.buyPressure.toFixed(1)}% | Spoofing: ${v.isSpoofing}

PATTERNS
BOS: ${p.isBOS} | CHOCH: ${p.isCHOCH} | Fake breakout: ${p.isFakeBreakout}
Order block: ${p.hasOrderBlock} @ ${p.orderBlockLevel?.toFixed(4) ?? 'N/A'}
FVG: ${p.hasFairValueGap} (${p.fvgLow?.toFixed(4) ?? 'N/A'} – ${p.fvgHigh?.toFixed(4) ?? 'N/A'})

INDICATORS
EMA trend: ${i.trend} | RSI: ${i.rsi.toFixed(1)} | Divergence: ${i.rsiDivergence}
MACD histogram: ${i.macdHistogram > 0 ? 'positive' : 'negative'} (${i.macdHistogram.toFixed(6)})
Price vs VWAP: ${s.entry > i.vwap ? 'above' : 'below'} | ATR: ${i.atr.toFixed(4)}

Reply in this EXACT format (nothing else):
SCORE: <integer 0-100>
JOURNAL: <one sentence describing the key reason for or against this trade>
RISK: <one critical risk per line, prefix each with RISK:, omit entirely if no risks>`;
}

// ---- Deterministic fallback (no CLI, no API key) ----

function deterministicFallback(prompt: string): string {
  const isLong   = prompt.includes('Direction: LONG');
  const hasOB    = prompt.includes('Order block: true');
  const hasFVG   = prompt.includes('FVG: true');
  const hasBOS   = prompt.includes('BOS: true');
  const hasCHOCH = prompt.includes('CHOCH: true');
  const fakeBO   = prompt.includes('Fake breakout: true');
  const whale    = prompt.includes('Whale: true');
  const spoof    = prompt.includes('Spoofing: true');
  const absorption = prompt.includes('Absorption: true');
  const bullish  = prompt.includes('EMA trend: bullish');
  const bearish  = prompt.includes('EMA trend: bearish');

  let score = 50;
  const reasons: string[] = [];
  const risks: string[] = [];

  if (isLong) {
    if (bullish)    { score += 15; reasons.push('bullish EMA alignment'); }
    if (hasBOS)     { score += 12; reasons.push('BOS confirmed'); }
    if (hasOB)      { score += 12; reasons.push('order block confluence'); }
    if (hasFVG)     { score += 8;  reasons.push('FVG fill'); }
    if (whale)      { score += 10; reasons.push('whale accumulation'); }
    if (absorption) { score += 8;  reasons.push('absorption detected'); }
    if (hasCHOCH)   { score += 8;  reasons.push('CHOCH signal'); }
    if (bearish)    { score -= 15; risks.push('EMA trend conflicts with LONG direction'); }
    if (fakeBO)     { score -= 20; risks.push('Fake breakout detected — reversal likely'); }
    if (spoof)      { score -= 12; risks.push('Spoofing activity detected'); }
  } else {
    if (bearish)    { score += 15; reasons.push('bearish EMA alignment'); }
    if (hasBOS)     { score += 12; reasons.push('bearish BOS confirmed'); }
    if (hasOB)      { score += 10; reasons.push('order block resistance'); }
    if (fakeBO)     { score += 10; reasons.push('fake breakout rejection'); }
    if (hasCHOCH)   { score += 8;  reasons.push('CHOCH reversal signal'); }
    if (whale)      { score += 8;  reasons.push('whale distribution'); }
    if (bullish)    { score -= 15; risks.push('EMA trend conflicts with SHORT direction'); }
    if (spoof)      { score -= 12; risks.push('Spoofing activity detected'); }
  }

  score = Math.min(95, Math.max(10, score));
  const journal = reasons.length > 0
    ? `Setup supported by: ${reasons.slice(0, 3).join(', ')}.`
    : 'Mixed signals — proceed with caution.';

  const lines = [`SCORE: ${score}`, `JOURNAL: ${journal}`];
  for (const r of risks) lines.push(`RISK: ${r}`);
  return lines.join('\n');
}

export const codexTradingAgent = new CodexTradingAgent();
