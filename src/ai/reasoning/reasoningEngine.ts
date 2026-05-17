import type { TradingSignal, AIValidationResult, AgentResult } from '../../utils/types';
import { VolumeAgent, PatternAgent, IndicatorAgent, MEVAgent, RiskAgent } from '../agents/agentDefinitions';
import { CodexTradingAgent } from '../codex/codexAgent';
import { GeminiTradingAgent } from '../gemini/geminiAgent';
import { createLogger } from '../../utils/logger';
import { redis, CacheKeys } from '../../redis/client';

const log = createLogger('reasoning');

// =============================================
// MULTI-AGENT REASONING ENGINE  (7 agents)
// =============================================
//
//  NO API KEY REQUIRED for any agent.
//
//  Deterministic agents (always run, pure TypeScript):
//    1. VolumeAgent      — spikes, whale, absorption, spoofing
//    2. PatternAgent     — BOS, CHOCH, OB, FVG, breakout
//    3. IndicatorAgent   — EMA, RSI divergence, MACD, VWAP
//    4. MEVAgent         — MEV / spoofing / smart money flow
//    5. RiskAgent        — RR, SL sizing, ATR, confidence gate
//
//  CLI subprocess agents (graceful fallback to deterministic rules):
//    6. CodexCLIAgent    — openai/codex via stdin pipe
//    7. GeminiCLIAgent   — google/gemini-cli via stdin pipe (free tier)
//
//  Auth (one-time, no billing):
//    codex auth login    (browser OAuth)
//    gemini auth login   (Google account, 60 req/min free)
//
//  Scoring weights:
//    deterministic agents → 60%
//    CLI agents           → 40%
//
//  Hard veto:
//    RiskAgent score < 25              → block signal
//    Both CLI agents flag 2+ risks     → block signal
// =============================================

export class ReasoningEngine {
  private readonly deterministicAgents = [
    new VolumeAgent(),
    new PatternAgent(),
    new IndicatorAgent(),
    new MEVAgent(),
    new RiskAgent(),
  ];

  private readonly cliAgents = [
    new CodexTradingAgent(),
    new GeminiTradingAgent(),
  ];

  async validateSignal(signal: TradingSignal): Promise<AIValidationResult> {
    log.info(
      { pair: signal.pair, direction: signal.direction, confidence: signal.confidence },
      'Reasoning engine: 5 deterministic + Codex CLI + Gemini CLI',
    );

    // 3-min cache per pair+direction to avoid hammering CLIs
    const cacheKey = CacheKeys.agentCache('v2', `${signal.pair}:${signal.direction}`);
    const cached = await redis.getJson<AIValidationResult>(cacheKey);
    if (cached && Date.now() - cached.timestamp < 3 * 60 * 1000) {
      log.debug('Returning cached validation');
      return cached;
    }

    // ---- Run all 7 agents in parallel ----
    const allAgents = [...this.deterministicAgents, ...this.cliAgents];
    const settled = await Promise.allSettled(allAgents.map((a) => a.analyzeSignal(signal)));

    const agentResults: AgentResult[] = settled.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      log.warn({ agent: allAgents[i]!.name, reason: r.reason }, 'Agent failed');
      return {
        agentName: allAgents[i]!.name,
        analysis: 'Agent unavailable.',
        score: 50,
        flags: ['INFO: Agent did not respond'],
      };
    });

    // ---- Weighted scoring ----
    const detScores = agentResults.slice(0, 5).map((r) => r.score);
    const cliScores = agentResults.slice(5).map((r) => r.score);
    const detAvg    = avg(detScores);
    const cliAvg    = avg(cliScores);
    const weighted  = detAvg * 0.6 + cliAvg * 0.4;

    // ---- Validation decision ----
    const isValid =
      weighted >= 45 &&
      signal.confidence >= 65 &&
      signal.riskReward >= 1.5 &&
      !this.hardVeto(agentResults);

    // ---- Risk flags (WARN / RISK / ERROR prefixes) ----
    const risks = agentResults.flatMap((r) =>
      r.flags.filter((f) => /^(WARN|RISK|ERROR)/i.test(f)),
    );

    // ---- Combined reasoning text ----
    const reasoning = agentResults
      .map((r) => `[${r.agentName}] score=${r.score}\n${r.analysis}`)
      .join('\n\n');

    // ---- Trade journal ----
    const journal = this.journal(signal, agentResults, weighted);

    const result: AIValidationResult = {
      isValid,
      confidence: Math.round(weighted),
      reasoning,
      risks,
      journal,
      agentResults,
      timestamp: Date.now(),
    };

    await redis.setJson(cacheKey, result, 180);

    log.info({
      pair: signal.pair,
      isValid,
      weighted: weighted.toFixed(1),
      detAvg: detAvg.toFixed(1),
      cliAvg: cliAvg.toFixed(1),
      risks: risks.length,
    }, 'Validation complete');

    return result;
  }

  private hardVeto(results: AgentResult[]): boolean {
    const riskAgent = results.find((r) => r.agentName === 'RiskAgent');
    if (riskAgent && riskAgent.score < 25) return true;

    const codexFlags  = results.find((r) => r.agentName === 'CodexCLIAgent')?.flags.filter((f) => /^(WARN|RISK)/i.test(f)).length ?? 0;
    const geminiFlags = results.find((r) => r.agentName === 'GeminiCLIAgent')?.flags.filter((f) => /^(WARN|RISK)/i.test(f)).length ?? 0;
    if (codexFlags >= 2 && geminiFlags >= 2) return true;

    return false;
  }

  private journal(signal: TradingSignal, results: AgentResult[], score: number): string {
    // Prefer real CLI journal sentences (not fallback boilerplate)
    const cliJournal = results
      .filter((r) => (r.agentName === 'CodexCLIAgent' || r.agentName === 'GeminiCLIAgent'))
      .map((r) => r.analysis)
      .filter((a) => a.length > 20 && !a.includes('unavailable') && !a.includes('Fallback'))
      .join(' ');

    const v = signal.volumeAnalysis;
    const p = signal.patternAnalysis;
    const i = signal.indicators;
    const parts: string[] = [];

    parts.push(`${signal.pair} ${signal.direction} at ${signal.entry.toFixed(2)}.`);
    if (cliJournal) parts.push(cliJournal);
    if (v.isWhaleActivity)  parts.push(`Whale volume (${v.volumeRatio.toFixed(1)}x).`);
    if (v.isLiquiditySweep) parts.push('Liquidity sweep complete.');
    if (v.isAbsorption)     parts.push('Absorption confirmed.');
    if (p.isBOS)            parts.push('BOS confirmed.');
    if (p.isCHOCH)          parts.push('CHOCH detected.');
    if (p.hasOrderBlock)    parts.push(`OB @ ${p.orderBlockLevel?.toFixed(2)}.`);
    if (p.hasFairValueGap)  parts.push('FVG filling.');
    parts.push(`${i.trend.toUpperCase()} EMA, RSI ${i.rsi.toFixed(1)}, MACD ${i.macdHistogram > 0 ? '▲' : '▼'}.`);
    parts.push(`RR ${signal.riskReward.toFixed(2)}:1 | Agent consensus ${score.toFixed(0)}/100.`);

    return parts.join(' ');
  }
}

function avg(arr: number[]): number {
  return arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 50;
}

export const reasoningEngine = new ReasoningEngine();
