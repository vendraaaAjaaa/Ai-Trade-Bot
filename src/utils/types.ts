// =============================================
// CORE TYPES & INTERFACES
// =============================================

export type TradingPair = 'BTCUSDT' | 'ETHUSDT' | 'SOLUSDT';
export type TradeDirection = 'LONG' | 'SHORT';
export type OrderSide = 'BUY' | 'SELL';
export type OrderType = 'MARKET' | 'LIMIT' | 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
export type OrderStatus = 'PENDING' | 'FILLED' | 'PARTIAL' | 'CANCELLED' | 'REJECTED';
export type PositionStatus = 'OPEN' | 'CLOSED' | 'LIQUIDATED';
export type TradingMode = 'live' | 'dryrun' | 'replay';
export type Timeframe = '1m' | '3m' | '5m' | '15m' | '30m' | '1h' | '2h' | '4h' | '6h' | '12h' | '1d';
export type SignalStrength = 'WEAK' | 'MODERATE' | 'STRONG' | 'VERY_STRONG';

// ---- CANDLE / OHLCV ----
export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
  quoteVolume: number;
  trades: number;
  takerBuyVolume: number;
  takerSellVolume: number;
}

// ---- MARKET TICKER ----
export interface MarketTicker {
  pair: TradingPair;
  price: number;
  bid: number;
  ask: number;
  spread: number;
  volume24h: number;
  change24h: number;
  timestamp: number;
}

// ---- ORDER BOOK ----
export interface OrderBookLevel {
  price: number;
  quantity: number;
}

export interface OrderBook {
  pair: TradingPair;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  timestamp: number;
}

// ---- TRADE ----
export interface AggregateTrade {
  pair: TradingPair;
  price: number;
  quantity: number;
  side: OrderSide;
  timestamp: number;
  isBuyerMaker: boolean;
}

// ---- SIGNAL ----
export interface TradingSignal {
  id: string;
  pair: TradingPair;
  direction: TradeDirection;
  confidence: number;
  buyScore: number;
  sellScore: number;
  strength: SignalStrength;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  riskReward: number;
  reasons: string[];
  indicators: IndicatorSnapshot;
  volumeAnalysis: VolumeSnapshot;
  patternAnalysis: PatternSnapshot;
  aiValidation?: AIValidationResult;
  timestamp: number;
  timeframe: Timeframe;
  expiresAt: number;
}

// ---- INDICATOR SNAPSHOT ----
export interface IndicatorSnapshot {
  ema20: number;
  ema50: number;
  ema200: number;
  vwap: number;
  rsi: number;
  macdHistogram: number;
  macdLine: number;
  signalLine: number;
  atr: number;
  rsiDivergence: 'bullish' | 'bearish' | 'none';
  trend: 'bullish' | 'bearish' | 'ranging';
}

// ---- VOLUME SNAPSHOT ----
export interface VolumeSnapshot {
  currentVolume: number;
  avgVolume: number;
  volumeRatio: number;
  isVolumeSpike: boolean;
  deltaVolume: number;
  buyVolume: number;
  sellVolume: number;
  buyPressure: number;
  isAbsorption: boolean;
  isLiquiditySweep: boolean;
  isWhaleActivity: boolean;
  isSpoofing: boolean;
  aggressiveBuys: number;
  aggressiveSells: number;
  imbalancePercent: number;
}

// ---- PATTERN SNAPSHOT ----
export interface PatternSnapshot {
  isBreakout: boolean;
  isFakeBreakout: boolean;
  isBOS: boolean;
  isCHOCH: boolean;
  hasOrderBlock: boolean;
  hasFairValueGap: boolean;
  isTrendContinuation: boolean;
  isReversal: boolean;
  orderBlockLevel: number | null;
  fvgHigh: number | null;
  fvgLow: number | null;
  structureLevel: number | null;
}

// ---- AI VALIDATION ----
export interface AIValidationResult {
  isValid: boolean;
  confidence: number;
  reasoning: string;
  risks: string[];
  journal: string;
  agentResults: AgentResult[];
  timestamp: number;
}

export interface AgentResult {
  agentName: string;
  analysis: string;
  score: number;
  flags: string[];
}

// ---- POSITION ----
export interface Position {
  id: string;
  pair: TradingPair;
  direction: TradeDirection;
  entryPrice: number;
  currentPrice: number;
  quantity: number;
  leverage: number;
  margin: number;
  unrealizedPnl: number;
  realizedPnl: number;
  stopLoss: number;
  takeProfit: number;
  liquidationPrice: number;
  roe: number;
  status: PositionStatus;
  openedAt: number;
  closedAt?: number;
  mode: TradingMode;
  signalId: string;
  fees: number;
}

// ---- ORDER ----
export interface TradeOrder {
  id: string;
  positionId: string;
  pair: TradingPair;
  side: OrderSide;
  type: OrderType;
  price: number;
  quantity: number;
  status: OrderStatus;
  filledAt?: number;
  filledPrice?: number;
  createdAt: number;
  mode: TradingMode;
}

// ---- RISK ASSESSMENT ----
export interface RiskAssessment {
  isAllowed: boolean;
  reason?: string;
  positionSize: number;
  riskAmount: number;
  leverage: number;
  stopLossDistance: number;
  riskReward: number;
  currentDrawdown: number;
  dailyLoss: number;
  openPositions: number;
  warnings: string[];
}

// ---- PERFORMANCE METRICS ----
export interface PerformanceMetrics {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  profitFactor: number;
  totalPnl: number;
  maxDrawdown: number;
  maxDrawdownPercent: number;
  avgRR: number;
  avgWin: number;
  avgLoss: number;
  consecutiveWins: number;
  consecutiveLosses: number;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  sharpeRatio: number;
  expectancy: number;
  period: { from: number; to: number };
}

// ---- WHALE ACTIVITY ----
export interface WhaleActivity {
  pair: TradingPair;
  type: 'large_buy' | 'large_sell' | 'accumulation' | 'distribution';
  amount: number;
  amountUsdt: number;
  price: number;
  timestamp: number;
  significance: 'low' | 'medium' | 'high';
}

// ---- MEV DETECTION ----
export interface MEVDetection {
  pair: TradingPair;
  type: 'sandwich' | 'frontrun' | 'backrun' | 'arbitrage';
  suspectedTxHash?: string;
  victimAmount: number;
  profitEstimate: number;
  confidence: number;
  timestamp: number;
}

// ---- SMART MONEY ----
export interface SmartMoneySignal {
  pair: TradingPair;
  action: 'accumulating' | 'distributing' | 'neutral';
  netFlow: number;
  dexInflow: number;
  dexOutflow: number;
  unusualActivity: boolean;
  timestamp: number;
}

// ---- FUNDING RATE ----
export interface FundingRate {
  pair: TradingPair;
  rate: number;
  nextFundingTime: number;
  isNegative: boolean;
  isExtreme: boolean;
}

// ---- REPLAY CONFIG ----
export interface ReplayConfig {
  pair: TradingPair;
  timeframe: Timeframe;
  startTime: number;
  endTime: number;
  speedMultiplier: number;
  isRunning: boolean;
}

// ---- CONFLUENCE SCORE ----
export interface ConfluenceScore {
  pair: TradingPair;
  direction: TradeDirection;
  totalScore: number;
  buyScore: number;
  sellScore: number;
  confidence: number;
  strength: SignalStrength;
  factors: ConfluenceFactor[];
}

export interface ConfluenceFactor {
  name: string;
  score: number;
  weight: number;
  active: boolean;
  description: string;
}
