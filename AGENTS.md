# AGENTS.md — AI Agentic Trading Platform v2.0

> **This bot manages real capital. Every code change must prioritize capital preservation, reliability, observability, and safety.**

---

## 1. Project Overview

### What This Bot Does

An institutionally-disciplined AI trading platform that trades Binance Futures (BTCUSDT, ETHUSDT, SOLUSDT) using a 15-step signal pipeline with 7 AI agents (5 deterministic + Codex CLI + Gemini CLI), multi-timeframe analysis, market regime classification, and 5 configurable strategy modes.

### Core Philosophy

- AI is used ONLY for reasoning, validation, confidence scoring, and anomaly detection.
- All execution is **deterministic, auditable, and rule-based**.
- The system **refuses bad trades** as aggressively as it accepts good ones.
- "The best trade is often the trade you do NOT take."

### Architecture Summary

```
src/
├── index.ts                    # Bootstrap + event wiring (entry point)
├── config/index.ts             # Zod-validated config from .env
├── signals/signalEngine.ts     # 15-step AND-chain signal pipeline (CRITICAL)
├── risk/riskManager.ts         # Position sizing, daily loss, cooldowns (CRITICAL)
├── execution/
│   ├── dryrun/dryRunExecutor.ts  # Virtual wallet, SL/TP/liquidation
│   └── live/liveExecutor.ts      # Binance Futures API, signed requests
├── ai/
│   ├── agents/agentDefinitions.ts  # 5 deterministic agents
│   ├── codex/codexAgent.ts         # Codex CLI subprocess
│   ├── gemini/geminiAgent.ts       # Gemini CLI subprocess
│   ├── reasoning/reasoningEngine.ts # 7-agent orchestrator
│   └── shared/cliRunner.ts         # Stdin-pipe subprocess runner
├── consensus/consensusVoting.ts  # 7-agent vote system with vetos (CRITICAL)
├── regime/marketRegimeEngine.ts  # Market classification (CRITICAL)
├── quality/marketQualityScore.ts # 0-100 quality grade
├── session/sessionFilter.ts      # London/NY/overlap/asia/dead
├── mtf/multiTimeframeAnalysis.ts # 3-timeframe alignment
├── patience/patienceEngine.ts    # Discipline enforcement
├── strategy/
│   ├── strategyModes.ts          # 5 modes: scalping/swing/investing/safe/aggressive
│   └── frequencyLimiter.ts       # Daily caps + loss streak cooldown (CRITICAL)
├── confluence/confluenceEngine.ts # 20-factor weighted scoring
├── scoring/SignalScoreEngine.ts   # Phase 7 shadow scoring (future)
├── review/selfReviewEngine.ts     # Post-trade AI journal
├── telemetry/signalTelemetry.ts   # Per-filter rejection tracking
├── indicators/indicators.ts      # EMA, RSI, MACD, ATR, VWAP
├── patterns/patternAnalysis.ts    # BOS, CHOCH, OB, FVG
├── volume/volumeAnalysis.ts       # Volume spikes, whale, spoofing
├── smartmoney/smartMoneyAnalysis.ts # MEV detection
├── websocket/binanceWebSocket.ts  # Real-time data + REST fallback
├── telegram/telegramBot.ts        # Alerts + commands
├── market/marketDataService.ts    # Binance REST API
├── analytics/performanceAnalytics.ts # Win rate, PF, drawdown
├── database/                      # PostgreSQL (pg)
├── redis/client.ts                # ioredis cache layer
├── dashboard/apiServer.ts         # Express REST API
└── utils/
    ├── types.ts                   # Core type definitions
    ├── types2.ts                  # v2 extended types
    └── logger.ts                  # Pino structured logging
```

### Tech Stack

