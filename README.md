# ⚡ AI Agentic Trading Automation Platform — v2.0 Disciplined

> "The best trade is often the trade you do NOT take."

A production-ready, **institutionally-disciplined** AI trading platform. v2 transforms the system from a reactive signal hunter into a patient, selective probability filter.

---

## 🧠 Core Philosophy

AI is used ONLY for: reasoning, validation, confidence scoring, anomaly detection.  
All execution is **deterministic, auditable, and rule-based**.  
The system **refuses bad trades** as aggressively as it accepts good ones.

---

## 🔄 v2 Signal Pipeline

```
Market Data
  → Market Regime Engine      (trending / ranging / choppy / manipulative)
  → Chop & Manipulation Gate  (hard block if choppy/manipulative)
  → Session Filter            (London / NY / overlap priority)
  → Market Quality Score      (0–100 gate per strategy mode)
  → Strategy Mode Gate        (regime + session allowed-list check)
  → Confluence Engine         (20-factor weighted scoring)
  → Confidence Gate           (mode-specific minimum)
  → Multi-Timeframe Analysis  (trend / structure / trigger alignment)
  → Patience Engine           (discipline evaluation)
  → AI Multi-Agent Analysis   (7 agents: 5 deterministic + Codex + Gemini)
  → Consensus Voting          (4/7 agents must agree, 0 vetos allowed)
  → Consensus Score Gate      (mode-specific minimum)
  → RR Gate                   (mode-specific minimum)
  → Frequency Limiter         (daily trade cap per mode)
  → Loss Streak Guard         (cooldown after 3 consecutive losses)
  → Risk Manager              (position sizing, daily loss limit)
  → Execution Engine          (dry run / live)
  → Self-Review Engine        (post-trade AI journal)
```

Every gate must pass. Any failure = **NO TRADE** with a logged reason.

---

## 📁 New Modules (v2)

| Module | File | Purpose |
|--------|------|---------|
| Market Regime | `src/regime/marketRegimeEngine.ts` | Classifies trending/ranging/choppy/manipulative |
| Quality Score | `src/quality/marketQualityScore.ts` | 0–100 market quality grade |
| Session Filter | `src/session/sessionFilter.ts` | London/NY/overlap intelligence |
| MTF Analysis | `src/mtf/multiTimeframeAnalysis.ts` | 3-timeframe alignment validation |
| Patience Engine | `src/patience/patienceEngine.ts` | Discipline enforcement |
| Consensus Voting | `src/consensus/consensusVoting.ts` | 7-agent vote system |
| Strategy Modes | `src/strategy/strategyModes.ts` | 5 configurable trading styles |
| Frequency Limiter | `src/strategy/frequencyLimiter.ts` | Daily limits + loss streak cooldown |
| Self Review | `src/review/selfReviewEngine.ts` | Post-trade AI journal generation |
| CLI Runner | `src/ai/shared/cliRunner.ts` | Stdin-pipe subprocess runner |
| Extended Types | `src/utils/types2.ts` | All v2 type definitions |

---

## 🎯 Strategy Modes

| Mode | Trades/Day | Min Confidence | Min RR | Best For |
|------|-----------|----------------|--------|---------|
| `scalping` | 5 | 72% | 1.5 | Momentum, London/NY sessions |
| `swing` | 2 | 75% | 2.0 | Trend following, institutional |
| `investing` | 1 | 70% | 2.5 | ETH/SOL spot accumulation |
| `safe` | 1 | **90%** | 2.5 | Maximum capital preservation |
| `aggressive` | 8 | 60% | 1.2 | Experimental, higher risk |

Change mode via Telegram: `/mode swing`  
Or API: `POST /api/strategy/mode {"mode":"safe"}`

---

## 🤖 7-Agent Consensus System

| # | Agent | Type | Speciality |
|---|-------|------|-----------|
| 1 | VolumeAgent | Deterministic | Spikes, whale, absorption, spoofing |
| 2 | PatternAgent | Deterministic | BOS, CHOCH, OB, FVG, breakout |
| 3 | IndicatorAgent | Deterministic | EMA, RSI divergence, MACD, VWAP |
| 4 | MEVAgent | Deterministic | Front-running, sandwich, manipulation |
| 5 | RiskAgent | Deterministic | RR ratio, SL sizing, volatility |
| 6 | CodexCLIAgent | CLI subprocess | Overall signal reasoning |
| 7 | GeminiCLIAgent | CLI subprocess | Smart money + structure analysis |

**Scoring:** deterministic 60% weight · CLI agents 40%  
**Minimum:** 4/7 agents must vote in signal direction  
**Hard veto:** RiskAgent score < 25 OR both CLI agents flag 2+ risks

---

## 🛡️ Loss Streak Protection

After **3 consecutive losses**:
- System enters **cooldown mode** for 90 minutes
- All new trades blocked
- Telegram alert sent
- AI re-evaluates market conditions

Resume manually: `POST /api/frequency/reset-cooldown`  
Or via Telegram.

---

## 📊 Market Quality Grades

| Score | Grade | Trading |
|-------|-------|---------|
| 90–100 | Excellent | ✅ All modes |
| 70–89 | Tradeable | ✅ Most modes |
| 50–69 | Risky | ⚠️ Aggressive only |
| < 50 | No Trade | ❌ Blocked |

---

## 🚀 Quick Start

```bash
# 1. Extract and setup
cp .env.example .env
# Edit .env — Binance API key minimum

# 2. Docker (recommended)
sudo docker compose up -d

# 3. Manual
npm install && npm run dev          # Backend :3001
cd dashboard && npm install && npm run dev  # Frontend :3000

# 4. One-time CLI auth (free, no API key)
npm install -g @openai/codex @google/gemini-cli
codex auth login
gemini auth login
```

---

## 📡 New API Endpoints (v2)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/regime` | GET | All pair regimes |
| `/api/regime/:pair` | GET | Analyze specific pair regime |
| `/api/quality` | GET | Market quality scores |
| `/api/session` | GET | Current session info |
| `/api/consensus/:pair` | GET | Run consensus vote |
| `/api/strategy/mode` | GET/POST | Get/set strategy mode |
| `/api/strategy/modes` | GET | All mode configs |
| `/api/frequency` | GET | Frequency & loss streak state |
| `/api/frequency/reset-cooldown` | POST | Exit loss streak cooldown |
| `/api/review` | GET | Recent self-review journals |

---

## 🔔 Telegram Commands (v2)

| Command | Description |
|---------|-------------|
| `/status` | Full status: mode, session, streak, wallet |
| `/regime` | All pair regimes |
| `/signals` | Active approved signals |
| `/mode <name>` | Change strategy mode |
| `/help` | Command list |

---

## ⚠️ Disclaimer

Educational and research purposes only. Always use testnet/dryrun before live funds. The authors are not responsible for financial losses.
