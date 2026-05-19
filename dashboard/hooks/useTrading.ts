import { useState, useEffect, useCallback } from 'react';
import { apiClient } from '../lib/apiClient';

export function useTrading(pollMs = 5000) {
  const [wallet, setWallet]             = useState<any>(null);
  const [positions, setPositions]       = useState<any[]>([]);
  const [metrics, setMetrics]           = useState<any>(null);
  const [signals, setSignals]           = useState<any[]>([]);
  const [riskState, setRiskState]       = useState<any>(null);
  const [dailyPnl, setDailyPnl]         = useState<any[]>([]);
  const [tradeHistory, setTradeHistory] = useState<any[]>([]);
  const [health, setHealth]             = useState<any>(null);
  const [platformConfig, setPlatformConfig] = useState<any>(null);
  const [regimes, setRegimes]           = useState<any>({});
  const [qualities, setQualities]       = useState<any>({});
  const [session, setSession]           = useState<any>(null);
  const [frequency, setFrequency]       = useState<any>(null);
  const [reviews, setReviews]           = useState<any[]>([]);
  const [loading, setLoading]           = useState(true);
  const [noTrades, setNoTrades]         = useState<any[]>([]);

  const fetchAll = useCallback(async () => {
    const results = await Promise.allSettled([
      apiClient.getWallet(),
      apiClient.getPositions(),
      apiClient.getMetrics(),
      apiClient.getSignals(),
      apiClient.getRiskState(),
      apiClient.getDailyPnl(30),
      apiClient.getHealth(),
      apiClient.getConfig(),
      // v2 endpoints
      fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'}/api/regime`).then(r => r.json()),
      fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'}/api/quality`).then(r => r.json()),
      fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'}/api/session`).then(r => r.json()),
      fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'}/api/frequency`).then(r => r.json()),
    ]);

    const [w, p, m, s, r, d, h, c, reg, qual, sess, freq] = results;
    if (w.status === 'fulfilled') setWallet(w.value.wallet);
    if (p.status === 'fulfilled') setPositions(p.value.positions || []);
    if (m.status === 'fulfilled') setMetrics(m.value.metrics);
    if (s.status === 'fulfilled') setSignals(s.value.signals || []);
    if (r.status === 'fulfilled') setRiskState(r.value.state);
    if (d.status === 'fulfilled') setDailyPnl(d.value.data || []);
    if (h.status === 'fulfilled') setHealth(h.value);
    if (c.status === 'fulfilled') setPlatformConfig(c.value);
    if (reg.status === 'fulfilled') setRegimes((reg.value as any).regimes || {});
    if (qual.status === 'fulfilled') setQualities((qual.value as any).scores || {});
    if (sess.status === 'fulfilled') setSession((sess.value as any).session);
    if (freq.status === 'fulfilled') setFrequency(freq.value);

    setLoading(false);
  }, []);

  const fetchReviews = useCallback(async () => {
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'}/api/review?limit=10`);
      const data = await res.json();
      setReviews(data.reviews || []);
    } catch {}
  }, []);

  const fetchTradeHistory = useCallback(async () => {
    try {
      const data = await apiClient.getTradeHistory(50);
      setTradeHistory(data.trades || []);
    } catch {}
  }, []);

  useEffect(() => {
    fetchAll();
    fetchReviews();
    fetchTradeHistory();
    const interval = setInterval(fetchAll, pollMs);
    return () => clearInterval(interval);
  }, [fetchAll, fetchReviews, fetchTradeHistory, pollMs]);

  const addNoTrade = useCallback((entry: any) => {
    setNoTrades((prev) => [entry, ...prev].slice(0, 50));
  }, []);

  const closePosition = useCallback(async (id: string) => {
    await apiClient.closePosition(id);
    await fetchAll();
  }, [fetchAll]);

  const setStrategyMode = useCallback(async (mode: string) => {
    await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'}/api/strategy/mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
    await fetchAll();
  }, [fetchAll]);

  const resetCooldown = useCallback(async () => {
    await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'}/api/frequency/reset-cooldown`, { method: 'POST' });
    await fetchAll();
  }, [fetchAll]);

  return {
    wallet, positions, metrics, signals, riskState, dailyPnl, tradeHistory,
    health, platformConfig, regimes, qualities, session, frequency, reviews,
    noTrades, loading, addNoTrade, closePosition, setStrategyMode, resetCooldown,
    refresh: fetchAll,
  };
}
