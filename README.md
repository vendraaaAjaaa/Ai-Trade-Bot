# ⚡ AI Agentic Trading Automation Platform

A production-ready, AI-assisted crypto trading platform for **BTCUSDT**, **ETHUSDT**, and **SOLUSDT** — supporting Binance Futures, Dry Run / Paper Trading, Replay, Backtesting, and a real-time Next.js dashboard.

---

## 🧠 Architecture Philosophy

> AI is used ONLY as reasoning, validation, confidence scoring, and anomaly detection.  
> All trade execution is **deterministic, auditable, and rule-based**.

---

## 🗂 Project Structure

```
trading-platform/
├── src/                         # Backend (Node.js + TypeScript)
│   ├── config/                  # Environment & Zod config schema
│   ├── database/                # PostgreSQL pool + migrations
│   ├── redis/                   # Redis client + cache keys
│   ├── market/                  # Market data service (REST + cache)
│   ├── websocket/               # Binance WebSocket streaming
│   ├── indicators/              # EMA, RSI, MACD, ATR, VWAP
│   ├── patterns/                # BOS, CHOCH, OB, FVG, Breakout
│   ├── volume/                  # Spike, Delta, Absorption, Whale
│   ├── smartmoney/              # Whale tracking, MEV detection
│   ├── ai/
│   │   ├── agents/              # 5 specialized AI agents
│   │   └── reasoning/           # Multi-agent orchestrator
│   ├── confluence/              # Weighted scoring engine
│   ├── signals/                 # Signal generation pipeline
│   ├── execution/
│   │   ├── live/                # Real Binance orders
│   │   └── dryrun/              # Virtual wallet simulation
│   ├── replay/                  # Historical replay engine
│   ├── risk/                    # Risk manager (daily loss, cooldown, sizing)
│   ├── analytics/               # Performance metrics
│   ├── telegram/                # Telegram bot notifications
│   ├── dashboard/               # Express API + Socket.IO server
│   └── utils/                   # Types, logger
├── dashboard/                   # Frontend (Next.js + Tailwind + Recharts)
│   ├── pages/                   # index.tsx main dashboard
│   ├── hooks/                   # useSocket, useTrading
│   └── lib/                     # API client
├── docker/                      # Dockerfiles
├── docker-compose.yml
├── .env.example
└── README.md
```

---

## 🚀 Quick Start

### 1. Prerequisites

- Node.js 20+
- PostgreSQL 16+
- Redis 7+
- Docker & Docker Compose (optional)

### 2. Clone & Install

```bash
git clone <repo-url>
cd trading-platform

# Backend
npm install

# Dashboard
cd dashboard && npm install && cd ..
```

### 3. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your settings:

```bash
# Binance API (use testnet for safety)
BINANCE_API_KEY=your_key
BINANCE_API_SECRET=your_secret
BINANCE_TESTNET=true

# Database
DB_HOST=localhost
DB_USER=postgres
DB_PASSWORD=postgres123

# AI (optional but recommended)
OPENAI_API_KEY=sk-...
# or
GEMINI_API_KEY=...
AI_PROVIDER=openai

# Telegram (optional)
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...

# Trading mode: dryrun | live | replay
TRADING_MODE=dryrun
```

### 4. Start with Docker (Recommended)

```bash
docker-compose up -d
```

- Dashboard: http://localhost:3000
- API: http://localhost:3001
- Health: http://localhost:3001/health

### 5. Start Manually

```bash
# Terminal 1 — Backend
npm run dev

# Terminal 2 — Dashboard
cd dashboard && npm run dev
```

---

## 🔧 Trading Modes

| Mode | Description |
|------|-------------|
| `dryrun` | Virtual wallet, simulated fills, fees, slippage & liquidation |
| `live` | Real Binance Futures orders with SL/TP automation |
| `replay` | Historical candle-by-candle replay with AI signal analysis |

Set `TRADING_MODE=dryrun` in `.env` before using live mode.

---

## 📊 Signal Engine

### Confluence Scoring (Weighted)

| Factor | Score |
|--------|-------|
| Whale Activity | +25 |
| Order Block | +22 |
| Volume Spike | +20 |
| Break of Structure | +20 |
| EMA Bullish Stack | +18 |
| Breakout | +18 |
| RSI Bullish Divergence | +15 |
| Change of Character | +15 |
| Trend Continuation | +15 |
| Absorption | +15 |
| Fake Breakout | **-30** |
| EMA Bearish Stack | **-18** |
| Spoofing Detected | **-15** |

Minimum confidence to generate a signal: **70%** (configurable)

---

## 🤖 AI Multi-Agent System

Five agents run in **parallel** for every signal:

