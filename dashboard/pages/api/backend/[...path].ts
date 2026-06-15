import type { NextApiRequest, NextApiResponse } from 'next';

type Method = 'GET' | 'POST';

interface ProxyRoute {
  readonly pattern: RegExp;
  readonly methods: readonly Method[];
  readonly backendPath: (proxyPath: string) => string;
  readonly validateBody?: (body: unknown) => string | null;
}

const PAIRS = new Set(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
const TIMEFRAMES = new Set(['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d']);
const STRATEGY_MODES = new Set(['scalping', 'swing', 'investing', 'safe', 'aggressive']);

const apiPath = (proxyPath: string): string => `/api/${proxyPath}`;

export const BACKEND_PROXY_ROUTES: readonly ProxyRoute[] = [
  { pattern: /^health$/, methods: ['GET'], backendPath: () => '/health' },
  { pattern: /^config$/, methods: ['GET'], backendPath: apiPath },
  { pattern: /^signals$/, methods: ['GET'], backendPath: apiPath },
  { pattern: /^signals\/history$/, methods: ['GET'], backendPath: apiPath },
  { pattern: /^signals\/[A-Z0-9]+$/, methods: ['GET'], backendPath: apiPath },
  { pattern: /^signals\/evaluate$/, methods: ['POST'], backendPath: apiPath, validateBody: validateSignalEvaluateBody },
  { pattern: /^positions$/, methods: ['GET'], backendPath: apiPath },
  { pattern: /^positions\/history$/, methods: ['GET'], backendPath: apiPath },
  { pattern: /^positions\/[A-Za-z0-9:_-]+\/close$/, methods: ['POST'], backendPath: apiPath },
  { pattern: /^wallet$/, methods: ['GET'], backendPath: apiPath },
  { pattern: /^analytics\/metrics$/, methods: ['GET'], backendPath: apiPath },
  { pattern: /^analytics\/daily-pnl$/, methods: ['GET'], backendPath: apiPath },
  { pattern: /^risk\/state$/, methods: ['GET'], backendPath: apiPath },
  { pattern: /^live\/circuit-breaker$/, methods: ['GET'], backendPath: apiPath },
  { pattern: /^live\/circuit-breaker\/reset$/, methods: ['POST'], backendPath: apiPath, validateBody: validateCircuitBreakerResetBody },
  { pattern: /^regime$/, methods: ['GET'], backendPath: apiPath },
  { pattern: /^regime\/[A-Z0-9]+$/, methods: ['GET'], backendPath: apiPath },
  { pattern: /^quality$/, methods: ['GET'], backendPath: apiPath },
  { pattern: /^session$/, methods: ['GET'], backendPath: apiPath },
  { pattern: /^consensus\/[A-Z0-9]+$/, methods: ['GET'], backendPath: apiPath },
  { pattern: /^strategy\/mode$/, methods: ['GET', 'POST'], backendPath: apiPath, validateBody: validateStrategyModeBody },
  { pattern: /^strategy\/modes$/, methods: ['GET'], backendPath: apiPath },
  { pattern: /^frequency$/, methods: ['GET'], backendPath: apiPath },
  { pattern: /^frequency\/reset-cooldown$/, methods: ['POST'], backendPath: apiPath },
  { pattern: /^review$/, methods: ['GET'], backendPath: apiPath },
  { pattern: /^market\/candles\/[A-Z0-9]+$/, methods: ['GET'], backendPath: apiPath },
  { pattern: /^market\/price\/[A-Z0-9]+$/, methods: ['GET'], backendPath: apiPath },
  { pattern: /^market\/funding\/[A-Z0-9]+$/, methods: ['GET'], backendPath: apiPath },
  { pattern: /^replay\/start$/, methods: ['POST'], backendPath: apiPath, validateBody: validateReplayStartBody },
  { pattern: /^replay\/stop$/, methods: ['POST'], backendPath: apiPath },
  { pattern: /^replay\/status$/, methods: ['GET'], backendPath: apiPath },
  { pattern: /^ai\/analysis$/, methods: ['GET'], backendPath: apiPath },
];

export function resolveBackendProxyRoute(proxyPath: string, method: string): { route: ProxyRoute; backendPath: string } | null {
  const normalizedMethod = method.toUpperCase() as Method;
  const route = BACKEND_PROXY_ROUTES.find((candidate) => candidate.pattern.test(proxyPath));
  if (!route || !route.methods.includes(normalizedMethod)) return null;
  return { route, backendPath: route.backendPath(proxyPath) };
}

export default async function backendProxyHandler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  const proxyPath = normalizeProxyPath(req.query['path']);
  if (!proxyPath) {
    sendProxyError(res, 404, 'PROXY_PATH_NOT_ALLOWED', 'Backend proxy path is not allowed');
    return;
  }

  const resolved = resolveBackendProxyRoute(proxyPath, req.method ?? 'GET');
  if (!resolved) {
    sendProxyError(res, 405, 'PROXY_ROUTE_NOT_ALLOWED', 'Backend proxy route or method is not allowed');
    return;
  }

  if (resolved.route.validateBody && req.method === 'POST') {
    const validationError = resolved.route.validateBody(req.body);
    if (validationError) {
      sendProxyError(res, 400, 'PROXY_VALIDATION_ERROR', validationError);
      return;
    }
  }

  const backendUrl = buildBackendUrl(resolved.backendPath, req);
  const token = process.env['BACKEND_API_TOKEN'] || process.env['DASHBOARD_API_TOKEN'] || '';
  if (resolved.backendPath.startsWith('/api/') && !token) {
    sendProxyError(res, 503, 'BACKEND_TOKEN_NOT_CONFIGURED', 'Backend API token is not configured on the dashboard server');
    return;
  }

  try {
    const response = await fetch(backendUrl, {
      method: req.method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(req.method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      },
      body: req.method === 'POST' ? JSON.stringify(req.body ?? {}) : undefined,
    });

    if (response.status === 401 || response.status === 403) {
      sendProxyError(res, response.status, 'BACKEND_AUTH_REJECTED', 'Backend authorization failed');
      return;
    }

    const contentType = response.headers.get('content-type') ?? '';
    res.status(response.status);
    if (contentType.includes('application/json')) {
      res.json(await response.json());
      return;
    }

    res.send(await response.text());
  } catch {
    sendProxyError(res, 502, 'BACKEND_UNREACHABLE', 'Backend service is unreachable');
  }
}