- **Language:** TypeScript (strict mode, ES2020)
- **Runtime:** Node.js
- **Database:** PostgreSQL 16 (via `pg`)
- **Cache:** Redis 7 (via `ioredis`)
- **Exchange:** Binance Futures API (REST + WebSocket)
- **Validation:** Zod schema for all config
- **Logging:** Pino (structured JSON in prod, pretty in dev)
- **Notifications:** Telegram Bot API
- **Dashboard:** Next.js (separate `dashboard/` directory)
- **Containerization:** Docker Compose (postgres, redis, backend, dashboard)
- **Testing:** Jest + ts-jest

### Signal Pipeline (15 Steps — Every Gate Must Pass)

```
1.  Frequency & cooldown check       → frequencyLimiter.canTrade()
2.  Candle buffer validation         → min 210 candles required
3.  Market regime analysis           → marketRegimeEngine.analyze()
4.  Session analysis                 → sessionFilter.getCurrentSession()
5.  Market quality score             → marketQualityEngine.score()
6.  Regime + session hard gates      → tradingAllowed checks
7.  Quality gate                     → mode-specific minimum
8.  Confluence signal generation     → confluenceEngine.buildSignal()
9.  Confidence gate                  → mode-specific minimum
10. Multi-timeframe analysis         → mtfAnalysis.analyze()
11. Patience engine evaluation       → patienceEngine.evaluate()
12. AI multi-agent validation        → reasoningEngine.validateSignal()
13. Consensus voting                 → consensusVoting.vote()
14. Consensus score gate             → mode-specific minimum
15. Risk-reward gate                 → mode-specific minimum
```

---

## 2. Architecture Rules

### Allowed Patterns

- **Singleton exports** for stateful services: `export const riskManager = new RiskManager()`
- **EventEmitter** for cross-module communication (signal → execution pipeline)
- **Feature flags** via env vars with safe defaults (new features default ON, scoring engine defaults OFF)
- **Graceful degradation**: Redis unavailable → continue without cache; CLI agents fail → fallback to deterministic
- **Zod schemas** for all configuration validation
- **`createLogger('module-name')`** for structured logging in every module
- **Phase-numbered changes** with documented safety preservation in file headers

### Forbidden Patterns

- ❌ Direct `process.env` access outside `src/config/index.ts`, except Next.js dashboard server-only API proxy routes that must read server env such as `BACKEND_API_URL` and `DASHBOARD_API_TOKEN`
- ❌ Circular imports between modules
- ❌ Synchronous I/O in the signal pipeline
- ❌ Mutable global state outside singleton instances
- ❌ `any` type without explicit justification comment
- ❌ Swallowing errors silently (always log with `log.warn` or `log.error`)
- ❌ Placing business logic in `src/dashboard/apiServer.ts` (API layer is thin)

### Module Boundaries

| Module | May Import From | Must NOT Import |
|--------|----------------|-----------------|
| `signals/` | All analysis modules, config, redis, db | `execution/`, `telegram/`, `dashboard/` |
| `execution/` | `risk/`, `strategy/`, `config`, `redis`, `db` | `signals/`, `consensus/`, `regime/` |
| `consensus/` | `utils/types`, `utils/types2`, `logger` | `signals/`, `execution/`, `risk/` |
| `risk/` | `config`, `redis`, `db`, `logger` | `signals/`, `execution/` |
| `telegram/` | Can read from any module | Must not write to any trading module |
| `config/` | Only `dotenv`, `zod` | Nothing else |

### Data Flow

```
WebSocket/REST → signalEngine.onCandleClose() → evaluateSignal() [15 gates]
    → emit('signal') → index.ts handler → executor.executeSignal()
    → riskManager.assessSignal() → position opened → emit('position_opened')
    → price updates → SL/TP/liquidation checks → emit('position_closed')
    → selfReviewEngine.reviewTrade() → frequencyLimiter.recordWin/Loss()
```

---

## 3. Trading Safety Rules

> **These rules are NON-NEGOTIABLE. Violating any of them is grounds for immediate revert.**

### Hard Safety Invariants

