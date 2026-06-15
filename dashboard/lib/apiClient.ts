import axios from 'axios';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
const API_TOKEN = process.env.NEXT_PUBLIC_DASHBOARD_API_TOKEN || '';
const api = axios.create({
  baseURL: API_URL,
  timeout: 15000,
  headers: API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : undefined,
});

export const apiClient = {
  // ---- Core ----
  getHealth: () => api.get('/health').then(r => r.data),
  getConfig: () => api.get('/api/config').then(r => r.data),

  // ---- Signals ----
  getSignals: () => api.get('/api/signals').then(r => r.data),
  getSignal: (pair: string) => api.get(`/api/signals/${pair}`).then(r => r.data),
  getSignalHistory: (limit = 20) => api.get(`/api/signals/history?limit=${limit}`).then(r => r.data),
  evaluateSignal: (pair: string, timeframe: string) =>
    api.post('/api/signals/evaluate', { pair, timeframe }).then(r => r.data),

  // ---- Positions ----
  getPositions: () => api.get('/api/positions').then(r => r.data),
  getTradeHistory: (limit = 50, mode?: string) =>
    api.get(`/api/positions/history?limit=${limit}${mode ? `&mode=${mode}` : ''}`).then(r => r.data),
  closePosition: (id: string) => api.post(`/api/positions/${id}/close`).then(r => r.data),

  // ---- Wallet ----
  getWallet: () => api.get('/api/wallet').then(r => r.data),

  // ---- Analytics ----
  getMetrics: (pair?: string, mode?: string) =>
    api.get(`/api/analytics/metrics${pair ? `?pair=${pair}` : ''}${mode ? `${pair ? '&' : '?'}mode=${mode}` : ''}`).then(r => r.data),
  getDailyPnl: (days = 30) => api.get(`/api/analytics/daily-pnl?days=${days}`).then(r => r.data),

  // ---- Risk ----
  getRiskState: () => api.get('/api/risk/state').then(r => r.data),

  // ---- v2: Regime ----
  getRegimes: () => api.get('/api/regime').then(r => r.data),
  getRegime: (pair: string) => api.get(`/api/regime/${pair}`).then(r => r.data),

  // ---- v2: Quality ----
  getQualities: () => api.get('/api/quality').then(r => r.data),

  // ---- v2: Session ----
  getSession: () => api.get('/api/session').then(r => r.data),

  // ---- v2: Consensus ----
  getConsensus: (pair: string) => api.get(`/api/consensus/${pair}`).then(r => r.data),

  // ---- v2: Strategy Mode ----
  getStrategyMode: () => api.get('/api/strategy/mode').then(r => r.data),
  setStrategyMode: (mode: string) => api.post('/api/strategy/mode', { mode }).then(r => r.data),
  getStrategyModes: () => api.get('/api/strategy/modes').then(r => r.data),

  // ---- v2: Frequency & Streak ----
  getFrequency: () => api.get('/api/frequency').then(r => r.data),
  resetCooldown: () => api.post('/api/frequency/reset-cooldown').then(r => r.data),

  // ---- v2: Self Review ----
  getReviews: (limit = 10) => api.get(`/api/review?limit=${limit}`).then(r => r.data),

  // ---- Market data ----
  getCandles: (pair: string, timeframe = '15m', limit = 200) =>
    api.get(`/api/market/candles/${pair}?timeframe=${timeframe}&limit=${limit}`).then(r => r.data),
  getPrice: (pair: string) => api.get(`/api/market/price/${pair}`).then(r => r.data),
  getFunding: (pair: string) => api.get(`/api/market/funding/${pair}`).then(r => r.data),

  // ---- Replay ----
  startReplay: (cfg: object) => api.post('/api/replay/start', cfg).then(r => r.data),
  stopReplay: () => api.post('/api/replay/stop').then(r => r.data),
  getReplayStatus: () => api.get('/api/replay/status').then(r => r.data),

  // ---- AI ----
  getAIAnalysis: (limit = 20) => api.get(`/api/ai/analysis?limit=${limit}`).then(r => r.data),
};

export default apiClient;
