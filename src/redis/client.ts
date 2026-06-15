import Redis from 'ioredis';
import { config } from '../config';
import { createLogger } from '../utils/logger';

const log = createLogger('redis');

class RedisClient {
  private client: Redis;
  private static instance: RedisClient;

  private constructor() {
    this.client = new Redis({
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password || undefined,
      db: config.redis.db,
      retryStrategy: (times) => Math.min(times * 50, 2000),
      maxRetriesPerRequest: 3,
      lazyConnect: false,
    });

    this.client.on('error', (err) => log.error({ err }, 'Redis error'));
    this.client.on('connect', () => log.info('Redis connected'));
    this.client.on('reconnecting', () => log.warn('Redis reconnecting'));
  }

  static getInstance(): RedisClient {
    if (!RedisClient.instance) {
      RedisClient.instance = new RedisClient();
    }
    return RedisClient.instance;
  }

  getClient(): Redis {
    return this.client;
  }

  // ---- Key-value operations ----
  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) {
      await this.client.setex(key, ttlSeconds, value);
    } else {
      await this.client.set(key, value);
    }
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  async exists(key: string): Promise<boolean> {
    return (await this.client.exists(key)) === 1;
  }

  // ---- JSON helpers ----
  async setJson<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    await this.set(key, JSON.stringify(value), ttlSeconds);
  }

  async getJson<T>(key: string): Promise<T | null> {
    const val = await this.get(key);
    if (!val) return null;
    try {
      return JSON.parse(val) as T;
    } catch {
      return null;
    }
  }

  // ---- Hash operations ----
  async hset(key: string, field: string, value: string): Promise<void> {
    await this.client.hset(key, field, value);
  }

  async hget(key: string, field: string): Promise<string | null> {
    return this.client.hget(key, field);
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return this.client.hgetall(key);
  }

  // ---- List operations (for recent candles, trades) ----
  async lpush(key: string, ...values: string[]): Promise<void> {
    await this.client.lpush(key, ...values);
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    return this.client.lrange(key, start, stop);
  }

  async ltrim(key: string, start: number, stop: number): Promise<void> {
    await this.client.ltrim(key, start, stop);
  }

  // ---- Pub/Sub ----
  async publish(channel: string, message: string): Promise<void> {
    await this.client.publish(channel, message);
  }

  subscribe(channel: string, callback: (msg: string) => void): Redis {
    const sub = this.client.duplicate();
    sub.subscribe(channel);
    sub.on('message', (_ch, msg) => callback(msg));
    return sub;
  }

  // ---- Atomic counter ----
  async incr(key: string): Promise<number> {
    return this.client.incr(key);
  }

  async expire(key: string, seconds: number): Promise<void> {
    await this.client.expire(key, seconds);
  }

  async ttl(key: string): Promise<number> {
    return this.client.ttl(key);
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.client.ping();
      return true;
    } catch {
      return false;
    }
  }

  async flushPattern(pattern: string): Promise<void> {
    const keys = await this.client.keys(pattern);
    if (keys.length > 0) {
      await this.client.del(...keys);
    }
  }

  async close(): Promise<void> {
    await this.client.quit();
  }
}

export const redis = RedisClient.getInstance();
export default redis;

// ---- Cache key builders ----
export const CacheKeys = {
  candles: (pair: string, tf: string) => `candles:${pair}:${tf}`,
  ticker: (pair: string) => `ticker:${pair}`,
  orderbook: (pair: string) => `orderbook:${pair}`,
  indicators: (pair: string, tf: string) => `indicators:${pair}:${tf}`,
  signal: (pair: string) => `signal:latest:${pair}`,
  position: (posId: string) => `position:${posId}`,
  openPositions: () => `positions:open`,
  dryRunWallet: () => `dryrun:wallet`,
  fundingRate: (pair: string) => `funding:${pair}`,
  riskState: () => `risk:state`,
  liveCircuitBreaker: () => `live:circuit_breaker`,
  whaleActivity: (pair: string) => `whale:${pair}`,
  agentCache: (agent: string, pair: string) => `agent:${agent}:${pair}`,
};