1. **Never remove or weaken the `riskManager.assessSignal()` call** in either executor. Every trade MUST pass risk assessment.
2. **Never remove stop-loss logic** in `dryRunExecutor.updatePositionPrice()` or `liveExecutor.placeSLTPOrders()`.
3. **Never bypass the 15-step AND-chain** in `signalEngine.evaluateSignal()`. Every gate must pass; any failure = NO TRADE.
4. **Never disable the veto system** in `consensusVoting.ts`. Single-veto-kills-trade is a safety invariant.
5. **Never remove drawdown protection** (`maxDailyLossPercent` check in `riskManager.ts` line 42).
6. **Never increase leverage** without explicit user instruction. Max leverage is capped per strategy mode.
7. **Never weaken position sizing** — the 10% balance cap in `riskManager.ts` line 88 is a hard limit.
8. **Never remove the loss streak cooldown** in `frequencyLimiter.ts` (3 consecutive losses → 90-minute block).
9. **Never remove the liquidation check** in `dryRunExecutor.updatePositionPrice()` lines 158-161.
10. **Never allow trades during blocked regimes** — manipulative, choppy, news_volatility, and low_liquidity regimes block trading.

### Safety Priority Order

```
Capital Preservation > Risk Management > Signal Quality > Trade Frequency > Profit Optimization
```

### Critical Safety Points in Code

| File | Lines | What It Protects |
|------|-------|-----------------|
| `riskManager.ts` | 40-44 | Daily loss limit |
| `riskManager.ts` | 47-49 | Max open positions |
| `riskManager.ts` | 52-56 | Post-loss cooldown |
| `riskManager.ts` | 66-72 | Minimum risk-reward ratio |
| `riskManager.ts` | 88 | 10% balance position cap |
| `consensusVoting.ts` | 92-98 | Single-agent veto kills trade |
| `consensusVoting.ts` | 101-104 | 3+ NO_TRADE votes blocks |
| `frequencyLimiter.ts` | 68-79 | Loss streak → cooldown |
| `patienceEngine.ts` | 88-114 | Hard blockers never relaxed |
| `dryRunExecutor.ts` | 158-161 | Liquidation check |
| `dryRunExecutor.ts` | 162-168 | Stop-loss and take-profit |
| `reasoningEngine.ts` | 134-142 | Hard veto (RiskAgent < 25 or dual CLI flags) |
| `marketRegimeEngine.ts` | 140-159 | Regime-based trade blocks |

### Fail-Closed Behavior

All safety systems MUST fail closed:
- If regime analysis fails → `unknownRegime()` → `tradingAllowed: false`
- If Redis is unavailable → risk state resets daily (conservative)
- If CLI agents fail → score defaults to 50 (neutral, not permissive)
- If database query fails → logged, but position state preserved in memory
- If WebSocket disconnects → REST polling fallback at 30s intervals

---

## 4. AI Agent Rules

### 7-Agent Architecture

Agents 1-5 are **deterministic** (pure TypeScript, no API calls). Agents 6-7 are **CLI subprocesses** that gracefully fall back to deterministic rules if CLIs are unavailable.

**Scoring weights:** deterministic = 60%, CLI agents = 40%

### When Modifying Agent Logic

1. **Preserve veto conditions unconditionally:**
   - `VolumeAgent`: spoofing → `NO_TRADE` + veto (line 158-160)
   - `PatternAgent`: fake breakout → `NO_TRADE` + veto (line 186-189)
   - `MEVAgent`: spoofing → `NO_TRADE` + veto (line 259-262)
   - `RiskAgent`: RR < 1.0 → `NO_TRADE` + veto (line 295-298)
   - `RegimeAgent`: manipulative → `NO_TRADE` + veto (line 326-329)

2. **Explain Phase changes** in the file-level JSDoc header (see existing `Phase 2`, `Phase 3` comments as examples).

3. **Preserve deterministic behavior.** Agent votes must be reproducible given the same input. No randomness in vote logic.

4. **Confidence scores must be bounded 0-100.** Use `Math.min()` / `Math.max()` to clamp.

5. **New agents** must implement the `AgentResult` interface and be added to `reasoningEngine.ts`.

