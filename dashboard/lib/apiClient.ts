import axios from 'axios';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

const api = axios.create({ baseURL: API_URL, timeout: 10000 });

export const apiClient = {
  // Signals
  getSignals: () => api.get('/api/signals').then((r) => r.data),
  getSignal: (pair: string) => api.get(`/api/signals/${pair}`).then((r) => r.data),
  getSignalHistory: (limit = 20) => api.get(`/api/signals/history?limit=${limit}`).then((r) => r.data),
  evaluateSignal: (pair: string, timeframe: string) =>
    api.post('/api/signals/evaluate', { pair, timeframe }).then((r) => r.data),

  // Positions
  getPositions: () => api.get('/api/positions').then((r) => r.data),
  getTradeHistory: (limit = 50) => api.get(`/api/positions/history?limit=${limit}`).then((r) => r.data),
  closePosition: (id: string) => api.post(`/api/positions/${id}/close`).then((r) => r.data),

  // Wallet
  getWallet: () => api.get('/api/wallet').then((r) => r.data),

  // Analytics
  getMetrics: (pair?: string) => api.get(`/api/analytics/metrics${pair ? `?pair=${pair}` : ''}`).then((r) => r.data),
  getDailyPnl: (days = 30) => api.get(`/api/analytics/daily-pnl?days=${days}`).then((r) => r.data),

  // Risk
  getRiskState: () => api.get('/api/risk/state').then((r) => r.data),

  // Market
  getCandles: (pair: string, timeframe = '15m', limit = 200) =>
    api.get(`/api/market/candles/${pair}?timeframe=${timeframe}&limit=${limit}`).then((r) => r.data),
  getPrice: (pair: string) => api.get(`/api/market/price/${pair}`).then((r) => r.data),
  getFunding: (pair: string) => api.get(`/api/market/funding/${pair}`).then((r) => r.data),

  // Replay
  startReplay: (config: object) => api.post('/api/replay/start', config).then((r) => r.data),
  stopReplay: () => api.post('/api/replay/stop').then((r) => r.data),
  getReplayStatus: () => api.get('/api/replay/status').then((r) => r.data),

  // AI
  getAIAnalysis: (limit = 20) => api.get(`/api/ai/analysis?limit=${limit}`).then((r) => r.data),

  // Config
  getConfig: () => api.get('/api/config').then((r) => r.data),

  // Health
  getHealth: () => api.get('/health').then((r) => r.data),
};

export default apiClient;
