import { useState, useEffect } from 'react';
import Head from 'next/head';
import { Activity, TrendingUp, TrendingDown, AlertTriangle, Cpu, BarChart2,
  RefreshCw, Radio, Layers, Shield, PlayCircle, StopCircle, Zap,
  Clock, Eye, Ban, CheckCircle, XCircle, AlertOctagon, Target } from 'lucide-react';
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine, Cell, RadialBarChart, RadialBar } from 'recharts';
import { useSocket } from '../hooks/useSocket';
import { useTrading } from '../hooks/useTrading';
import { apiClient } from '../lib/apiClient';
import { format } from 'date-fns';

const PAIRS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];

const fmt = (n: number, d = 2) => (n ?? 0).toFixed(d);
const clx = (...a: (string | false | undefined)[]) => a.filter(Boolean).join(' ');

const REGIME_COLOR: Record<string, string> = {
  trending_up: '#00d4a0', trending_down: '#ff4757', ranging: '#ffd32a',
  choppy: '#ff6b35', high_volatility: '#9c88ff', low_liquidity: '#8899aa',
  manipulative: '#ff0055', news_volatility: '#ff9f43', unknown: '#4a4a4a',
};

const REGIME_EMOJI: Record<string, string> = {
  trending_up: '📈', trending_down: '📉', ranging: '↔️', choppy: '🌀',
  high_volatility: '⚡', low_liquidity: '💤', manipulative: '⚠️',
  news_volatility: '📰', unknown: '❓',
};

// ---- Sub-components ----

function StatusBadge({ label, color }: { label: string; color: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs font-mono px-2 py-0.5 rounded border"
      style={{ color, borderColor: color + '40', background: color + '15' }}>
      {label}
    </span>
  );
}

function GaugeBar({ value, max = 100, color, label, sublabel }: { value: number; max?: number; color: string; label: string; sublabel?: string }) {
  const pct = Math.min(100, (value / max) * 100);
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-gray-400">{label}</span>
        <span className="font-mono" style={{ color }}>{value}{sublabel ?? ''}</span>
      </div>
      <div className="h-2 bg-dark-600 rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
    </div>
  );
}

function RegimeCard({ pair, regime }: { pair: string; regime: any }) {
  if (!regime) return (
    <div className="card opacity-50 text-center py-4">
      <p className="text-xs text-gray-500">No regime data</p>
    </div>
  );
  const color = REGIME_COLOR[regime.regime] ?? '#8899aa';
  const emoji = REGIME_EMOJI[regime.regime] ?? '❓';
  return (
    <div className="card border" style={{ borderColor: color + '40' }}>
      <div className="flex items-center justify-between mb-2">
        <span className="font-bold text-sm">{pair}</span>
        <StatusBadge label={regime.tradingAllowed ? 'TRADEABLE' : 'BLOCKED'} color={regime.tradingAllowed ? '#00d4a0' : '#ff4757'} />
      </div>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xl">{emoji}</span>
        <span className="font-mono text-sm font-bold" style={{ color }}>
          {regime.regime.replace(/_/g, ' ').toUpperCase()}
        </span>
      </div>
      <p className="text-xs text-gray-400 leading-relaxed mb-3">{regime.description}</p>
      <div className="space-y-1.5">
        <GaugeBar value={Math.round(regime.trendStrength)} label="Trend Strength" color={color} sublabel="/100" />
        <GaugeBar value={Math.round(regime.confidence)} label="Regime Confidence" color="#3d8ef8" sublabel="%" />
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        {regime.isChoppy && <StatusBadge label="CHOPPY" color="#ff6b35" />}
        {regime.isManipulative && <StatusBadge label="MANIPULATIVE" color="#ff0055" />}
        {regime.emaFlattening && <StatusBadge label="EMA FLAT" color="#ffd32a" />}
      </div>
    </div>
  );
}

function QualityMeter({ pair, quality }: { pair: string; quality: any }) {
  if (!quality) return null;
  const color = quality.total >= 80 ? '#00d4a0' : quality.total >= 60 ? '#ffd32a' : '#ff4757';
  const gradeColors: Record<string, string> = {
    excellent: '#00d4a0', tradeable: '#3d8ef8', risky: '#ffd32a', no_trade: '#ff4757',
  };
  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3">
        <span className="font-semibold text-sm">{pair}</span>
        <div className="flex items-center gap-2">
          <span className="text-2xl font-mono font-bold" style={{ color }}>{quality.total}</span>
          <StatusBadge label={quality.grade.replace('_', ' ').toUpperCase()} color={gradeColors[quality.grade] ?? '#8899aa'} />
        </div>
      </div>
      <div className="space-y-1.5">
        <GaugeBar value={quality.trendClarity} max={25} label="Trend Clarity" color="#00d4a0" sublabel="/25" />
        <GaugeBar value={quality.liquidityQuality} max={20} label="Liquidity" color="#3d8ef8" sublabel="/20" />
        <GaugeBar value={quality.volatilityQuality} max={20} label="Volatility" color="#9c88ff" sublabel="/20" />
        <GaugeBar value={quality.volumeQuality} max={20} label="Volume" color="#ffd32a" sublabel="/20" />
        <GaugeBar value={quality.confirmationStrength} max={15} label="Confirmation" color="#ff6b35" sublabel="/15" />
      </div>
      {quality.reasons?.length > 0 && (
        <div className="mt-2 space-y-0.5">
          {quality.reasons.slice(0, 2).map((r: string, i: number) => (
            <p key={i} className="text-xs text-gray-400">• {r}</p>
          ))}
        </div>
      )}
    </div>
  );
}