### Consensus Voting Invariants

- Required votes are **mode-specific** (safe=5, swing=4, investing=4, aggressive=3, scalping=3)
- `finalScore = consensusScore * 0.6 + avgConfidence * 0.4`
- Trade allowed only if: `finalScore >= 55 && waitVotes <= 2 && noTrades === 0`
- These thresholds must not be lowered without explicit instruction

### Signal Score Engine (Phase 7 — Shadow Mode)

- Currently runs in **shadow mode only** (`USE_SCORING_ENGINE=false`)
- Never blocks or allows real trades
- Do NOT set `USE_SCORING_ENGINE=true` without explicit instruction
- All safety vetoes are replicated in scorers (spoofing, fake-breakout, RR<1, manipulative)

---

## 5. Code Quality Standards

### TypeScript Standards

- **Strict mode** is enabled (`"strict": true` in tsconfig)
- `noImplicitReturns: true` — every code path must return
- Use the existing type system (`types.ts`, `types2.ts`) — add new types there, not inline
- Prefer `interface` for object shapes, `type` for unions and aliases
- Use `readonly` for arrays and objects that should not be mutated

### Coding Patterns

- **SOLID:** Each module has a single responsibility (e.g., `riskManager` only does risk, `sessionFilter` only does sessions)
- **DRY:** Mode-specific configs use `Record<StrategyMode, T>` maps, not repeated if/else
- **KISS:** Signal pipeline is a linear 15-step chain, not a complex graph
- **Small functions:** Follow the existing pattern of private helper methods (see `marketRegimeEngine.ts` helpers)
- **Error handling:** Always `.catch()` on fire-and-forget promises (see Telegram calls in `index.ts`)

### Naming Conventions

- Files: `camelCase.ts` (e.g., `signalEngine.ts`, `riskManager.ts`)
- Classes: `PascalCase` (e.g., `SignalEngine`, `RiskManager`)
- Singleton exports: `camelCase` (e.g., `export const signalEngine = new SignalEngine()`)
- Logger: `createLogger('module-name')` at top of every file
- Redis keys: `namespace:subkey` pattern via `CacheKeys` builder
- Feature flags: `SCREAMING_SNAKE_CASE` env vars (e.g., `ENABLE_DYNAMIC_CONSENSUS`)

---

## 6. Refactoring Rules

### Before Refactoring

1. Identify which safety systems the code touches (see §3 table)
2. Verify existing tests pass before making changes
3. Understand the Phase history documented in file headers

### During Refactoring

- **Fix root causes** — do not add workarounds on top of broken logic
- **Avoid cosmetic changes** — do not rename variables, reformat code, or reorganize imports without functional reason
- **Avoid unnecessary rewrites** — if a module works and has Phase documentation, modify surgically
- **Preserve backward compatibility** — new config fields must have safe defaults in Zod schema
- **Preserve feature flags** — all Phase changes have rollback flags (e.g., `ENABLE_DYNAMIC_CONSENSUS`)

### After Refactoring

- Run `npm run build` (TypeScript compilation)
- Verify no new `any` types were introduced
- Verify safety invariants listed in §3 are intact
- Update Phase comments if behavior changes

---

## 7. Security Rules

### Secrets Management

