import axios from 'axios';

const api = axios.create({
  baseURL: '/api/backend',
  timeout: 15000,
});

export const apiClient = {
  // ---- Core ----
  getHealth: () => api.get('/health').then(r => r.data),
  getConfig: () => api.get('/config').then(r => r.data),

  // ---- Signals ----
  getSignals: () => api.get('/signals').then(r => r.data),
  getSignal: (pair: string) => api.get(`/signals/${pair}`).then(r => r.data),
  getSignalHistory: (limit = 20) => api.get(`/signals/history?limit=${limit}`).then(r => r.data),
  evaluateSignal: (pair: string, timeframe: string) =>
    api.post('/signals/evaluate', { pair, timeframe }).then(r => r.data),

  // ---- Positions ----
  getPositions: () => api.get('/positions').then(r => r.data),
  getTradeHistory: (limit = 50, mode?: string) =>
    api.get(`/positions/history?limit=${limit}${mode ? `&mode=${mode}` : ''}`).then(r => r.data),
  closePosition: (id: string) => api.post(`/positions/${id}/close`).then(r => r.data),

  // ---- Wallet ----
  getWallet: () => api.get('/wallet').then(r => r.data),

  // ---- Analytics ----
  getMetrics: (pair?: string, mode?: string) =>
    api.get(`/analytics/metrics${pair ? `?pair=${pair}` : ''}${mode ? `${pair ? '&' : '?'}mode=${mode}` : ''}`).then(r => r.data),
  getDailyPnl: (days = 30) => api.get(`/analytics/daily-pnl?days=${days}`).then(r => r.data),

  // ---- Risk ----
  getRiskState: () => api.get('/risk/state').then(r => r.data),

  // ---- Live Safety ----
  getCircuitBreaker: () => api.get('/live/circuit-breaker').then(r => r.data),
  resetCircuitBreaker: (reason: string) => api.post('/live/circuit-breaker/reset', { reason }).then(r => r.data),

  // ---- v2: Regime ----
  getRegimes: () => api.get('/regime').then(r => r.data),
  getRegime: (pair: string) => api.get(`/regime/${pair}`).then(r => r.data),

  // ---- v2: Quality ----
  getQualities: () => api.get('/quality').then(r => r.data),

  // ---- v2: Session ----
  getSession: () => api.get('/session').then(r => r.data),

  // ---- v2: Consensus ----
  getConsensus: (pair: string) => api.get(`/consensus/${pair}`).then(r => r.data),

  // ---- v2: Strategy Mode ----
  getStrategyMode: () => api.get('/strategy/mode').then(r => r.data),
  setStrategyMode: (mode: string) => api.post('/strategy/mode', { mode }).then(r => r.data),
  getStrategyModes: () => api.get('/strategy/modes').then(r => r.data),

  // ---- v2: Frequency & Streak ----
  getFrequency: () => api.get('/frequency').then(r => r.data),
  resetCooldown: () => api.post('/frequency/reset-cooldown').then(r => r.data),

  // ---- v2: Self Review ----
  getReviews: (limit = 10) => api.get(`/review?limit=${limit}`).then(r => r.data),

  // ---- Market data ----
  getCandles: (pair: string, timeframe = '15m', limit = 200) =>
    api.get(`/market/candles/${pair}?timeframe=${timeframe}&limit=${limit}`).then(r => r.data),
  getPrice: (pair: string) => api.get(`/market/price/${pair}`).then(r => r.data),
  getFunding: (pair: string) => api.get(`/market/funding/${pair}`).then(r => r.data),

  // ---- Replay ----
  startReplay: (cfg: object) => api.post('/replay/start', cfg).then(r => r.data),
  stopReplay: () => api.post('/replay/stop').then(r => r.data),
  getReplayStatus: () => api.get('/replay/status').then(r => r.data),

  // ---- AI ----
  getAIAnalysis: (limit = 20) => api.get(`/ai/analysis?limit=${limit}`).then(r => r.data),
};

export default apiClient;
