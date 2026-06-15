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
# Edit .env and set a strong server-only DASHBOARD_API_TOKEN before using the dashboard.

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

Dashboard proxy configuration:

- `BACKEND_API_URL` is read only by the Next.js server-side proxy. In Docker it should usually be `http://backend:3001`.
- `DASHBOARD_API_TOKEN` is server-only. It is shared by the backend API and the dashboard proxy, and must not use a `NEXT_PUBLIC_` prefix.
- `NEXT_PUBLIC_API_URL` is optional and browser-visible. It is only for Socket.IO/browser connectivity and must never contain secrets.
- `DRYRUN_RESTORE_OPEN_POSITIONS=true` restores open dry-run positions from the database after restart.
- `DRYRUN_STRICT_RESTORE=false` skips invalid restored rows; set it to `true` to fail startup on any invalid restore row.

## Safety Checklist Before Live Mode

- Dry-run results have been reviewed over a meaningful sample.
- Binance testnet has been run with the same strategy mode and risk settings.
- `BINANCE_TESTNET=true` is used until you intentionally switch to real funds.
- API keys are futures keys with the minimum permissions required.
- `DASHBOARD_API_TOKEN` is strong, server-only, and not exposed through any `NEXT_PUBLIC_*` variable.
- `CORS_ORIGINS` contains only trusted dashboard origins.
- `MAX_DAILY_LOSS_PERCENT`, `MAX_OPEN_POSITIONS`, `MAX_POSITION_SIZE_PERCENT`, `MAX_POSITION_NOTIONAL_PERCENT`, and leverage limits are reviewed.
- The live circuit breaker is clear, and any prior emergency-close failure has been manually inspected on Binance.
- You understand that stop-loss, take-profit, exchange outages, liquidation, slippage, and API failures can still lose money.

## Security Notes

- Backend `/api/*` endpoints require `Authorization: Bearer <DASHBOARD_API_TOKEN>`.
- Browser dashboard code calls relative `/api/backend/*` routes. The Next.js server proxy injects the bearer token server-side.
- The browser never receives `DASHBOARD_API_TOKEN` or any backend bearer token.
- The dashboard proxy has an allowlist of backend paths and does not forward arbitrary URLs.
- The health endpoint remains unauthenticated for container health checks.
- CORS is allowlist-based via `CORS_ORIGINS`; wildcard CORS is not used.
- Dashboard/API endpoints include security headers and in-memory rate limiting.
- Do not expose the backend or dashboard directly to the public internet.
- Do not commit `.env`, API keys, Telegram tokens, database passwords, or dashboard tokens.

## Risk Configuration

- `MAX_POSITION_SIZE_PERCENT` limits account balance at risk per trade. It is based on entry-to-stop distance.
- `MAX_POSITION_NOTIONAL_PERCENT` caps gross position notional as a percentage of balance. It defaults to `10`, must be greater than `0`, and cannot exceed `100`.
- `MAX_LEVERAGE` and `DEFAULT_LEVERAGE` control leverage; default leverage must not exceed the configured maximum or the hard cap of 20.
- Risk checks fail closed when balances, stop distance, leverage, caps, or signal numeric fields are invalid.

## Live Circuit Breaker

If live protective order placement fails, the executor attempts an immediate reduce-only emergency close. If that emergency close also fails, the result is `EMERGENCY_CLOSE_FAILED`, live trading is disabled by a persistent circuit breaker, and an urgent Telegram/operator alert is attempted.

The alert states that manual exchange/account inspection is required and includes the pair, direction, quantity, exchange order id when available, timestamp, and error message. Alert delivery failures are logged but do not clear the breaker.

Read circuit breaker state:

```bash
curl -H "Authorization: Bearer $DASHBOARD_API_TOKEN" \
  http://localhost:3001/api/live/circuit-breaker
```

Reset only after manual exchange inspection:

```bash
curl -X POST -H "Authorization: Bearer $DASHBOARD_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason":"operator inspected Binance account and confirmed exposure is flat"}' \
  http://localhost:3001/api/live/circuit-breaker/reset
```

## Dry-Run Restore

Dry-run startup loads the persisted wallet and, by default, reconstructs open dry-run positions from DB rows where `mode='dryrun'` and `status='OPEN'`. Rows with invalid pair, direction, quantity, entry price, leverage, or timestamp are skipped unless `DRYRUN_STRICT_RESTORE=true`.

If the DB restore fails while the wallet has reserved margin, dry-run initialization fails closed because the process cannot safely know which positions are open. If no margin is reserved, dry-run can continue with an empty open-position set.

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
| `/api/live/circuit-breaker` | GET | Authenticated live circuit breaker status |
| `/api/live/circuit-breaker/reset` | POST | Authenticated manual circuit breaker reset with reason |
| `/api/strategy/mode` | GET/POST | Get or set strategy mode |
| `/api/frequency/reset-cooldown` | POST | Authenticated cooldown reset |
| `/api/replay/start` | POST | Authenticated replay start |
| `/api/replay/stop` | POST | Authenticated replay stop |

All backend `/api/*` requests require the bearer token. Dashboard browser code should call `/api/backend/*`; the Next.js server proxy forwards only allowlisted routes and adds the token server-side.

## Known Limitations

- The system is not a guarantee of profitability.
- Dry-run fills, fees, liquidation, and slippage are approximations.
- Exchange connectivity, WebSocket gaps, and REST fallback behavior must be monitored.
- CLI AI agents depend on local Codex/Gemini CLI availability and authentication.
- Dashboard bearer-token auth and the server-side proxy are suitable for trusted/private deployments, not a full multi-user identity system.
- Live-mode emergency close logic can fail if Binance rejects orders, connectivity is down, or account state is inconsistent.

## Development

```bash
npm run build
npm run lint
npm test
```

CI runs install, build, lint, and tests without real Binance, Redis, Postgres, Telegram, Codex, or Gemini credentials.