- ❌ **NEVER** hardcode API keys, secrets, or passwords in source code
- ❌ **NEVER** commit `.env` to git (it's in `.gitignore`)
- ✅ All secrets flow through `src/config/index.ts` from environment variables
- ✅ `.env.example` contains placeholder values only

### Binance API Security

- API signing uses HMAC-SHA256 in `liveExecutor.ts` (`signedRequest()`)
- API key is sent via `X-MBX-APIKEY` header — never in URL params
- Request timeout is 10 seconds — prevents hanging connections
- Testnet mode is controlled by `BINANCE_TESTNET=true`

### Input Validation

- All config is validated through Zod schema at startup — invalid config crashes the process
- WebSocket messages are parsed in try/catch with error logging
- Database queries use parameterized queries (`$1, $2, ...`) — no SQL injection
- Telegram bot input is validated before use (e.g., `/mode` checks against valid list)

### Logging Safety

- ❌ Never log API keys, secrets, or full `.env` contents
- ❌ Never log complete Binance API responses (may contain account details)
- ✅ Log trade decisions, regime classifications, and risk assessments
- ✅ Use structured logging (Pino) with module context

---

## 8. Performance Rules

### API Rate Limits

- REST candle polling interval: **30 seconds** (set in `index.ts` line 133)
- AI validation results cached for **3 minutes** per pair+direction (`reasoningEngine.ts` line 63)
- Market regime cached for **2 minutes** per pair (`marketRegimeEngine.ts` line 40)
- Market quality cached for **90 seconds** per pair (`marketQualityScore.ts` line 18)
- Minimum signal interval: **5 minutes** between evaluations per pair

### Resource Efficiency

- Candle buffers capped at **500 candles** per pair/timeframe (`signalEngine.ts` line 58)
- Redis candle lists trimmed to **500 entries** (`binanceWebSocket.ts` line 254)
- Telemetry rolling lists trimmed to **200 entries** (`signalTelemetry.ts` line 92)
- Redis keys auto-expire via TTL (daily counters: 30h, cache: varies)
- PostgreSQL connection pool: min 2, max 10 (`config/index.ts`)

### WebSocket Management

- Exponential backoff reconnection with 60s cap (never gives up)
- Ping/pong health check every 30 seconds
- Zombie connection detection with 10s pong timeout
- REST polling as ISP-resistant fallback

### Optimization Guidelines

- Prefer incremental candle buffer updates over full re-fetches
- Use Redis caching before hitting PostgreSQL
- Run deterministic agents and CLI agents in parallel (`Promise.allSettled`)
- Fire-and-forget for Telegram notifications (`.catch(() => {})`)
- Never block the signal pipeline on non-critical operations

---

## 9. Configuration Management

### Adding New Config Fields

1. Add the Zod schema field with a **safe default** in `src/config/index.ts`
2. Add the env var parsing in the `parseConfig()` function
3. Add the env var to `.env.example` with a descriptive comment
4. Document the field in the Phase header comment if it's a feature flag

Dashboard authentication variables are special:
- `DASHBOARD_API_TOKEN` and `BACKEND_API_TOKEN` are server-only and must never use a `NEXT_PUBLIC_` prefix.
- Browser dashboard calls must go through local `/api/backend/*` proxy routes.
- `NEXT_PUBLIC_API_URL` is allowed only for non-secret browser-visible connectivity such as Socket.IO.

### Feature Flag Convention

All Phase features use this pattern:
```typescript
// In config schema:
featureFlags: z.object({
  myNewFeature: z.boolean().default(true),  // default ON for new behavior
})

// In config parsing:
myNewFeature: process.env['ENABLE_MY_FEATURE'] !== 'false',  // opt-OUT pattern

// In module:
const ENABLE_MY_FEATURE = process.env['ENABLE_MY_FEATURE'] !== 'false';
```

### Strategy Mode Config

When adding or modifying strategy modes in `strategyModes.ts`:
- Every `StrategyConfig` field must be set for all 5 modes
- `safe` mode must always be the most conservative
- `aggressive` mode configs must never exceed existing `maxLeverage: 20`
- Update the README table if thresholds change

---

## 10. Testing Requirements

### Before Any Task Is Complete

- [ ] `npm run build` passes with no TypeScript errors
- [ ] Trading safety invariants (§3) are preserved
- [ ] Feature flags have safe defaults
- [ ] No hardcoded secrets introduced
- [ ] Risk manager assessment is not bypassed
- [ ] Stop-loss and liquidation checks are intact
- [ ] Veto system in consensus voting is intact
- [ ] Loss streak cooldown logic is intact

### When Modifying Specific Modules

| Module Modified | Must Verify |
|----------------|------------|
| `riskManager.ts` | Daily loss limit, max positions, cooldown, RR check, position sizing cap |
| `signalEngine.ts` | All 15 gates still enforce AND-chain, no gate removed |
| `consensusVoting.ts` | Veto kills trade, mode-specific thresholds, `finalScore` formula |
| `dryRunExecutor.ts` | SL/TP/liquidation checks, wallet balance updates, PnL calculation |
| `liveExecutor.ts` | API signing, SL/TP order placement, risk assessment call |
| `frequencyLimiter.ts` | Daily cap per mode, loss streak threshold, cooldown duration |
| `config/index.ts` | Zod defaults are safe, new fields don't break existing deployments |
| `patienceEngine.ts` | Hard blockers are never relaxed, soft-fail limits per mode |
| `marketRegimeEngine.ts` | Manipulative/choppy/low_liquidity regimes block trading |

---

## 11. Documentation Requirements

### Update Documentation When

- [ ] A new module or file is added → update Architecture section in README
- [ ] Trading behavior changes → update signal pipeline description
- [ ] Strategy mode thresholds change → update README mode table
- [ ] New API endpoints added → update README API table
- [ ] New Telegram commands added → update README commands table
- [ ] New environment variables added → update `.env.example`
- [ ] New Phase implemented → add Phase header comment in affected files

### Phase Comment Convention

Every file modified as part of a Phase must include a header block:
```typescript
/**
 * =============================================
 * MODULE_NAME — Phase N
 * =============================================
 *
 * Changes from Phase N:
 *   - Description of change 1
 *   - Description of change 2
 *
 * Safety preserved:
 *   - What safety invariants remain intact
 *   - What was NOT changed
 */
```

---

## 12. Debugging Workflow

### Required Steps

1. **Reproduce the issue** — identify which pair, timeframe, mode, and session trigger it
2. **Check telemetry** — use `getAnalyticsSnapshot()` or `DEBUG_SIGNAL_FLOW=true` to see which gate is rejecting
3. **Check regime** — is the pair in choppy/manipulative regime?
4. **Check frequency** — is the daily limit reached or cooldown active?
5. **Find root cause** — trace through the 15-step pipeline in `signalEngine.evaluateSignal()`
6. **Implement minimal fix** — surgical change, not a rewrite
7. **Verify side effects** — check that other modes and pairs are not affected
8. **Document findings** — add comments explaining why the fix was needed

### Common Issues

| Symptom | Likely Cause | Check |
|---------|-------------|-------|
| No trades for hours | Regime blocking, choppy detection | `CHOPPY_SCORE_THRESHOLD`, regime cache |
| Signal rejected at consensus | Not enough directional votes | Vote distribution log, `ENABLE_DYNAMIC_CONSENSUS` |
| Signal rejected at patience | Too many soft fails | `ENABLE_SOFT_FAIL_TOLERANCE`, mode-specific limits |
| WebSocket not receiving data | ISP blocking, connection zombie | REST polling fallback, ping timeout logs |
| CLI agents returning 50 | CLIs not authenticated | `codex auth login`, `gemini auth login` |

---

## 13. Pull Request Checklist

### Mandatory Checks

- [ ] **Build:** `npm run build` passes
- [ ] **Safety:** All trading safety invariants in §3 preserved
- [ ] **No secrets:** No API keys, passwords, or tokens in code
- [ ] **Config:** New env vars have safe defaults in Zod schema
- [ ] **Config:** `.env.example` updated if new vars added
- [ ] **Types:** No untyped `any` without justification comment
- [ ] **Logging:** New code paths have appropriate log statements
- [ ] **Error handling:** Async operations have error handling
- [ ] **Feature flags:** New behavior has opt-out flag if risky
- [ ] **Phase docs:** File headers updated with Phase description
- [ ] **No regressions:** Existing modes (safe, swing, etc.) still work
- [ ] **README:** Updated if user-facing behavior changes

### For Trading Logic Changes

- [ ] Risk manager assessment still required before every trade
- [ ] Stop-loss logic intact in both executors
- [ ] Veto system in consensus voting preserved
- [ ] Loss streak cooldown not bypassed
- [ ] Position sizing cap (10% balance) preserved
- [ ] Daily loss limit check preserved
- [ ] Liquidation check in dry-run executor preserved

---

## 14. Forbidden Actions

> **Any of these will cause financial loss or system instability. NEVER do them.**

| Action | Why It's Dangerous |
|--------|-------------------|
| Removing `riskManager.assessSignal()` call | Trades execute without risk checks |
| Disabling veto in `consensusVoting.ts` | Manipulated/spoofed markets can trigger trades |
| Removing SL/TP checks in executors | Positions run without protection |
| Setting `USE_SCORING_ENGINE=true` without testing | Untested scoring replaces battle-tested AND-chain |
| Hardcoding API keys | Secrets exposed in git history |
| Removing `frequencyLimiter` checks | Loss streaks compound without cooldown |
| Bypassing regime-based trade blocks | Bot trades in manipulative/choppy markets |
| Lowering `safe` mode thresholds | Defeats the purpose of capital preservation mode |
| Removing `patienceEngine` hard blockers | Critical safety gates become soft gates |
| Deleting Phase header comments | Loses institutional knowledge of why changes were made |
| Making signal pipeline gates OR instead of AND | Dramatically increases false-positive trade rate |
| Removing self-review after position close | Loses learning feedback loop |
| Ignoring TypeScript strict mode errors | Type safety is the first line of defense |
| Removing graceful shutdown handlers | Positions may not be properly tracked on restart |

---

## 15. Environment & Deployment

### Running Locally

```bash
cp .env.example .env           # Edit with real Binance API keys
docker compose up -d postgres redis  # Start infra without publishing DB/Redis ports
npm install && npm run dev     # Start backend on :3001
cd dashboard && npm install && npm run dev  # Start frontend on :3000
```

For the dashboard proxy, set `BACKEND_API_URL=http://localhost:3001` during local manual runs and keep `DASHBOARD_API_TOKEN` server-only.

### Docker Deployment

```bash
docker compose --profile dryrun up -d  # Starts postgres, redis, backend, dashboard
```

- Backend uses the `trading_net` compose network for Postgres/Redis access
- Dashboard uses `BACKEND_API_URL=http://backend:3001` inside Compose and injects `DASHBOARD_API_TOKEN` only from the server-side proxy
- Postgres/Redis are not exposed to the host by default
- PostgreSQL data persisted in `postgres_data` volume
- Redis configured with 256MB LRU eviction
- Logs mounted at `./logs:/app/logs`

### Health Checks

- Backend: `GET http://localhost:3001/health`
- PostgreSQL: `pg_isready -U postgres`
- Redis: `redis-cli ping`

---

## 16. Key Constants Reference

| Constant | Value | Location | Purpose |
|----------|-------|----------|---------|
| `LOSS_STREAK_THRESHOLD` | 3 | `frequencyLimiter.ts` | Consecutive losses before cooldown |
| `COOLDOWN_HOURS` | 1.5 | `frequencyLimiter.ts` | Cooldown duration after loss streak |
| `REGIME_CACHE_TTL` | 120s | `marketRegimeEngine.ts` | Regime cache duration |
| `CHOPPY_THRESHOLD` | 7 (of 9) | `marketRegimeEngine.ts` | Choppy market detection |
| `REQUIRED_VOTES` | 3-5/7 | `consensusVoting.ts` | Mode-specific directional votes needed |
| Min candles | 210 | `signalEngine.ts` | Buffer requirement for signal evaluation |
| Candle buffer cap | 500 | `signalEngine.ts` | Max candles kept per pair/timeframe |
| REST poll interval | 30s | `index.ts` | Candle polling fallback frequency |
| Agent cache TTL | 180s | `reasoningEngine.ts` | AI validation cache duration |
| Position size cap | 10% | `riskManager.ts` | Max single position as % of balance |
