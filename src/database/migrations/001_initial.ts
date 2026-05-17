import { db } from '../connection';
import { createLogger } from '../../utils/logger';

const log = createLogger('migrations');

export async function runMigrations(): Promise<void> {
  log.info('Running database migrations...');
  await createTables();
  log.info('Migrations complete');
}

async function createTables(): Promise<void> {
  // Migrations table
  await db.query(`
    CREATE TABLE IF NOT EXISTS migrations (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      executed_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Candles table
  await db.query(`
    CREATE TABLE IF NOT EXISTS candles (
      id BIGSERIAL PRIMARY KEY,
      pair VARCHAR(20) NOT NULL,
      timeframe VARCHAR(10) NOT NULL,
      open_time BIGINT NOT NULL,
      open DECIMAL(20,8) NOT NULL,
      high DECIMAL(20,8) NOT NULL,
      low DECIMAL(20,8) NOT NULL,
      close DECIMAL(20,8) NOT NULL,
      volume DECIMAL(30,8) NOT NULL,
      close_time BIGINT NOT NULL,
      quote_volume DECIMAL(30,8) NOT NULL,
      trades INTEGER NOT NULL,
      taker_buy_volume DECIMAL(30,8) NOT NULL,
      taker_sell_volume DECIMAL(30,8) NOT NULL,
      UNIQUE(pair, timeframe, open_time)
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_candles_pair_tf ON candles(pair, timeframe, open_time DESC)`);

  // Signals table
  await db.query(`
    CREATE TABLE IF NOT EXISTS signals (
      id UUID PRIMARY KEY,
      pair VARCHAR(20) NOT NULL,
      direction VARCHAR(10) NOT NULL,
      confidence INTEGER NOT NULL,
      buy_score INTEGER NOT NULL,
      sell_score INTEGER NOT NULL,
      strength VARCHAR(20) NOT NULL,
      entry DECIMAL(20,8) NOT NULL,
      stop_loss DECIMAL(20,8) NOT NULL,
      take_profit DECIMAL(20,8) NOT NULL,
      risk_reward DECIMAL(10,4) NOT NULL,
      reasons JSONB NOT NULL DEFAULT '[]',
      indicators JSONB NOT NULL DEFAULT '{}',
      volume_analysis JSONB NOT NULL DEFAULT '{}',
      pattern_analysis JSONB NOT NULL DEFAULT '{}',
      ai_validation JSONB,
      timeframe VARCHAR(10) NOT NULL,
      expires_at BIGINT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_signals_pair ON signals(pair, created_at DESC)`);

  // Positions table
  await db.query(`
    CREATE TABLE IF NOT EXISTS positions (
      id UUID PRIMARY KEY,
      pair VARCHAR(20) NOT NULL,
      direction VARCHAR(10) NOT NULL,
      entry_price DECIMAL(20,8) NOT NULL,
      current_price DECIMAL(20,8) NOT NULL,
      quantity DECIMAL(20,8) NOT NULL,
      leverage INTEGER NOT NULL,
      margin DECIMAL(20,8) NOT NULL,
      unrealized_pnl DECIMAL(20,8) DEFAULT 0,
      realized_pnl DECIMAL(20,8) DEFAULT 0,
      stop_loss DECIMAL(20,8) NOT NULL,
      take_profit DECIMAL(20,8) NOT NULL,
      liquidation_price DECIMAL(20,8) NOT NULL,
      roe DECIMAL(10,4) DEFAULT 0,
      status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
      opened_at BIGINT NOT NULL,
      closed_at BIGINT,
      mode VARCHAR(20) NOT NULL,
      signal_id UUID REFERENCES signals(id),
      fees DECIMAL(20,8) DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status, pair)`);

  // Orders table
  await db.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id UUID PRIMARY KEY,
      position_id UUID REFERENCES positions(id),
      pair VARCHAR(20) NOT NULL,
      side VARCHAR(10) NOT NULL,
      type VARCHAR(30) NOT NULL,
      price DECIMAL(20,8) NOT NULL,
      quantity DECIMAL(20,8) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
      filled_at BIGINT,
      filled_price DECIMAL(20,8),
      mode VARCHAR(20) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // AI Analysis table
  await db.query(`
    CREATE TABLE IF NOT EXISTS ai_analysis (
      id UUID PRIMARY KEY,
      signal_id UUID REFERENCES signals(id),
      position_id UUID REFERENCES positions(id),
      pair VARCHAR(20) NOT NULL,
      analysis_type VARCHAR(50) NOT NULL,
      reasoning TEXT NOT NULL,
      confidence INTEGER NOT NULL,
      risks JSONB DEFAULT '[]',
      journal TEXT,
      agent_results JSONB DEFAULT '[]',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Performance metrics table
  await db.query(`
    CREATE TABLE IF NOT EXISTS performance_snapshots (
      id BIGSERIAL PRIMARY KEY,
      pair VARCHAR(20),
      total_trades INTEGER DEFAULT 0,
      winning_trades INTEGER DEFAULT 0,
      losing_trades INTEGER DEFAULT 0,
      win_rate DECIMAL(10,4) DEFAULT 0,
      profit_factor DECIMAL(10,4) DEFAULT 0,
      total_pnl DECIMAL(20,8) DEFAULT 0,
      max_drawdown DECIMAL(20,8) DEFAULT 0,
      avg_rr DECIMAL(10,4) DEFAULT 0,
      sharpe_ratio DECIMAL(10,4) DEFAULT 0,
      expectancy DECIMAL(10,4) DEFAULT 0,
      snapshot_date DATE DEFAULT CURRENT_DATE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Risk events table
  await db.query(`
    CREATE TABLE IF NOT EXISTS risk_events (
      id BIGSERIAL PRIMARY KEY,
      pair VARCHAR(20),
      event_type VARCHAR(50) NOT NULL,
      severity VARCHAR(20) NOT NULL,
      description TEXT NOT NULL,
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Whale activity table
  await db.query(`
    CREATE TABLE IF NOT EXISTS whale_activity (
      id BIGSERIAL PRIMARY KEY,
      pair VARCHAR(20) NOT NULL,
      activity_type VARCHAR(50) NOT NULL,
      amount DECIMAL(30,8) NOT NULL,
      amount_usdt DECIMAL(30,8) NOT NULL,
      price DECIMAL(20,8) NOT NULL,
      significance VARCHAR(20) NOT NULL,
      timestamp BIGINT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // MEV detections table
  await db.query(`
    CREATE TABLE IF NOT EXISTS mev_detections (
      id BIGSERIAL PRIMARY KEY,
      pair VARCHAR(20) NOT NULL,
      detection_type VARCHAR(50) NOT NULL,
      suspected_tx_hash VARCHAR(100),
      victim_amount DECIMAL(20,8) NOT NULL,
      profit_estimate DECIMAL(20,8) NOT NULL,
      confidence INTEGER NOT NULL,
      timestamp BIGINT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Replay sessions table
  await db.query(`
    CREATE TABLE IF NOT EXISTS replay_sessions (
      id UUID PRIMARY KEY,
      pair VARCHAR(20) NOT NULL,
      timeframe VARCHAR(10) NOT NULL,
      start_time BIGINT NOT NULL,
      end_time BIGINT NOT NULL,
      speed_multiplier DECIMAL(10,2) DEFAULT 1,
      status VARCHAR(20) DEFAULT 'PENDING',
      results JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Config table
  await db.query(`
    CREATE TABLE IF NOT EXISTS platform_config (
      key VARCHAR(100) PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  log.info('All tables created successfully');
}