function normalizeProxyPath(pathParam: string | string[] | undefined): string | null {
  const segments = Array.isArray(pathParam) ? pathParam : pathParam ? [pathParam] : [];
  if (segments.length === 0) return null;
  if (segments.some((segment) => !/^[A-Za-z0-9:_-]+$/.test(segment))) return null;
  return segments.join('/');
}

function buildBackendUrl(backendPath: string, req: NextApiRequest): string {
  const baseUrl = process.env['BACKEND_API_URL'] || process.env['DASHBOARD_API_URL'] || 'http://localhost:3001';
  const url = new URL(backendPath, baseUrl);
  const requestUrl = new URL(req.url ?? '', 'http://dashboard.local');
  requestUrl.searchParams.forEach((value, key) => {
    if (key !== 'path') url.searchParams.append(key, value);
  });
  return url.toString();
}

function sendProxyError(res: NextApiResponse, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

function validateSignalEvaluateBody(body: unknown): string | null {
  const value = asRecord(body);
  if (!value) return 'Request body must be an object';
  if (typeof value['pair'] !== 'string' || !PAIRS.has(value['pair'].toUpperCase())) return 'Invalid pair';
  if (value['timeframe'] !== undefined && (typeof value['timeframe'] !== 'string' || !TIMEFRAMES.has(value['timeframe']))) return 'Invalid timeframe';
  return null;
}

function validateStrategyModeBody(body: unknown): string | null {
  const value = asRecord(body);
  if (!value) return 'Request body must be an object';
  if (typeof value['mode'] !== 'string' || !STRATEGY_MODES.has(value['mode'])) return 'Invalid strategy mode';
  return null;
}

function validateReplayStartBody(body: unknown): string | null {
  const value = asRecord(body);
  if (!value) return 'Request body must be an object';
  if (typeof value['pair'] !== 'string' || !PAIRS.has(value['pair'].toUpperCase())) return 'Invalid pair';
  if (typeof value['timeframe'] !== 'string' || !TIMEFRAMES.has(value['timeframe'])) return 'Invalid timeframe';

  const startTime = finiteNumber(value['startTime']);
  const endTime = finiteNumber(value['endTime']);
  const speedMultiplier = finiteNumber(value['speedMultiplier']);
  if (startTime === null || endTime === null || endTime <= startTime) return 'Invalid replay time range';
  if (speedMultiplier === null || speedMultiplier < 1 || speedMultiplier > 100) return 'Invalid replay speed';
  return null;
}

function validateCircuitBreakerResetBody(body: unknown): string | null {
  const value = asRecord(body);
  if (!value) return 'Request body must be an object';
  if (typeof value['reason'] !== 'string' || value['reason'].trim().length < 8 || value['reason'].trim().length > 500) {
    return 'Reset reason must be 8-500 characters';
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}