| Agent | Responsibility |
|-------|---------------|
| `VolumeAgent` | Volume behavior, whale activity, absorption |
| `PatternAgent` | Market structure, BOS, CHOCH, OB, FVG |
| `IndicatorAgent` | EMA, RSI divergence, MACD, VWAP |
| `MEVAgent` | Smart money, sandwich detection, front-running |
| `RiskAgent` | RR validation, SL sizing, volatility |

AI generates:
- ✅ Signal validation (valid/invalid)
- 📊 Confidence score per agent
- 📝 Trade journal narrative
- ⚠️ Risk flags

> AI can **suggest** a signal is invalid, but it cannot directly override the risk engine or execute orders.

---

## 🛡️ Risk Management

| Parameter | Default | Config Key |
|-----------|---------|-----------|
| Max Daily Loss | 5% | `MAX_DAILY_LOSS_PERCENT` |
| Max Open Positions | 3 | `MAX_OPEN_POSITIONS` |
| Cooldown After Loss | 30 min | `COOLDOWN_AFTER_LOSS_MINUTES` |
| Min RR Ratio | 1.5 | `RISK_REWARD_MIN` |
| Max Leverage | 20x | `MAX_LEVERAGE` |
| Volatility Threshold | 5% | `VOLATILITY_THRESHOLD` |

---

## 📡 API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | System health check |
| `/api/signals` | GET | All latest signals |
| `/api/signals/:pair` | GET | Signal for specific pair |
| `/api/signals/evaluate` | POST | Force evaluate signal |
| `/api/positions` | GET | Open positions |
| `/api/positions/history` | GET | Trade history |
| `/api/positions/:id/close` | POST | Close position |
| `/api/wallet` | GET | Virtual wallet state |
| `/api/analytics/metrics` | GET | Performance metrics |
| `/api/analytics/daily-pnl` | GET | Daily PnL data |
| `/api/risk/state` | GET | Risk manager state |
| `/api/market/candles/:pair` | GET | OHLCV candles |
| `/api/market/price/:pair` | GET | Current price |
| `/api/market/funding/:pair` | GET | Funding rate |
| `/api/replay/start` | POST | Start replay |
| `/api/replay/stop` | POST | Stop replay |
| `/api/ai/analysis` | GET | AI analysis history |
| `/api/config` | GET | Platform configuration |

---

## 🔔 Telegram Commands

| Command | Description |
|---------|-------------|
| `/status` | Platform status & performance |
| `/signals` | Latest signals |
| `/positions` | Open positions |
| `/help` | Command list |

---

## 📈 Dashboard Features

- **Overview** — Wallet, equity, daily PnL chart, risk monitor
- **Signals** — Live signal feed with confidence meter & AI journal
- **Positions** — Open positions with PnL, ROE, liquidation price
- **AI Reasoning** — Agent scores, validation, risk flags
- **Analytics** — Win rate, profit factor, Sharpe ratio, drawdown
- **Replay** — Historical backtest with speed control

---

## 🔐 Security

- All API keys stored in environment variables
- Binance testnet mode by default
- No hardcoded credentials
- Rate limiting on API requests
- WebSocket reconnection with exponential backoff

---

## ⚠️ Important Disclaimer

This platform is for educational and research purposes.  
Crypto trading carries significant financial risk.  
Always test on **testnet/dryrun** before using real funds.  
The authors are not responsible for financial losses.

---

## 🤖 Codex CLI & Gemini CLI Integration

The platform uses **7 agents** running in parallel for every signal:

### Agent Roster

| # | Agent | Type | Requires |
|---|-------|------|---------|
| 1 | `VolumeAgent` | Deterministic | Nothing |
| 2 | `PatternAgent` | Deterministic | Nothing |
| 3 | `IndicatorAgent` | Deterministic | Nothing |
| 4 | `MEVAgent` | Deterministic | Nothing |
| 5 | `RiskAgent` | Deterministic | Nothing |
| 6 | `CodexCLIAgent` | CLI subprocess | `OPENAI_API_KEY` + Codex CLI |
| 7 | `GeminiCLIAgent` | CLI subprocess | `GEMINI_API_KEY` + Gemini CLI |

### Installing the CLIs

```bash
# Codex CLI (OpenAI)
npm install -g @openai/codex

# Gemini CLI (Google)
npm install -g @google/gemini-cli
```

Set your keys in `.env`:
```bash
OPENAI_API_KEY=sk-...
GEMINI_API_KEY=AIza...
```

Both CLIs are invoked as **child processes** with structured prompts. They respond in a parsed format (`SCORE: / JOURNAL: / RISK:`). If a CLI is not installed, the system automatically falls back to deterministic rule-based analysis — **the platform always runs**.

### Weighted Scoring

```
Final Score = deterministicAvg × 0.6 + cliAvg × 0.4
```

### Hard Veto Conditions
- `RiskAgent` score < 25 → signal blocked
- Both Codex CLI AND Gemini CLI flag 2+ `RISK:` items → signal blocked