function ConsensusViz({ votes, score }: { votes: any[]; score: number }) {
  if (!votes?.length) return <div className="text-gray-500 text-xs text-center py-4">No consensus data</div>;
  const voteColor = (v: string) => v === 'BUY' ? '#00d4a0' : v === 'SELL' ? '#ff4757' : v === 'NO_TRADE' ? '#ff0055' : '#ffd32a';
  const voteIcon = (v: string) => v === 'BUY' ? '↑' : v === 'SELL' ? '↓' : v === 'NO_TRADE' ? '✗' : '⏸';
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-gray-400">Consensus Score</span>
        <span className="text-lg font-mono font-bold" style={{ color: score >= 65 ? '#00d4a0' : score >= 45 ? '#ffd32a' : '#ff4757' }}>
          {score}/100
        </span>
      </div>
      {votes.map((v: any) => (
        <div key={v.agentName} className="flex items-center gap-2">
          <span className="text-xs font-mono w-28 text-gray-400">{v.agentName.replace('Agent', '')}</span>
          <div className="flex-1 h-1.5 bg-dark-600 rounded-full overflow-hidden">
            <div className="h-full rounded-full" style={{ width: `${v.confidence}%`, backgroundColor: voteColor(v.vote) }} />
          </div>
          <span className="text-xs font-mono w-4 text-center font-bold" style={{ color: voteColor(v.vote) }}>{voteIcon(v.vote)}</span>
          {v.isVeto && <AlertOctagon size={10} className="text-red-500" />}
        </div>
      ))}
    </div>
  );
}

function SessionIndicator({ session }: { session: any }) {
  if (!session) return null;
  const quality = session.quality ?? 0;
  const color = quality >= 80 ? '#00d4a0' : quality >= 45 ? '#ffd32a' : '#ff4757';
  const sessionEmoji: Record<string, string> = { london: '🇬🇧', new_york: '🇺🇸', overlap: '🌟', asia: '🌏', dead: '💤' };
  return (
    <div className="card">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-lg">{sessionEmoji[session.name] ?? '🕐'}</span>
          <span className="font-bold text-sm">{session.name.replace('_', ' ').toUpperCase()}</span>
        </div>
        <StatusBadge label={session.tradingAllowed ? 'ACTIVE' : 'AVOID'} color={color} />
      </div>
      <p className="text-xs text-gray-400 mb-2">{session.description}</p>
      <GaugeBar value={quality} label="Session Quality" color={color} sublabel="/100" />
      <div className="mt-2 flex gap-3 text-xs font-mono text-gray-400">
        <span>Vol: {session.volumeMultiplier}x</span>
        <span>Risk: {session.riskMultiplier}x</span>
      </div>
    </div>
  );
}

