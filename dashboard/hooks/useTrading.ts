import { useState, useEffect, useCallback } from 'react';
import { apiClient } from '../lib/apiClient';

export function useTrading(pollIntervalMs = 5000) {
  const [wallet, setWallet] = useState<any>(null);
  const [positions, setPositions] = useState<any[]>([]);
  const [metrics, setMetrics] = useState<any>(null);
  const [signals, setSignals] = useState<any[]>([]);
  const [riskState, setRiskState] = useState<any>(null);
  const [dailyPnl, setDailyPnl] = useState<any[]>([]);
  const [tradeHistory, setTradeHistory] = useState<any[]>([]);
  const [health, setHealth] = useState<any>(null);
  const [platformConfig, setPlatformConfig] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const fetchAll = useCallback(async () => {
    try {
      const [w, p, m, s, r, d, h, c] = await Promise.allSettled([
        apiClient.getWallet(),
        apiClient.getPositions(),
        apiClient.getMetrics(),
        apiClient.getSignals(),
        apiClient.getRiskState(),
        apiClient.getDailyPnl(30),
        apiClient.getHealth(),
        apiClient.getConfig(),
      ]);

      if (w.status === 'fulfilled') setWallet(w.value.wallet);
      if (p.status === 'fulfilled') setPositions(p.value.positions || []);
      if (m.status === 'fulfilled') setMetrics(m.value.metrics);
      if (s.status === 'fulfilled') setSignals(s.value.signals || []);
      if (r.status === 'fulfilled') setRiskState(r.value.state);
      if (d.status === 'fulfilled') setDailyPnl(d.value.data || []);
      if (h.status === 'fulfilled') setHealth(h.value);
      if (c.status === 'fulfilled') setPlatformConfig(c.value);
    } catch (_e) {
      // Ignore individual failures
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchTradeHistory = useCallback(async () => {
    try {
      const data = await apiClient.getTradeHistory(50);
      setTradeHistory(data.trades || []);
    } catch (_e) {}
  }, []);

  useEffect(() => {
    fetchAll();
    fetchTradeHistory();
    const interval = setInterval(fetchAll, pollIntervalMs);
    return () => clearInterval(interval);
  }, [fetchAll, fetchTradeHistory, pollIntervalMs]);

  const closePosition = useCallback(async (id: string) => {
    await apiClient.closePosition(id);
    await fetchAll();
  }, [fetchAll]);

  const evaluateSignal = useCallback(async (pair: string, timeframe: string) => {
    return apiClient.evaluateSignal(pair, timeframe);
  }, []);

  return {
    wallet, positions, metrics, signals, riskState,
    dailyPnl, tradeHistory, health, platformConfig,
    loading, closePosition, evaluateSignal, refresh: fetchAll,
  };
}
