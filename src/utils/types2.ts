// =============================================
// EXTENDED TYPES — Update v2
// =============================================

export type MarketRegime =
  | 'trending_up'
  | 'trending_down'
  | 'ranging'
  | 'choppy'
  | 'high_volatility'
  | 'low_liquidity'
  | 'manipulative'
  | 'news_volatility'
  | 'unknown';

export type SessionName = 'london' | 'new_york' | 'overlap' | 'asia' | 'dead';
export type StrategyMode = 'scalping' | 'swing' | 'investing' | 'safe' | 'aggressive';
export type SystemStatus = 'trading' | 'observation' | 'cooldown' | 'disabled';

// ---- Market Regime ----
export interface RegimeAnalysis {
  regime: MarketRegime;
  confidence: number;          // 0-100
  trendStrength: number;       // 0-100 (ADX-like)
  isChoppy: boolean;
  isManipulative: boolean;
  atrPercent: number;          // ATR as % of price
  emaFlattening: boolean;
  wickRatio: number;           // avg wick / body ratio
  fakeBreakoutFrequency: number;
  tradingAllowed: boolean;
  description: string;
  timestamp: number;
}

// ---- Market Quality Score ----
export interface MarketQualityScore {
  total: number;               // 0-100
  grade: 'excellent' | 'tradeable' | 'risky' | 'no_trade';
  trendClarity: number;        // 0-25
  liquidityQuality: number;    // 0-20
  volatilityQuality: number;   // 0-20
  volumeQuality: number;       // 0-20
  confirmationStrength: number;// 0-15
  tradingAllowed: boolean;
  reasons: string[];
  timestamp: number;
}

// ---- Session Filter ----
export interface SessionInfo {
  name: SessionName;
  quality: number;             // 0-100
  isActive: boolean;
  isHighQuality: boolean;
  tradingAllowed: boolean;
  volumeMultiplier: number;    // relative volume expected
  riskMultiplier: number;      // risk adjustment for session
  description: string;
  utcHour: number;
}

// ---- Multi-Timeframe Analysis ----
export interface MTFAnalysis {
  pair: string;
  strategyMode: StrategyMode;
  trendTimeframe: { tf: string; trend: string; aligned: boolean };
  structureTimeframe: { tf: string; structure: string; aligned: boolean };
  triggerTimeframe: { tf: string; ready: boolean };
  overallAligned: boolean;
  alignmentScore: number;      // 0-100
  rejectionReason?: string;
  timestamp: number;
}

// ---- Consensus Vote ----
export type VoteDecision = 'BUY' | 'SELL' | 'WAIT' | 'NO_TRADE';

export interface AgentVote {
  agentName: string;
  vote: VoteDecision;
  confidence: number;
  reason: string;
  isVeto: boolean;
}

export interface ConsensusResult {
  finalDecision: VoteDecision;
  votes: AgentVote[];
  buyVotes: number;
  sellVotes: number;
  waitVotes: number;
  vetoCount: number;
  consensusScore: number;      // 0-100, how strong the agreement is
  tradingAllowed: boolean;
  reasoning: string;
  timestamp: number;
}

// ---- Patience Engine ----
export interface PatienceDecision {
  shouldTrade: boolean;
  reason: string;
  quality: 'excellent' | 'good' | 'marginal' | 'poor' | 'no_trade';
  waitForCondition?: string;
  estimatedWaitMinutes?: number;
  psychologicalNote: string;
  timestamp: number;
}

// ---- Trade Frequency ----
export interface FrequencyState {
  tradesToday: number;
  maxTradesDay: number;
  lastTradeTime: number;
  minIntervalMinutes: number;
  isLimited: boolean;
  remainingToday: number;
}

// ---- Loss Streak Protection ----
export interface LossStreakState {
  consecutiveLosses: number;
  inCooldown: boolean;
  cooldownUntil: number;
  cooldownReason: string;
  observationMode: boolean;
  lastLossTime: number;
}

// ---- Self Review ----
export interface TradeReview {
  positionId: string;
  pair: string;
  direction: string;
  outcome: 'win' | 'loss' | 'breakeven';
  pnl: number;
  entryQuality: string;
  exitQuality: string;
  regimeAtEntry: MarketRegime;
  sessionAtEntry: SessionName;
  signalConfidence: number;
  aiConsensus: number;
  executionSlippage: number;
  lessonsLearned: string[];
  whatWorked: string;
  whatFailed: string;
  journal: string;
  timestamp: number;
}

// ---- Strategy Mode Config ----
export interface StrategyConfig {
  mode: StrategyMode;
  maxTradesPerDay: number;
  minConfidence: number;
  minRR: number;
  maxLeverage: number;
  minConsensusScore: number;
  minMarketQuality: number;
  allowedRegimes: MarketRegime[];
  allowedSessions: SessionName[];
  description: string;
}

// ---- No Trade Decision ----
export interface NoTradeDecision {
  shouldSkip: boolean;
  reasons: string[];
  primaryReason: string;
  category: 'regime' | 'quality' | 'session' | 'frequency' | 'cooldown' | 'consensus' | 'patience' | 'risk';
  resumeCondition: string;
}

// ---- Execution Quality ----
export interface ExecutionQuality {
  positionId: string;
  requestedPrice: number;
  filledPrice: number;
  slippage: number;
  slippagePercent: number;
  spread: number;
  latencyMs: number;
  fillQuality: 'excellent' | 'good' | 'poor' | 'failed';
  timestamp: number;
}
