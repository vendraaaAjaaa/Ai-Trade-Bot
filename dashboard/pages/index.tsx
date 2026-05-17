import { useState, useEffect } from 'react';
import Head from 'next/head';
import {
  Activity, TrendingUp, TrendingDown, AlertTriangle, Cpu, BarChart2,
  RefreshCw, Terminal, Radio, Layers, Shield, PlayCircle, StopCircle, Zap,
} from 'lucide-react';
import {
  AreaChart, Area, BarChart, Bar, LineChart, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, Cell,
} from 'recharts';
import { useSocket } from '../hooks/useSocket';
import { useTrading } from '../hooks/useTrading';
import { apiClient } from '../lib/apiClient';
import { format } from 'date-fns';

const PAIRS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];

// ---- Utility helpers ----
const fmt = (n: number, d = 2) => (n ?? 0).toFixed(d);
const fmtPct = (n: number) => `${n >= 0 ? '+' : ''}${fmt(n)}%`;
const fmtUsd = (n: number) => `$${Math.abs(n).toFixed(2)}`;
const clx = (...args: (string | false | undefined)[]) => args.filter(Boolean).join(' ');

// ---- Sub-components ----

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span className={clx('inline-block w-2 h-2 rounded-full', ok ? 'bg-accent-green live-dot' : 'bg-accent-red live-dot-red')} />
  );
}

function StatCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="card flex flex-col gap-1">
      <span className="stat-label">{label}</span>
      <span className={clx('stat-value', color)}>{value}</span>
      {sub && <span className="text-xs text-gray-500">{sub}</span>}
    </div>
  );
}

function ConfidenceMeter({ value }: { value: number }) {
  const color = value >= 80 ? '#00d4a0' : value >= 65 ? '#ffd32a' : '#ff4757';
  return (
    <div className="w-full">
      <div className="flex justify-between text-xs mb-1">
        <span className="text-gray-400">Confidence</span>
        <span className="font-mono" style={{ color }}>{value}%</span>
      </div>
      <div className="h-2 bg-dark-600 rounded-full overflow-hidden">
        <div
          className="h-full rounded-full confidence-bar"
          style={{ width: `${value}%`, backgroundColor: color }}
        />
      </div>
    </div>
  );
}

function SignalCard({ signal }: { signal: any }) {
  const isLong = signal.direction === 'LONG';
  return (
    <div className={clx('card border animate-fade-in', isLong ? 'border-accent-green/30' : 'border-accent-red/30')}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="font-bold text-white">{signal.pair}</span>
          <span className={clx('text-xs font-mono px-2 py-0.5 rounded', isLong ? 'badge-long' : 'badge-short')}>
            {signal.direction}
          </span>
          <span className="text-xs text-gray-400 font-mono">{signal.strength}</span>
        </div>
        <span className="text-xs text-gray-500 font-mono">
          {signal.timestamp ? format(new Date(signal.timestamp), 'HH:mm:ss') : ''}
        </span>
      </div>

      <ConfidenceMeter value={signal.confidence || 0} />

      <div className="grid grid-cols-3 gap-2 mt-3 text-xs font-mono">
        <div><div className="text-gray-400">Entry</div><div className="text-white">{fmt(signal.entry, 4)}</div></div>
        <div><div className="text-gray-400">Stop Loss</div><div className="text-accent-red">{fmt(signal.stopLoss, 4)}</div></div>
        <div><div className="text-gray-400">Take Profit</div><div className="text-accent-green">{fmt(signal.takeProfit, 4)}</div></div>
      </div>

      <div className="mt-2 flex items-center gap-3 text-xs">
        <span className="text-gray-400">R:R</span>
        <span className="font-mono text-accent-blue">{fmt(signal.riskReward, 2)}:1</span>
        {signal.aiValidation && (
          <>
            <span className="text-gray-400">AI Score</span>
            <span className="font-mono text-accent-yellow">{signal.aiValidation.confidence}%</span>
          </>
        )}
      </div>

      {signal.reasons && signal.reasons.length > 0 && (
        <div className="mt-3 pt-3 border-t border-dark-600">
          <div className="text-xs text-gray-400 mb-1">Reasons</div>
          <div className="flex flex-wrap gap-1">
            {signal.reasons.slice(0, 4).map((r: string, i: number) => (
              <span key={i} className="text-xs bg-dark-600 text-gray-300 px-2 py-0.5 rounded">{r}</span>
            ))}
          </div>
        </div>
      )}

      {signal.aiValidation?.journal && (
        <div className="mt-3 pt-3 border-t border-dark-600">
          <div className="text-xs text-gray-400 mb-1 flex items-center gap-1"><Cpu size={10} /> AI Journal</div>
          <p className="text-xs text-gray-300 italic leading-relaxed">{signal.aiValidation.journal.substring(0, 180)}...</p>
        </div>
      )}
    </div>
  );
}

