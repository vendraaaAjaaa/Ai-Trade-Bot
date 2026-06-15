# AI Agentic Trading Automation Platform v2

This repository is an experimental AI trading framework and dry-run-first trading research bot for Binance USD-M Futures market analysis. It is testnet-first, uses deterministic execution safeguards, and includes live-trading guardrails, but it should not be treated as production-ready financial infrastructure.

Crypto futures trading is high risk. Never start with real funds. Use dry-run and Binance testnet first, protect your exchange keys, and assume you are responsible for all losses and operational mistakes.

## Core Principles

- AI is used for reasoning, validation, confidence scoring, and anomaly detection.
- Execution remains deterministic, auditable, and rule-based.
- Every signal must pass the full AND-chain; any failed gate means no trade.
- Live trading requires explicit configuration and real-funds confirmation.

## Signal Pipeline

1. Frequency and cooldown check
2. Candle buffer validation
3. Market regime analysis
4. Session analysis
5. Market quality score
6. Regime and session hard gates
7. Quality gate
8. Confluence signal generation
9. Confidence gate
10. Multi-timeframe analysis
11. Patience engine evaluation
12. AI multi-agent validation
13. Consensus voting with vetoes
14. Consensus score gate
15. Risk-reward gate

Approved signals then pass through the risk manager before dry-run or live execution.

## Strategy Modes

| Mode | Trades/Day | Min Confidence | Min RR | Notes |
|------|------------|----------------|--------|-------|
| `scalping` | 5 | 72% | 1.5 | Momentum, London/NY sessions |
| `swing` | 5 | 75% | 2.0 | Trend following, institutional focus |
| `investing` | 1 | 70% | 2.5 | Longer-horizon research mode |
| `safe` | 1 | 90% | 2.5 | Most conservative mode |
| `aggressive` | 8 | 60% | 1.2 | Experimental, higher risk |

## Quick Start

```bash
cp .env.example .env
# Edit .env and set DASHBOARD_API_TOKEN before using the dashboard API.

docker compose --profile dryrun up -d

# Manual backend
npm install
npm run dev

# Manual dashboard
cd dashboard
npm install
npm run dev
```

Backend health check:

```bash
curl http://localhost:3001/health
```

## Environment Validation

Configuration is validated at startup with Zod. Important defaults:

- `TRADING_MODE` defaults to `dryrun`.
- `BINANCE_TESTNET` defaults to `true`.
- Empty Binance keys are allowed only outside live mode.
- Live mode rejects empty or placeholder Binance credentials.
- Real-funds live mode requires:

```bash
TRADING_MODE=live
BINANCE_TESTNET=false
LIVE_TRADING_CONFIRMATION=I_UNDERSTAND_THIS_USES_REAL_FUNDS
```

Production or live mode also requires a non-placeholder `DASHBOARD_API_TOKEN` and explicit `CORS_ORIGINS`.

## Safety Checklist Before Live Mode

- Dry-run results have been reviewed over a meaningful sample.
- Binance testnet has been run with the same strategy mode and risk settings.
- `BINANCE_TESTNET=true` is used until you intentionally switch to real funds.
- API keys are futures keys with the minimum permissions required.
- `DASHBOARD_API_TOKEN` is strong and not exposed on a public dashboard.
- `CORS_ORIGINS` contains only trusted dashboard origins.
- `MAX_DAILY_LOSS_PERCENT`, `MAX_OPEN_POSITIONS`, `MAX_POSITION_SIZE_PERCENT`, and leverage limits are reviewed.
- You understand that stop-loss, take-profit, exchange outages, liquidation, slippage, and API failures can still lose money.

## Security Notes

- Dashboard `/api/*` endpoints require `Authorization: Bearer <DASHBOARD_API_TOKEN>`.
- The health endpoint remains unauthenticated for container health checks.
- CORS is allowlist-based via `CORS_ORIGINS`; wildcard CORS is not used.
- Dashboard/API endpoints include security headers and in-memory rate limiting.
- Do not expose the backend or dashboard directly to the public internet.
- Do not commit `.env`, API keys, Telegram tokens, database passwords, or dashboard tokens.

## Docker Profiles

Use compose profiles for the intended runtime:

```bash
docker compose --profile dryrun up -d
docker compose --profile testnet up -d
docker compose --profile production up -d
```

Postgres and Redis are not published to host ports by default. For local database inspection, use `docker compose exec postgres ...` or add a local-only override file that publishes ports on your machine.

## API Endpoints

Selected dashboard endpoints:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Unauthenticated health check |
| `/api/config` | GET | Runtime mode/config summary |
| `/api/signals` | GET | Latest signals |
| `/api/positions` | GET | Open dry-run positions |
| `/api/positions/:id/close` | POST | Authenticated manual dry-run close |
| `/api/strategy/mode` | GET/POST | Get or set strategy mode |
| `/api/frequency/reset-cooldown` | POST | Authenticated cooldown reset |
| `/api/replay/start` | POST | Authenticated replay start |
| `/api/replay/stop` | POST | Authenticated replay stop |

All `/api/*` requests require the bearer token.

## Known Limitations

- The system is not a guarantee of profitability.
- Dry-run fills, fees, liquidation, and slippage are approximations.
- Exchange connectivity, WebSocket gaps, and REST fallback behavior must be monitored.
- CLI AI agents depend on local Codex/Gemini CLI availability and authentication.
- Dashboard bearer-token auth is suitable for trusted/private deployments, not a full multi-user identity system.
- Live-mode emergency close logic can fail if Binance rejects orders, connectivity is down, or account state is inconsistent.

## Development

```bash
npm run build
npm run lint
npm test
```

CI runs install, build, lint, and tests without real Binance, Redis, Postgres, Telegram, Codex, or Gemini credentials.