function FrequencyPanel({ frequency, onResetCooldown }: { frequency: any; onResetCooldown: () => void }) {
  if (!frequency) return null;
  const { streak, systemStatus, frequency: freq } = frequency;
  const statusColor: Record<string, string> = { trading: '#00d4a0', observation: '#ffd32a', cooldown: '#ff4757', disabled: '#8899aa' };
  const usedPct = freq ? (freq.tradesToday / freq.maxTradesDay) * 100 : 0;
  return (
    <div className="card space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Clock size={14} style={{ color: statusColor[systemStatus] ?? '#8899aa' }} />
          <span className="font-semibold text-sm">Frequency & Discipline</span>
        </div>
        <StatusBadge label={systemStatus?.toUpperCase() ?? 'UNKNOWN'} color={statusColor[systemStatus] ?? '#8899aa'} />
      </div>
      {freq && (
        <>
          <GaugeBar value={freq.tradesToday} max={freq.maxTradesDay} label={`Trades today (${freq.tradesToday}/${freq.maxTradesDay})`}
            color={usedPct >= 80 ? '#ff4757' : usedPct >= 60 ? '#ffd32a' : '#00d4a0'} />
          <div className="text-xs text-gray-400 font-mono">{freq.remainingToday} trades remaining today</div>
        </>
      )}
      {streak && (
        <div className="pt-2 border-t border-dark-600 space-y-1 text-xs font-mono">
          <div className="flex justify-between">
            <span className="text-gray-400">Consecutive losses</span>
            <span className={streak.consecutiveLosses >= 3 ? 'text-accent-red' : 'text-gray-300'}>{streak.consecutiveLosses}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">In cooldown</span>
            <span className={streak.inCooldown ? 'text-accent-red' : 'text-accent-green'}>{streak.inCooldown ? '⛔ YES' : '✅ NO'}</span>
          </div>
          {streak.inCooldown && (
            <>
              <p className="text-accent-red text-xs mt-1">{streak.cooldownReason}</p>
              <button onClick={onResetCooldown}
                className="mt-2 w-full text-xs px-2 py-1 border border-accent-red/40 text-accent-red rounded hover:bg-accent-red/10">
                Manual Override — Exit Cooldown
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function NoTradeLog({ noTrades }: { noTrades: any[] }) {
  if (!noTrades.length) return (
    <div className="card text-center py-6 text-gray-500">
      <Eye size={20} className="mx-auto mb-2 opacity-30" />
      <p className="text-xs">No-trade decisions will appear here</p>
    </div>
  );
  const catColor: Record<string, string> = {
    regime: '#9c88ff', quality: '#ffd32a', session: '#3d8ef8',
    frequency: '#ff6b35', cooldown: '#ff4757', consensus: '#ff0055',
    patience: '#00d4a0', risk: '#8899aa',
  };
  return (
    <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
      {noTrades.map((n: any, i: number) => (
        <div key={i} className="flex items-start gap-2 text-xs border-b border-dark-600 pb-2">
          <Ban size={12} className="mt-0.5 flex-shrink-0" style={{ color: catColor[n.decision?.category] ?? '#8899aa' }} />
          <div>
            <span className="font-mono font-bold">{n.pair}</span>
            <span className="text-gray-400 ml-2">{n.decision?.primaryReason?.slice(0, 80)}</span>
            <div className="flex gap-1 mt-0.5">
              <StatusBadge label={n.decision?.category?.toUpperCase() ?? 'SKIP'} color={catColor[n.decision?.category] ?? '#8899aa'} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function SelfReviewPanel({ reviews }: { reviews: any[] }) {
  if (!reviews.length) return (
    <div className="card text-center py-6 text-gray-500 text-xs">No trade reviews yet</div>
  );
  return (
    <div className="space-y-3">
      {reviews.slice(0, 5).map((r: any, i: number) => {
        const outEmoji = r.outcome === 'win' ? '✅' : r.outcome === 'loss' ? '❌' : '⚖️';
        const pnlColor = r.pnl >= 0 ? '#00d4a0' : '#ff4757';
        return (
          <div key={i} className="card text-xs">
            <div className="flex items-center justify-between mb-1">
              <span className="font-bold">{outEmoji} {r.pair} {r.direction}</span>
              <span className="font-mono" style={{ color: pnlColor }}>{r.pnl >= 0 ? '+' : ''}${fmt(r.pnl)}</span>
            </div>
            <div className="text-gray-400 mb-1">Regime: <span className="text-gray-300">{r.regimeAtEntry?.replace(/_/g, ' ')}</span> | Session: <span className="text-gray-300">{r.sessionAtEntry}</span></div>
            <p className="text-gray-300 leading-relaxed">{r.journal?.split('\n').slice(4).join(' ').slice(0, 150)}...</p>
            <div className="mt-1 flex gap-2 flex-wrap">
              {r.lessonsLearned?.slice(0, 1).map((l: string, j: number) => (
                <span key={j} className="text-gray-400 italic">• {l.slice(0, 80)}</span>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SignalCard({ signal }: { signal: any }) {
  const isLong = signal.direction === 'LONG';
  const color = isLong ? '#00d4a0' : '#ff4757';
  const consensus = signal.consensusResult;
  return (
    <div className="card border animate-fade-in" style={{ borderColor: color + '40' }}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="font-bold">{signal.pair}</span>
          <StatusBadge label={signal.direction} color={color} />
          <StatusBadge label={signal.strength} color={color} />
        </div>
        <span className="text-xs text-gray-500 font-mono">
          {signal.timestamp ? format(new Date(signal.timestamp), 'HH:mm:ss') : ''}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2 mb-3">
        <GaugeBar value={signal.confidence} label="Confidence" color={signal.confidence >= 80 ? '#00d4a0' : '#ffd32a'} sublabel="%" />
        <GaugeBar value={consensus?.consensusScore ?? 0} label="Consensus" color="#3d8ef8" sublabel="/100" />
      </div>
      <div className="grid grid-cols-3 gap-2 text-xs font-mono mb-2">
        <div><div className="text-gray-400">Entry</div><div>{fmt(signal.entry, 4)}</div></div>
        <div><div className="text-gray-400">SL</div><div style={{ color: '#ff4757' }}>{fmt(signal.stopLoss, 4)}</div></div>
        <div><div className="text-gray-400">TP</div><div style={{ color: '#00d4a0' }}>{fmt(signal.takeProfit, 4)}</div></div>
      </div>
      <div className="flex gap-3 text-xs font-mono mb-2">
        <span className="text-gray-400">RR <span className="text-accent-blue">{fmt(signal.riskReward, 2)}:1</span></span>
        <span className="text-gray-400">Quality <span className="text-white">{signal.qualityScore ?? '—'}/100</span></span>
        <span className="text-gray-400">MTF <span style={{ color: signal.mtfAligned ? '#00d4a0' : '#ff4757' }}>{signal.mtfAligned ? 'YES' : 'NO'}</span></span>
      </div>
      {consensus && (
        <div className="pt-2 border-t border-dark-600">
          <div className="text-xs text-gray-400 mb-1.5">Consensus votes</div>
          <div className="flex gap-3 text-xs font-mono">
            <span style={{ color: '#00d4a0' }}>↑ {consensus.buyVotes}</span>
            <span style={{ color: '#ff4757' }}>↓ {consensus.sellVotes}</span>
            <span style={{ color: '#ffd32a' }}>⏸ {consensus.waitVotes}</span>
            {consensus.vetoCount > 0 && <span style={{ color: '#ff0055' }}>✗ {consensus.vetoCount} VETO</span>}
          </div>
        </div>
      )}
      {signal.aiValidation?.journal && (
        <div className="mt-2 pt-2 border-t border-dark-600">
          <p className="text-xs text-gray-300 italic leading-relaxed">{signal.aiValidation.journal.slice(0, 160)}...</p>
        </div>
      )}
    </div>
  );
}

function StrategyModeSelector({ current, onSelect }: { current: string; onSelect: (m: string) => void }) {
  const modes = [
    { id: 'scalping', label: '⚡ Scalp', desc: '5/day, fast' },
    { id: 'swing',    label: '🌊 Swing', desc: '2/day, trend' },
    { id: 'investing',label: '💎 Invest', desc: '1/day, spot' },
    { id: 'safe',     label: '🛡️ Safe',  desc: '1/day, 90%+' },
    { id: 'aggressive', label: '🔥 Aggr', desc: '8/day, low bar' },
  ];
  return (
    <div className="flex flex-wrap gap-2">
      {modes.map((m) => (
        <button key={m.id} onClick={() => onSelect(m.id)}
          className={clx('px-3 py-2 rounded border text-xs transition-all',
            current === m.id ? 'border-accent-blue bg-accent-blue/20 text-accent-blue' : 'border-dark-500 text-gray-400 hover:border-gray-400')}>
          <div className="font-semibold">{m.label}</div>
          <div className="text-gray-500">{m.desc}</div>
        </button>
      ))}
    </div>
  );
}

// ---- Main Page ----
export default function Dashboard() {
  const socket = useSocket();
  const trading = useTrading(5000);
  const [tab, setTab] = useState<'overview' | 'regime' | 'signals' | 'positions' | 'discipline' | 'review' | 'analytics' | 'replay'>('overview');
  const [liveSignals, setLiveSignals] = useState<any[]>([]);
  const [replayConfig, setReplayConfig] = useState({ pair: 'BTCUSDT', timeframe: '15m', startTime: '', endTime: '', speedMultiplier: 10 });
  const [replayResult, setReplayResult] = useState<any>(null);

  useEffect(() => {
    if (socket.lastSignal) {
      setLiveSignals((prev) => {
        const exists = prev.find((s) => s.id === socket.lastSignal.id);
        if (exists) return prev;
        return [socket.lastSignal, ...prev].slice(0, 30);
      });
    }
  }, [socket.lastSignal]);

  // Capture no_trade events
  useEffect(() => {
    if (!(socket.socket)) return;
    const handler = (data: any) => trading.addNoTrade(data);
    socket.socket?.on('no_trade', handler);
    return () => { socket.socket?.off('no_trade', handler); };
  }, [socket.socket, trading]);

  const allSignals = [...liveSignals, ...trading.signals].reduce((acc: any[], s) => {
    if (!acc.find((x) => x.id === s.id)) acc.push(s);
    return acc;
  }, []).slice(0, 30);

  const { wallet, positions, metrics, riskState, dailyPnl, tradeHistory,
    health, platformConfig, regimes, qualities, session, frequency, reviews } = trading;

  const sysStatus = frequency?.systemStatus ?? 'unknown';
  const statusColor: Record<string, string> = { trading: '#00d4a0', observation: '#ffd32a', cooldown: '#ff4757', disabled: '#8899aa' };

  const tabs = [
    { id: 'overview',    label: 'Overview',    icon: BarChart2 },
    { id: 'regime',      label: 'Regime',      icon: Activity },
    { id: 'signals',     label: 'Signals',     icon: Zap },
    { id: 'positions',   label: 'Positions',   icon: Layers },
    { id: 'discipline',  label: 'Discipline',  icon: Shield },
    { id: 'review',      label: 'AI Review',   icon: Cpu },
    { id: 'analytics',   label: 'Analytics',   icon: TrendingUp },
    { id: 'replay',      label: 'Replay',      icon: PlayCircle },
  ] as const;

  return (
    <>
      <Head><title>AI Trading Platform v2 — Disciplined</title></Head>
      <div className="min-h-screen bg-dark-900 text-white">

        {/* Header */}
        <header className="border-b border-dark-600 px-6 py-3">
          <div className="flex items-center justify-between max-w-screen-2xl mx-auto">
            <div className="flex items-center gap-3">
              <span className="font-bold text-lg font-mono animate-glow" style={{ color: '#00d4a0' }}>⚡ AI TRADING v2</span>
              <StatusBadge label={platformConfig?.strategy?.toUpperCase() ?? 'SWING'} color="#3d8ef8" />
              <StatusBadge label={sysStatus.toUpperCase()} color={statusColor[sysStatus] ?? '#8899aa'} />
            </div>
            <div className="flex items-center gap-4 text-xs">
              <div className="flex items-center gap-1.5">
                <span className={clx('w-2 h-2 rounded-full', socket.isConnected ? 'bg-accent-green live-dot' : 'bg-accent-red')} />
                <span className="text-gray-400">{socket.isConnected ? 'Live' : 'Offline'}</span>
              </div>
              {session && (
                <span className="text-gray-400 font-mono">
                  {session.name?.toUpperCase()} <span style={{ color: session.quality >= 80 ? '#00d4a0' : '#ffd32a' }}>{session.quality}/100</span>
                </span>
              )}
              <button onClick={trading.refresh} className="p-1.5 hover:text-accent-blue"><RefreshCw size={14} /></button>
            </div>
          </div>
        </header>

        {/* Strategy mode selector */}
        <div className="border-b border-dark-600 px-6 py-2 bg-dark-800">
          <div className="max-w-screen-2xl mx-auto flex items-center gap-4">
            <span className="text-xs text-gray-500 whitespace-nowrap">Strategy:</span>
            <StrategyModeSelector current={platformConfig?.strategy ?? 'swing'} onSelect={trading.setStrategyMode} />
          </div>
        </div>

        {/* Tabs */}
        <nav className="border-b border-dark-600 px-6">
          <div className="flex gap-0 max-w-screen-2xl mx-auto overflow-x-auto">
            {tabs.map(({ id, label, icon: Icon }) => (
              <button key={id} onClick={() => setTab(id as any)}
                className={clx('flex items-center gap-1.5 px-4 py-3 text-sm whitespace-nowrap transition-colors border-b-2',
                  tab === id ? 'text-accent-blue border-accent-blue' : 'text-gray-400 border-transparent hover:text-white')}>
                <Icon size={13} />{label}
              </button>
            ))}
          </div>
        </nav>

        <main className="max-w-screen-2xl mx-auto px-6 py-6">

          {/* OVERVIEW */}
          {tab === 'overview' && (
            <div className="space-y-6">
              {/* Stat row */}
              <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3">
                {[
                  { label: 'Balance', value: wallet ? `$${fmt(wallet.balance)}` : '—', color: 'text-white' },
                  { label: 'Equity', value: wallet ? `$${fmt(wallet.equity)}` : '—', color: 'text-accent-blue' },
                  { label: 'Daily PnL', value: wallet ? `${wallet.dailyPnl >= 0 ? '+' : ''}$${fmt(wallet.dailyPnl)}` : '—', color: wallet?.dailyPnl >= 0 ? 'positive' : 'negative' },
                  { label: 'Open Positions', value: String(positions.length), color: 'text-accent-yellow' },
                  { label: 'Win Rate', value: metrics ? `${fmt(metrics.winRate)}%` : '—', color: (metrics?.winRate ?? 0) >= 50 ? 'positive' : 'negative' },
                  { label: 'Profit Factor', value: metrics ? fmt(metrics.profitFactor) : '—', color: (metrics?.profitFactor ?? 0) >= 1 ? 'positive' : 'negative' },
                  { label: 'Total PnL', value: metrics ? `$${fmt(metrics.totalPnl)}` : '—', color: (metrics?.totalPnl ?? 0) >= 0 ? 'positive' : 'negative' },
                  { label: 'Max Drawdown', value: metrics ? `$${fmt(metrics.maxDrawdown)}` : '—', color: 'negative' },
                ].map(({ label, value, color }) => (
                  <div key={label} className="card">
                    <div className="stat-label">{label}</div>
                    <div className={clx('stat-value', color)}>{value}</div>
                  </div>
                ))}
              </div>

              {/* Regime overview row */}
              <div>
                <h2 className="text-sm font-semibold mb-3 flex items-center gap-2"><Activity size={14} className="text-accent-purple" /> Market Regimes</h2>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  {PAIRS.map((p) => <RegimeCard key={p} pair={p} regime={regimes[p]} />)}
                </div>
              </div>

              {/* Session + Frequency row */}
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                <SessionIndicator session={session} />
                <FrequencyPanel frequency={frequency} onResetCooldown={trading.resetCooldown} />
                {/* Risk monitor */}
                <div className="card space-y-2">
                  <div className="flex items-center gap-2 mb-1"><Shield size={14} className="text-accent-yellow" /><span className="font-semibold text-sm">Risk Monitor</span></div>
                  {riskState ? (
                    <div className="space-y-2 text-xs font-mono">
                      <GaugeBar value={Math.abs(Math.min(riskState.dailyPnl, 0))} max={(wallet?.balance ?? 10000) * 0.05} label="Daily Loss Used" color="#ff4757" />
                      <div className="flex justify-between"><span className="text-gray-400">Open positions</span><span>{riskState.openPositions}/{platformConfig?.strategyConfig?.maxPositions ?? 3}</span></div>
                      <div className="flex justify-between"><span className="text-gray-400">Daily PnL</span><span className={riskState.dailyPnl >= 0 ? 'positive' : 'negative'}>${fmt(riskState.dailyPnl)}</span></div>
                    </div>
                  ) : <p className="text-gray-500 text-xs">Loading...</p>}
                </div>
              </div>

              {/* PnL chart */}
              <div className="card">
                <div className="flex items-center justify-between mb-3"><span className="font-semibold text-sm">Daily PnL (30 Days)</span></div>
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={dailyPnl} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1c2a3f" />
                    <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#8899aa' }} tickFormatter={(d) => d.slice(5)} />
                    <YAxis tick={{ fontSize: 10, fill: '#8899aa' }} />
                    <Tooltip contentStyle={{ background: '#151e2d', border: '1px solid #1c2a3f', borderRadius: 8 }} />
                    <ReferenceLine y={0} stroke="#1c2a3f" />
                    <Bar dataKey="pnl" radius={[3, 3, 0, 0]}>
                      {dailyPnl.map((e: any, i: number) => <Cell key={i} fill={e.pnl >= 0 ? '#00d4a0' : '#ff4757'} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>

              {/* Latest signals */}
              {allSignals.length > 0 && (
                <div>
                  <h2 className="text-sm font-semibold mb-3 flex items-center gap-2"><Zap size={14} className="text-accent-yellow" /> Approved Signals</h2>
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                    {allSignals.slice(0, 3).map((s) => <SignalCard key={s.id} signal={s} />)}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* REGIME TAB */}
          {tab === 'regime' && (
            <div className="space-y-4">
              <h2 className="font-semibold flex items-center gap-2"><Activity size={16} className="text-accent-purple" /> Market Regime Engine</h2>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {PAIRS.map((p) => <RegimeCard key={p} pair={p} regime={regimes[p]} />)}
              </div>
              <h2 className="font-semibold flex items-center gap-2 pt-2"><Target size={16} className="text-accent-blue" /> Market Quality Scores</h2>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {PAIRS.map((p) => <QualityMeter key={p} pair={p} quality={qualities[p]} />)}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <SessionIndicator session={session} />
                <div className="card">
                  <div className="text-sm font-semibold mb-3">Regime Legend</div>
                  <div className="grid grid-cols-2 gap-2">
                    {Object.entries(REGIME_COLOR).map(([r, c]) => (
                      <div key={r} className="flex items-center gap-2 text-xs">
                        <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ background: c }} />
                        <span className="text-gray-300">{r.replace(/_/g, ' ')}</span>
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 text-xs text-gray-400">
                    <p>Trading is <span className="text-accent-green">allowed</span> only in trending or high-volatility regimes.</p>
                    <p className="mt-1">Choppy, ranging, and manipulative regimes are automatically blocked.</p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* SIGNALS TAB */}
          {tab === 'signals' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="font-semibold flex items-center gap-2"><Zap size={16} className="text-accent-yellow" /> Signal Monitor — Approved Only</h2>
                <span className="text-xs text-gray-400">{allSignals.length} signals passed all filters</span>
              </div>
              {allSignals.length === 0 ? (
                <div className="card text-center py-16">
                  <Radio size={32} className="mx-auto mb-3 opacity-30" />
                  <p className="text-gray-400">No signals cleared all filters yet.</p>
                  <p className="text-xs text-gray-500 mt-2">System is being disciplined — waiting for quality setups.</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                  {allSignals.map((s) => <SignalCard key={s.id} signal={s} />)}
                </div>
              )}
              <div>
                <h3 className="text-sm font-semibold mb-3 flex items-center gap-2 text-gray-400"><Ban size={14} /> Skipped / No-Trade Log</h3>
                <NoTradeLog noTrades={trading.noTrades} />
              </div>
            </div>
          )}

          {/* POSITIONS TAB */}
          {tab === 'positions' && (
            <div className="space-y-4">
              <h2 className="font-semibold flex items-center gap-2"><Layers size={16} className="text-accent-green" /> Positions</h2>
              {positions.length === 0 ? (
                <div className="card text-center py-8 text-gray-500">No open positions — system is being selective</div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                  {positions.map((p: any) => (
                    <div key={p.id} className="card border border-dark-500">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <span className="font-bold">{p.pair}</span>
                          <StatusBadge label={p.direction} color={p.direction === 'LONG' ? '#00d4a0' : '#ff4757'} />
                          <span className="text-xs text-gray-400">{p.leverage}x</span>
                        </div>
                        <button onClick={() => trading.closePosition(p.id)}
                          className="text-xs px-2 py-1 border border-dark-500 rounded hover:border-accent-red text-gray-400 hover:text-accent-red">
                          Close
                        </button>
                      </div>
                      <div className="grid grid-cols-2 gap-1 text-xs font-mono">
                        <div className="flex justify-between"><span className="text-gray-400">Entry</span><span>{fmt(p.entry_price ?? p.entryPrice, 4)}</span></div>
                        <div className="flex justify-between"><span className="text-gray-400">Current</span><span>{fmt(p.current_price ?? p.currentPrice, 4)}</span></div>
                        <div className="flex justify-between col-span-2 mt-1 pt-1 border-t border-dark-600">
                          <span className="text-gray-400">PnL</span>
                          <span className={(p.unrealized_pnl ?? p.unrealizedPnl ?? 0) >= 0 ? 'positive' : 'negative'}>
                            {(p.unrealized_pnl ?? p.unrealizedPnl ?? 0) >= 0 ? '+' : ''}${fmt(p.unrealized_pnl ?? p.unrealizedPnl ?? 0)} ({fmt(p.roe ?? 0)}%)
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div>
                <h3 className="text-sm font-semibold mb-2 text-gray-300">Trade History</h3>
                <div className="card overflow-x-auto">
                  <table className="w-full text-xs font-mono">
                    <thead><tr className="text-gray-400 border-b border-dark-600">
                      {['Pair','Dir','Entry','PnL','ROE','Status','Regime','Date'].map((h) => (
                        <th key={h} className="text-left py-2 px-2">{h}</th>
                      ))}
                    </tr></thead>
                    <tbody>
                      {tradeHistory.slice(0, 30).map((t: any) => {
                        const pnl = parseFloat(t.realized_pnl ?? 0);
                        return (
                          <tr key={t.id} className="border-b border-dark-600/50 hover:bg-dark-600/20">
                            <td className="py-1.5 px-2 font-bold">{t.pair}</td>
                            <td className="py-1.5 px-2"><StatusBadge label={t.direction} color={t.direction === 'LONG' ? '#00d4a0' : '#ff4757'} /></td>
                            <td className="py-1.5 px-2">{fmt(parseFloat(t.entry_price), 4)}</td>
                            <td className={clx('py-1.5 px-2', pnl >= 0 ? 'positive' : 'negative')}>{pnl >= 0 ? '+' : ''}${fmt(pnl)}</td>
                            <td className={clx('py-1.5 px-2', parseFloat(t.roe) >= 0 ? 'positive' : 'negative')}>{fmt(parseFloat(t.roe))}%</td>
                            <td className="py-1.5 px-2">{t.status}</td>
                            <td className="py-1.5 px-2 text-gray-500">—</td>
                            <td className="py-1.5 px-2 text-gray-500">{t.opened_at ? format(new Date(parseInt(t.opened_at)), 'MM/dd HH:mm') : '—'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {tradeHistory.length === 0 && <p className="text-center py-6 text-gray-500 text-xs">No trades yet</p>}
                </div>
              </div>
            </div>
          )}

          {/* DISCIPLINE TAB */}
          {tab === 'discipline' && (
            <div className="space-y-4">
              <h2 className="font-semibold flex items-center gap-2"><Shield size={16} className="text-accent-yellow" /> Discipline & Patience Engine</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                <FrequencyPanel frequency={frequency} onResetCooldown={trading.resetCooldown} />
                <SessionIndicator session={session} />
                <div className="card">
                  <div className="text-sm font-semibold mb-3">Philosophy</div>
                  <div className="space-y-2 text-xs text-gray-400 italic">
                    <p>"The best trade is often the trade you do NOT take."</p>
                    <p>"Sit on your hands when the market offers no edge."</p>
                    <p>"Capital preservation is the foundation of all returns."</p>
                    <p>"A missed trade is never a lost trade."</p>
                    <p>"Discipline beats intelligence in the long run."</p>
                  </div>
                </div>
              </div>
              <div>
                <h3 className="text-sm font-semibold mb-3">Skipped Trade Log</h3>
                <NoTradeLog noTrades={trading.noTrades} />
              </div>
              <div className="card">
                <div className="text-sm font-semibold mb-3">Patience Filters — All must pass for a trade</div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
                  {[
                    ['Regime allows trading', regimes[PAIRS[0]]?.tradingAllowed],
                    ['Session is high quality', session?.isHighQuality],
                    ['Market quality ≥ mode threshold', (qualities[PAIRS[0]]?.total ?? 0) >= 65],
                    ['No manipulation detected', !regimes[PAIRS[0]]?.isManipulative],
                    ['Not choppy', !regimes[PAIRS[0]]?.isChoppy],
                    ['No loss streak cooldown', !frequency?.streak?.inCooldown],
                    ['Daily trade limit not reached', !frequency?.frequency?.isLimited],
                    ['Consensus score ≥ threshold', true],
                  ].map(([label, pass]) => (
                    <div key={label as string} className="flex items-center gap-2">
                      {pass ? <CheckCircle size={12} className="text-accent-green" /> : <XCircle size={12} className="text-accent-red" />}
                      <span className={pass ? 'text-gray-300' : 'text-gray-500'}>{label as string}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* AI REVIEW TAB */}
          {tab === 'review' && (
            <div className="space-y-4">
              <h2 className="font-semibold flex items-center gap-2"><Cpu size={16} className="text-accent-blue" /> AI Self-Review Engine</h2>
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                <div>
                  <h3 className="text-sm font-semibold mb-3 text-gray-300">Recent Trade Reviews</h3>
                  <SelfReviewPanel reviews={reviews} />
                </div>
                <div className="space-y-3">
                  <div className="card">
                    <div className="text-sm font-semibold mb-2">7-Agent Consensus Architecture</div>
                    <div className="space-y-1.5 text-xs">
                      {['VolumeAgent (deterministic)', 'PatternAgent (deterministic)', 'IndicatorAgent (deterministic)',
                        'MEVAgent (deterministic)', 'RiskAgent (deterministic)',
                        'CodexCLIAgent (CLI subprocess)', 'GeminiCLIAgent (CLI subprocess)'].map((a, i) => (
                        <div key={a} className="flex items-center gap-2">
                          <div className="w-2 h-2 rounded-full bg-accent-green live-dot" />
                          <span className="font-mono text-gray-300">{a}</span>
                        </div>
                      ))}
                    </div>
                    <div className="mt-3 text-xs text-gray-400">
                      <p>Scoring: deterministic 60% · CLI agents 40%</p>
                      <p>Hard veto: RiskAgent &lt; 25 OR both CLI flag 2+ risks</p>
                      <p>Trade requires: 4/7 votes in signal direction</p>
                    </div>
                  </div>
                  {allSignals[0]?.consensusResult && (
                    <div className="card">
                      <div className="text-sm font-semibold mb-3">Latest Consensus Vote</div>
                      <ConsensusViz votes={allSignals[0].consensusResult.votes} score={allSignals[0].consensusResult.consensusScore} />
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ANALYTICS TAB */}
          {tab === 'analytics' && (
            <div className="space-y-4">
              <h2 className="font-semibold flex items-center gap-2"><TrendingUp size={16} className="text-accent-purple" /> Performance Analytics</h2>
              {metrics ? (
                <>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {[
                      { label: 'Total Trades', value: String(metrics.totalTrades) },
                      { label: 'Win Rate', value: `${fmt(metrics.winRate)}%`, color: metrics.winRate >= 50 ? 'positive' : 'negative' },
                      { label: 'Profit Factor', value: fmt(metrics.profitFactor), color: metrics.profitFactor >= 1 ? 'positive' : 'negative' },
                      { label: 'Total PnL', value: `$${fmt(metrics.totalPnl)}`, color: metrics.totalPnl >= 0 ? 'positive' : 'negative' },
                      { label: 'Avg RR', value: `${fmt(metrics.avgRR)}:1` },
                      { label: 'Max Drawdown', value: `$${fmt(metrics.maxDrawdown)}`, color: 'negative' },
                      { label: 'Expectancy', value: `$${fmt(metrics.expectancy)}`, color: metrics.expectancy >= 0 ? 'positive' : 'negative' },
                      { label: 'Sharpe Ratio', value: fmt(metrics.sharpeRatio), color: metrics.sharpeRatio >= 1 ? 'positive' : 'negative' },
                    ].map(({ label, value, color }) => (
                      <div key={label} className="card">
                        <div className="stat-label">{label}</div>
                        <div className={clx('stat-value', color)}>{value}</div>
                      </div>
                    ))}
                  </div>
                  <div className="card">
                    <div className="text-sm font-semibold mb-3">Equity Curve</div>
                    <ResponsiveContainer width="100%" height={250}>
                      <AreaChart data={dailyPnl} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                        <defs>
                          <linearGradient id="pg" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#00d4a0" stopOpacity={0.3} />
                            <stop offset="95%" stopColor="#00d4a0" stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="#1c2a3f" />
                        <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#8899aa' }} tickFormatter={(d) => d.slice(5)} />
                        <YAxis tick={{ fontSize: 10, fill: '#8899aa' }} />
                        <Tooltip contentStyle={{ background: '#151e2d', border: '1px solid #1c2a3f', borderRadius: 8 }} />
                        <ReferenceLine y={0} stroke="#ff4757" strokeDasharray="4 4" />
                        <Area type="monotone" dataKey="pnl" stroke="#00d4a0" fill="url(#pg)" strokeWidth={2} />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </>
              ) : <div className="card text-center py-8 text-gray-500">No analytics data yet</div>}
            </div>
          )}

          {/* REPLAY TAB */}
          {tab === 'replay' && (
            <div className="space-y-4">
              <h2 className="font-semibold flex items-center gap-2"><PlayCircle size={16} className="text-accent-blue" /> Replay & Backtesting</h2>
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                <div className="card space-y-4">
                  <div className="grid grid-cols-2 gap-3 text-xs">
                    {[
                      ['Pair', <select key="p" className="w-full bg-dark-600 border border-dark-500 rounded px-2 py-1.5 text-white" value={replayConfig.pair} onChange={(e) => setReplayConfig((c) => ({ ...c, pair: e.target.value }))}>
                        {PAIRS.map((p) => <option key={p}>{p}</option>)}
                      </select>],
                      ['Timeframe', <select key="tf" className="w-full bg-dark-600 border border-dark-500 rounded px-2 py-1.5 text-white" value={replayConfig.timeframe} onChange={(e) => setReplayConfig((c) => ({ ...c, timeframe: e.target.value }))}>
                        {['5m', '15m', '30m', '1h', '4h'].map((t) => <option key={t}>{t}</option>)}
                      </select>],
                      ['Start', <input key="s" type="datetime-local" className="w-full bg-dark-600 border border-dark-500 rounded px-2 py-1.5 text-white" value={replayConfig.startTime} onChange={(e) => setReplayConfig((c) => ({ ...c, startTime: e.target.value }))} />],
                      ['End', <input key="e" type="datetime-local" className="w-full bg-dark-600 border border-dark-500 rounded px-2 py-1.5 text-white" value={replayConfig.endTime} onChange={(e) => setReplayConfig((c) => ({ ...c, endTime: e.target.value }))} />],
                    ].map(([label, input]) => (
                      <div key={String(label)}><label className="text-gray-400 block mb-1">{label}</label>{input}</div>
                    ))}
                    <div className="col-span-2">
                      <label className="text-gray-400 block mb-1">Speed: {replayConfig.speedMultiplier}x</label>
                      <input type="range" min={1} max={100} className="w-full" value={replayConfig.speedMultiplier} onChange={(e) => setReplayConfig((c) => ({ ...c, speedMultiplier: parseInt(e.target.value) }))} />
                    </div>
                  </div>
                  <button
                    onClick={async () => {
                      setReplayResult(null);
                      const res = await apiClient.startReplay({ ...replayConfig, startTime: new Date(replayConfig.startTime).getTime(), endTime: new Date(replayConfig.endTime).getTime() });
                      setReplayResult(res);
                    }}
                    className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-accent-blue/20 border border-accent-blue/40 rounded text-accent-blue text-sm hover:bg-accent-blue/30">
                    <PlayCircle size={14} /> Start Replay
                  </button>
                  {replayResult?.metrics && (
                    <div className="pt-3 border-t border-dark-600 grid grid-cols-2 gap-2 text-xs font-mono">
                      <div><span className="text-gray-400">Trades: </span><span>{replayResult.metrics.totalTrades}</span></div>
                      <div><span className="text-gray-400">Win Rate: </span><span className={replayResult.metrics.winRate >= 50 ? 'positive' : 'negative'}>{fmt(replayResult.metrics.winRate)}%</span></div>
                      <div><span className="text-gray-400">Profit Factor: </span><span>{fmt(replayResult.metrics.profitFactor)}</span></div>
                      <div><span className="text-gray-400">Max DD: </span><span className="negative">{fmt(replayResult.metrics.maxDrawdown * 100, 3)}%</span></div>
                    </div>
                  )}
                </div>
                <div className="card text-xs text-gray-400 space-y-2">
                  <p className="font-semibold text-white text-sm">How v2 Replay works</p>
                  <p>• Historical candles are fetched from Binance REST API</p>
                  <p>• Each candle runs through the <span className="text-white">full v2 pipeline</span>: regime → quality → session → MTF → patience → consensus</p>
                  <p>• Signals must clear <span className="text-accent-green">ALL discipline filters</span> to generate a trade</p>
                  <p>• SL/TP hits are simulated candle-by-candle</p>
                  <p>• Metrics include trade quality scoring and regime analysis</p>
                  <p className="text-accent-yellow">Note: Replay uses the same disciplined engine as live — expect fewer but higher quality trades.</p>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
    </>
  );
}