function PositionCard({ position, onClose }: { position: any; onClose: (id: string) => void }) {
  const isLong = position.direction === 'LONG';
  const pnl = position.unrealized_pnl ?? position.unrealizedPnl ?? 0;
  const roe = position.roe ?? 0;
  const pnlPositive = pnl >= 0;

  return (
    <div className="card border border-dark-500 animate-fade-in">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="font-bold">{position.pair}</span>
          <span className={isLong ? 'badge-long' : 'badge-short'}>{position.direction}</span>
          <span className="text-xs text-gray-400">{position.leverage}x</span>
        </div>
        <button
          onClick={() => onClose(position.id)}
          className="text-xs text-gray-400 hover:text-accent-red transition-colors px-2 py-1 border border-dark-500 rounded hover:border-accent-red"
        >
          Close
        </button>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs font-mono mt-2">
        <div className="flex justify-between"><span className="text-gray-400">Entry</span><span>{fmt(position.entry_price ?? position.entryPrice, 4)}</span></div>
        <div className="flex justify-between"><span className="text-gray-400">Current</span><span>{fmt(position.current_price ?? position.currentPrice, 4)}</span></div>
        <div className="flex justify-between"><span className="text-gray-400">SL</span><span className="text-accent-red">{fmt(position.stop_loss ?? position.stopLoss, 4)}</span></div>
        <div className="flex justify-between"><span className="text-gray-400">TP</span><span className="text-accent-green">{fmt(position.take_profit ?? position.takeProfit, 4)}</span></div>
        <div className="flex justify-between col-span-2 mt-1 pt-1 border-t border-dark-600">
          <span className="text-gray-400">Unrealized PnL</span>
          <span className={pnlPositive ? 'text-accent-green' : 'text-accent-red'}>
            {pnlPositive ? '+' : ''}{fmtUsd(pnl)} ({fmt(roe, 2)}%)
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-400">Liquidation</span>
          <span className="text-accent-yellow">{fmt(position.liquidation_price ?? position.liquidationPrice, 4)}</span>
        </div>
      </div>
    </div>
  );
}

function AIReasoningPanel({ signals }: { signals: any[] }) {
  const withAI = signals.filter((s) => s.aiValidation);
  if (withAI.length === 0) return (
    <div className="card text-center text-gray-500 py-8"><Cpu size={24} className="mx-auto mb-2 opacity-40" /><p>No AI analysis available</p></div>
  );

  return (
    <div className="space-y-3">
      {withAI.slice(0, 3).map((s: any) => (
        <div key={s.id} className="card">
          <div className="flex items-center gap-2 mb-2">
            <Cpu size={14} className="text-accent-blue" />
            <span className="font-bold text-sm">{s.pair}</span>
            <span className={s.direction === 'LONG' ? 'badge-long' : 'badge-short'}>{s.direction}</span>
            <span className={clx('text-xs ml-auto', s.aiValidation.isValid ? 'text-accent-green' : 'text-accent-red')}>
              {s.aiValidation.isValid ? '✓ VALID' : '✗ INVALID'}
            </span>
          </div>
          {s.aiValidation.journal && (
            <p className="text-xs text-gray-300 italic mb-2 leading-relaxed">{s.aiValidation.journal}</p>
          )}
          {s.aiValidation.agentResults?.length > 0 && (
            <div className="space-y-1">
              {s.aiValidation.agentResults.map((agent: any) => (
                <div key={agent.agentName} className="flex items-center gap-2 text-xs">
                  <span className="text-gray-400 w-28">{agent.agentName}</span>
                  <div className="flex-1 h-1.5 bg-dark-600 rounded-full">
                    <div className="h-full rounded-full bg-accent-blue" style={{ width: `${agent.score}%` }} />
                  </div>
                  <span className="text-gray-300 font-mono w-8 text-right">{agent.score}</span>
                </div>
              ))}
            </div>
          )}
          {s.aiValidation.risks?.length > 0 && (
            <div className="mt-2 space-y-0.5">
              {s.aiValidation.risks.slice(0, 2).map((r: string, i: number) => (
                <div key={i} className="text-xs text-accent-yellow flex items-start gap-1">
                  <AlertTriangle size={10} className="mt-0.5 flex-shrink-0" />{r}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function ReplayPanel() {
  const [config, setConfig] = useState({ pair: 'BTCUSDT', timeframe: '15m', startTime: '', endTime: '', speedMultiplier: 10 });
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<any>(null);

  const startReplay = async () => {
    if (!config.startTime || !config.endTime) return;
    setIsRunning(true); setResult(null);
    try {
      const res = await apiClient.startReplay({
        ...config,
        startTime: new Date(config.startTime).getTime(),
        endTime: new Date(config.endTime).getTime(),
      });
      setResult(res);
    } finally {
      setIsRunning(false);
    }
  };

  const stopReplay = async () => { await apiClient.stopReplay(); setIsRunning(false); };

  return (
    <div className="card space-y-4">
      <div className="flex items-center gap-2 mb-1">
        <PlayCircle size={16} className="text-accent-blue" />
        <span className="font-semibold">Replay Engine</span>
      </div>
      <div className="grid grid-cols-2 gap-3 text-xs">
        <div>
          <label className="text-gray-400 block mb-1">Pair</label>
          <select className="w-full bg-dark-600 border border-dark-500 rounded px-2 py-1.5 text-white"
            value={config.pair} onChange={(e) => setConfig((c) => ({ ...c, pair: e.target.value }))}>
            {PAIRS.map((p) => <option key={p}>{p}</option>)}
          </select>
        </div>
        <div>
          <label className="text-gray-400 block mb-1">Timeframe</label>
          <select className="w-full bg-dark-600 border border-dark-500 rounded px-2 py-1.5 text-white"
            value={config.timeframe} onChange={(e) => setConfig((c) => ({ ...c, timeframe: e.target.value }))}>
            {['5m', '15m', '30m', '1h', '4h'].map((t) => <option key={t}>{t}</option>)}
          </select>
        </div>
        <div>
          <label className="text-gray-400 block mb-1">Start Date</label>
          <input type="datetime-local" className="w-full bg-dark-600 border border-dark-500 rounded px-2 py-1.5 text-white"
            value={config.startTime} onChange={(e) => setConfig((c) => ({ ...c, startTime: e.target.value }))} />
        </div>
        <div>
          <label className="text-gray-400 block mb-1">End Date</label>
          <input type="datetime-local" className="w-full bg-dark-600 border border-dark-500 rounded px-2 py-1.5 text-white"
            value={config.endTime} onChange={(e) => setConfig((c) => ({ ...c, endTime: e.target.value }))} />
        </div>
        <div>
          <label className="text-gray-400 block mb-1">Speed: {config.speedMultiplier}x</label>
          <input type="range" min={1} max={100} className="w-full"
            value={config.speedMultiplier} onChange={(e) => setConfig((c) => ({ ...c, speedMultiplier: parseInt(e.target.value) }))} />
        </div>
      </div>
      <div className="flex gap-2">
        <button onClick={startReplay} disabled={isRunning}
          className="flex items-center gap-1 px-3 py-1.5 bg-accent-blue/20 border border-accent-blue/40 rounded text-accent-blue text-xs hover:bg-accent-blue/30 disabled:opacity-50">
          <PlayCircle size={12} /> {isRunning ? 'Running...' : 'Start Replay'}
        </button>
        {isRunning && (
          <button onClick={stopReplay} className="flex items-center gap-1 px-3 py-1.5 bg-accent-red/20 border border-accent-red/40 rounded text-accent-red text-xs hover:bg-accent-red/30">
            <StopCircle size={12} /> Stop
          </button>
        )}
      </div>
      {result?.metrics && (
        <div className="pt-3 border-t border-dark-600 grid grid-cols-2 gap-2 text-xs font-mono">
          <div><span className="text-gray-400">Trades: </span><span>{result.metrics.totalTrades}</span></div>
          <div><span className="text-gray-400">Win Rate: </span><span className={result.metrics.winRate >= 50 ? 'text-accent-green' : 'text-accent-red'}>{fmt(result.metrics.winRate)}%</span></div>
          <div><span className="text-gray-400">Total PnL: </span><span className={result.metrics.totalPnl >= 0 ? 'text-accent-green' : 'text-accent-red'}>{fmt(result.metrics.totalPnl * 100, 3)}%</span></div>
          <div><span className="text-gray-400">Profit Factor: </span><span>{fmt(result.metrics.profitFactor)}</span></div>
        </div>
      )}
    </div>
  );
}

// ---- Main Page ----
export default function Dashboard() {
  const socket = useSocket();
  const trading = useTrading(5000);
  const [tab, setTab] = useState<'overview' | 'signals' | 'positions' | 'ai' | 'analytics' | 'replay'>('overview');
  const [liveSignals, setLiveSignals] = useState<any[]>([]);

  // Merge live signals from WebSocket
  useEffect(() => {
    if (socket.lastSignal) {
      setLiveSignals((prev) => {
        const exists = prev.find((s) => s.id === socket.lastSignal.id);
        if (exists) return prev;
        return [socket.lastSignal, ...prev].slice(0, 20);
      });
    }
  }, [socket.lastSignal]);

  const allSignals = [...liveSignals, ...trading.signals].reduce((acc: any[], s) => {
    if (!acc.find((x) => x.id === s.id)) acc.push(s);
    return acc;
  }, []).slice(0, 20);

  const { wallet, positions, metrics, riskState, dailyPnl, tradeHistory, health, platformConfig } = trading;

  const tabs = [
    { id: 'overview', label: 'Overview', icon: BarChart2 },
    { id: 'signals', label: 'Signals', icon: Zap },
    { id: 'positions', label: 'Positions', icon: Layers },
    { id: 'ai', label: 'AI Reasoning', icon: Cpu },
    { id: 'analytics', label: 'Analytics', icon: Activity },
    { id: 'replay', label: 'Replay', icon: PlayCircle },
  ] as const;

  return (
    <>
      <Head>
        <title>AI Trading Platform</title>
        <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📈</text></svg>" />
      </Head>

      <div className="min-h-screen bg-dark-900 text-white">
        {/* Header */}
        <header className="border-b border-dark-600 px-6 py-3">
          <div className="flex items-center justify-between max-w-screen-2xl mx-auto">
            <div className="flex items-center gap-3">
              <div className="text-accent-green font-bold text-lg font-mono animate-glow">⚡ AI TRADING PLATFORM</div>
              <span className="badge-mode">{platformConfig?.mode?.toUpperCase() || 'DRYRUN'}</span>
            </div>
            <div className="flex items-center gap-4 text-xs">
              <div className="flex items-center gap-1.5">
                <StatusDot ok={socket.isConnected} />
                <span className="text-gray-400">{socket.isConnected ? 'Live' : 'Offline'}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <StatusDot ok={health?.db} />
                <span className="text-gray-400">DB</span>
              </div>
              <div className="flex items-center gap-1.5">
                <StatusDot ok={health?.redis} />
                <span className="text-gray-400">Redis</span>
              </div>
              <div className="flex items-center gap-1 text-gray-400 font-mono">
                {PAIRS.map((p) => <span key={p} className="px-1.5 py-0.5 bg-dark-700 rounded text-xs">{p}</span>)}
              </div>
              <button onClick={trading.refresh} className="p-1.5 hover:text-accent-blue transition-colors">
                <RefreshCw size={14} />
              </button>
            </div>
          </div>
        </header>

        {/* Tabs */}
        <nav className="border-b border-dark-600 px-6">
          <div className="flex gap-1 max-w-screen-2xl mx-auto">
            {tabs.map(({ id, label, icon: Icon }) => (
              <button key={id} onClick={() => setTab(id as typeof tab)}
                className={clx('flex items-center gap-1.5 px-4 py-3 text-sm transition-colors border-b-2',
                  tab === id ? 'text-accent-blue border-accent-blue' : 'text-gray-400 border-transparent hover:text-white')}>
                <Icon size={14} />{label}
                {id === 'signals' && allSignals.length > 0 && (
                  <span className="ml-1 text-xs bg-accent-blue/20 text-accent-blue px-1.5 rounded-full">{allSignals.length}</span>
                )}
                {id === 'positions' && positions.length > 0 && (
                  <span className="ml-1 text-xs bg-accent-green/20 text-accent-green px-1.5 rounded-full">{positions.length}</span>
                )}
              </button>
            ))}
          </div>
        </nav>

        {/* Content */}
        <main className="max-w-screen-2xl mx-auto px-6 py-6">

          {/* OVERVIEW TAB */}
          {tab === 'overview' && (
            <div className="space-y-6">
              {/* Wallet stats row */}
              <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3">
                <StatCard label="Balance" value={wallet ? `$${fmt(wallet.balance)}` : '—'} color="text-white" />
                <StatCard label="Equity" value={wallet ? `$${fmt(wallet.equity)}` : '—'} color="text-accent-blue" />
                <StatCard label="Free Margin" value={wallet ? `$${fmt(wallet.freeMargin)}` : '—'} color="text-gray-300" />
                <StatCard label="Daily PnL"
                  value={wallet ? `${wallet.dailyPnl >= 0 ? '+' : ''}$${fmt(wallet.dailyPnl)}` : '—'}
                  color={wallet?.dailyPnl >= 0 ? 'positive' : 'negative'} />
                <StatCard label="Win Rate" value={metrics ? `${fmt(metrics.winRate)}%` : '—'} color={metrics?.winRate >= 50 ? 'positive' : 'negative'} />
                <StatCard label="Profit Factor" value={metrics ? fmt(metrics.profitFactor) : '—'} color={metrics?.profitFactor >= 1 ? 'positive' : 'negative'} />
                <StatCard label="Total PnL" value={metrics ? `$${fmt(metrics.totalPnl)}` : '—'} color={metrics?.totalPnl >= 0 ? 'positive' : 'negative'} />
                <StatCard label="Open Positions" value={String(positions.length)} color="text-accent-yellow" sub={`Max: ${platformConfig?.maxPositions || 3}`} />
              </div>

              {/* PnL Chart + Risk State */}
              <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
                <div className="xl:col-span-2 card">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-sm font-semibold">Daily PnL (30 Days)</span>
                    <TrendingUp size={14} className="text-accent-green" />
                  </div>
                  <ResponsiveContainer width="100%" height={200}>
                    <BarChart data={dailyPnl} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1c2a3f" />
                      <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#8899aa' }} tickFormatter={(d) => d.slice(5)} />
                      <YAxis tick={{ fontSize: 10, fill: '#8899aa' }} />
                      <Tooltip contentStyle={{ background: '#151e2d', border: '1px solid #1c2a3f', borderRadius: 8 }}
                        labelStyle={{ color: '#8899aa' }} itemStyle={{ color: '#e8edf5' }} />
                      <ReferenceLine y={0} stroke="#1c2a3f" />
                      <Bar dataKey="pnl" radius={[3, 3, 0, 0]}>
                        {dailyPnl.map((entry, i) => (
                          <Cell key={i} fill={entry.pnl >= 0 ? '#00d4a0' : '#ff4757'} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>

                {/* Risk State */}
                <div className="card space-y-3">
                  <div className="flex items-center gap-2 mb-1">
                    <Shield size={14} className="text-accent-yellow" />
                    <span className="font-semibold text-sm">Risk Monitor</span>
                  </div>
                  {riskState ? (
                    <div className="space-y-2 text-xs font-mono">
                      <div className="flex justify-between"><span className="text-gray-400">Daily PnL</span><span className={riskState.dailyPnl >= 0 ? 'positive' : 'negative'}>${fmt(riskState.dailyPnl)}</span></div>
                      <div className="flex justify-between"><span className="text-gray-400">Open Positions</span><span>{riskState.openPositions}/{platformConfig?.maxPositions || 3}</span></div>
                      <div className="flex justify-between"><span className="text-gray-400">Daily Losses</span><span className={riskState.dailyLossCount > 2 ? 'text-accent-red' : 'text-gray-300'}>{riskState.dailyLossCount}</span></div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">Cooldown</span>
                        <span className={riskState.lastLossTime && Date.now() - riskState.lastLossTime < 30 * 60000 ? 'text-accent-yellow' : 'text-accent-green'}>
                          {riskState.lastLossTime && Date.now() - riskState.lastLossTime < 30 * 60000 ? 'ACTIVE' : 'CLEAR'}
                        </span>
                      </div>
                      <div className="pt-2 border-t border-dark-600">
                        <div className="flex justify-between mb-1"><span className="text-gray-400">Max Daily Loss</span><span>{platformConfig?.maxDailyLoss || 5}%</span></div>
                        <div className="h-2 bg-dark-600 rounded-full overflow-hidden">
                          <div className="h-full bg-accent-red rounded-full" style={{ width: `${Math.min(100, (Math.abs(Math.min(riskState.dailyPnl, 0)) / ((wallet?.balance || 10000) * 0.05)) * 100)}%` }} />
                        </div>
                      </div>
                    </div>
                  ) : <div className="text-gray-500 text-xs">Loading risk state...</div>}
                </div>
              </div>

              {/* Latest Signals Preview */}
              <div>
                <h2 className="text-sm font-semibold mb-3 flex items-center gap-2"><Zap size={14} className="text-accent-yellow" /> Latest Signals</h2>
                {allSignals.length === 0 ? (
                  <div className="card text-center text-gray-500 py-8"><Radio size={24} className="mx-auto mb-2 opacity-40" /><p>Scanning markets for signals...</p></div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                    {allSignals.slice(0, 3).map((s) => <SignalCard key={s.id} signal={s} />)}
                  </div>
                )}
              </div>

              {/* Open positions preview */}
              {positions.length > 0 && (
                <div>
                  <h2 className="text-sm font-semibold mb-3 flex items-center gap-2"><Layers size={14} className="text-accent-green" /> Open Positions</h2>
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                    {positions.map((p: any) => <PositionCard key={p.id} position={p} onClose={trading.closePosition} />)}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* SIGNALS TAB */}
          {tab === 'signals' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="font-semibold flex items-center gap-2"><Zap size={16} className="text-accent-yellow" /> Signal Monitor</h2>
                <div className="flex items-center gap-2 text-xs text-gray-400">
                  <StatusDot ok={socket.isConnected} /> Live
                </div>
              </div>
              {allSignals.length === 0 ? (
                <div className="card text-center py-16 text-gray-500">
                  <Radio size={32} className="mx-auto mb-3 opacity-30" />
                  <p>No signals generated yet. System is scanning markets...</p>
                  <p className="text-xs mt-1">Min confidence: {platformConfig?.minConfidence || 70}%</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                  {allSignals.map((s) => <SignalCard key={s.id} signal={s} />)}
                </div>
              )}
            </div>
          )}

          {/* POSITIONS TAB */}
          {tab === 'positions' && (
            <div className="space-y-4">
              <h2 className="font-semibold flex items-center gap-2"><Layers size={16} className="text-accent-green" /> Positions</h2>
              {positions.length > 0 ? (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                  {positions.map((p: any) => <PositionCard key={p.id} position={p} onClose={trading.closePosition} />)}
                </div>
              ) : (
                <div className="card text-center py-8 text-gray-500">No open positions</div>
              )}

              {/* Trade History */}
              <div>
                <h3 className="text-sm font-semibold mb-3 text-gray-300">Trade History</h3>
                <div className="card overflow-x-auto">
                  <table className="w-full text-xs font-mono">
                    <thead><tr className="text-gray-400 border-b border-dark-600">
                      {['Pair', 'Dir', 'Entry', 'Exit', 'PnL', 'ROE', 'Status', 'Date'].map((h) => (
                        <th key={h} className="text-left py-2 px-2">{h}</th>
                      ))}
                    </tr></thead>
                    <tbody>
                      {tradeHistory.slice(0, 30).map((t: any) => {
                        const pnl = parseFloat(t.realized_pnl);
                        return (
                          <tr key={t.id} className="border-b border-dark-600/50 hover:bg-dark-600/30">
                            <td className="py-2 px-2 font-bold">{t.pair}</td>
                            <td className="py-2 px-2"><span className={t.direction === 'LONG' ? 'badge-long' : 'badge-short'}>{t.direction}</span></td>
                            <td className="py-2 px-2">{fmt(parseFloat(t.entry_price), 4)}</td>
                            <td className="py-2 px-2">{t.current_price ? fmt(parseFloat(t.current_price), 4) : '—'}</td>
                            <td className={clx('py-2 px-2', pnl >= 0 ? 'positive' : 'negative')}>{pnl >= 0 ? '+' : ''}${fmt(pnl)}</td>
                            <td className={clx('py-2 px-2', parseFloat(t.roe) >= 0 ? 'positive' : 'negative')}>{fmt(parseFloat(t.roe))}%</td>
                            <td className="py-2 px-2"><span className={clx('text-xs px-1.5 py-0.5 rounded', t.status === 'CLOSED' ? 'bg-dark-600 text-gray-300' : t.status === 'LIQUIDATED' ? 'bg-accent-red/20 text-accent-red' : 'bg-accent-green/20 text-accent-green')}>{t.status}</span></td>
                            <td className="py-2 px-2 text-gray-500">{t.opened_at ? format(new Date(parseInt(t.opened_at)), 'MM/dd HH:mm') : '—'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {tradeHistory.length === 0 && <div className="text-center py-6 text-gray-500">No trade history</div>}
                </div>
              </div>
            </div>
          )}

          {/* AI REASONING TAB */}
          {tab === 'ai' && (
            <div className="space-y-4">
              <h2 className="font-semibold flex items-center gap-2"><Cpu size={16} className="text-accent-blue" /> AI Multi-Agent Reasoning</h2>
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                <AIReasoningPanel signals={allSignals} />
                <div className="card">
                  <div className="flex items-center gap-2 mb-3"><Terminal size={14} className="text-accent-purple" /><span className="font-semibold text-sm">Agent Architecture</span></div>
                  <div className="space-y-2 text-xs">
                    {['VolumeAgent', 'PatternAgent', 'IndicatorAgent', 'MEVAgent', 'RiskAgent', 'CodexCLIAgent', 'GeminiCLIAgent'].map((agent) => (
                      <div key={agent} className="flex items-center gap-3 py-2 border-b border-dark-600">
                        <div className="w-2 h-2 rounded-full bg-accent-green live-dot" />
                        <span className="font-mono text-accent-blue w-32">{agent}</span>
                        <span className="text-gray-400">Active — Analyzing {PAIRS.join(', ')}</span>
                      </div>
                    ))}
                  </div>
                  <div className="mt-4 pt-3 border-t border-dark-600 text-xs text-gray-400">
                    <p>AI Agents: <span className="text-white font-mono">Codex CLI + Gemini CLI + 5 rule-based agents</span></p>
                    <p className="mt-1">Agents run in parallel for each signal validation.</p>
                    <p className="mt-1">AI is used only for reasoning, scoring, and anomaly detection. All execution decisions are deterministic.</p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ANALYTICS TAB */}
          {tab === 'analytics' && (
            <div className="space-y-4">
              <h2 className="font-semibold flex items-center gap-2"><Activity size={16} className="text-accent-purple" /> Performance Analytics</h2>
              {metrics ? (
                <>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <StatCard label="Total Trades" value={String(metrics.totalTrades)} />
                    <StatCard label="Win Rate" value={`${fmt(metrics.winRate)}%`} color={metrics.winRate >= 50 ? 'positive' : 'negative'} />
                    <StatCard label="Profit Factor" value={fmt(metrics.profitFactor)} color={metrics.profitFactor >= 1 ? 'positive' : 'negative'} />
                    <StatCard label="Total PnL" value={`$${fmt(metrics.totalPnl)}`} color={metrics.totalPnl >= 0 ? 'positive' : 'negative'} />
                    <StatCard label="Avg RR" value={`${fmt(metrics.avgRR)}:1`} />
                    <StatCard label="Max Drawdown" value={`$${fmt(metrics.maxDrawdown)}`} color="negative" />
                    <StatCard label="Expectancy" value={`$${fmt(metrics.expectancy)}`} color={metrics.expectancy >= 0 ? 'positive' : 'negative'} />
                    <StatCard label="Sharpe Ratio" value={fmt(metrics.sharpeRatio)} color={metrics.sharpeRatio >= 1 ? 'positive' : 'negative'} />
                    <StatCard label="Avg Win" value={`$${fmt(metrics.avgWin)}`} color="positive" />
                    <StatCard label="Avg Loss" value={`$${fmt(metrics.avgLoss)}`} color="negative" />
                    <StatCard label="Max Consec. Wins" value={String(metrics.maxConsecutiveWins)} color="positive" />
                    <StatCard label="Max Consec. Losses" value={String(metrics.maxConsecutiveLosses)} color="negative" />
                  </div>
                  <div className="card">
                    <div className="text-sm font-semibold mb-3">Daily PnL History</div>
                    <ResponsiveContainer width="100%" height={250}>
                      <AreaChart data={dailyPnl} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                        <defs>
                          <linearGradient id="pnlGradient" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#00d4a0" stopOpacity={0.3} />
                            <stop offset="95%" stopColor="#00d4a0" stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="#1c2a3f" />
                        <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#8899aa' }} tickFormatter={(d) => d.slice(5)} />
                        <YAxis tick={{ fontSize: 10, fill: '#8899aa' }} />
                        <Tooltip contentStyle={{ background: '#151e2d', border: '1px solid #1c2a3f', borderRadius: 8 }} />
                        <ReferenceLine y={0} stroke="#ff4757" strokeDasharray="4 4" />
                        <Area type="monotone" dataKey="pnl" stroke="#00d4a0" fill="url(#pnlGradient)" strokeWidth={2} />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </>
              ) : <div className="card text-center py-8 text-gray-500">No analytics data yet. Complete some trades first.</div>}
            </div>
          )}

          {/* REPLAY TAB */}
          {tab === 'replay' && (
            <div className="space-y-4">
              <h2 className="font-semibold flex items-center gap-2"><PlayCircle size={16} className="text-accent-blue" /> Replay & Backtesting</h2>
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                <ReplayPanel />
                <div className="card">
                  <div className="text-sm font-semibold mb-3">How Replay Works</div>
                  <div className="space-y-2 text-xs text-gray-400">
                    <p>• Historical candles are fetched from Binance</p>
                    <p>• Candles are replayed one-by-one at the selected speed</p>
                    <p>• Signal engine evaluates confluence on each candle</p>
                    <p>• AI agents validate each generated signal</p>
                    <p>• Simulated trades track SL/TP hits</p>
                    <p>• Full metrics are generated at the end</p>
                    <p className="mt-3 text-accent-yellow">Note: Replay uses the same deterministic signal engine as live trading.</p>
                  </div>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
    </>
  );
}
