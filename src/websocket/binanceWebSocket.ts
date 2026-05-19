import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { config } from '../config';
import { createLogger } from '../utils/logger';
import { redis, CacheKeys } from '../redis/client';
import type { Candle, MarketTicker, AggregateTrade, TradingPair, Timeframe } from '../utils/types';

const log = createLogger('websocket');

const WS_BASE = 'wss://fstream.binance.com/stream';
const WS_BASE_TESTNET = 'wss://stream.binancefuture.com/stream';

interface KlinePayload {
  t: number; s: string; i: string; o: string; h: string; l: string;
  c: string; v: string; T: number; q: string; n: number; V: string; Q: string; x: boolean;
}

interface TickerPayload {
  s: string; c: string; b: string; a: string; v: string; P: string;
}

interface AggTradePayload {
  s: string; p: string; q: string; T: number; m: boolean;
}

export class BinanceWebSocketService extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private pingTimer: NodeJS.Timeout | null = null;
  private pingTimeout: NodeJS.Timeout | null = null;
  private isConnecting = false;
  private subscriptions: string[] = [];
  private msgCount = 0;
  private seenStreams = new Set<string>();
  private klineCount = 0;

  constructor(
    private readonly pairs: TradingPair[],
    private readonly timeframes: Timeframe[],
  ) {
    super();
    this.setMaxListeners(50);
  }

  start(): void {
    this.buildSubscriptions();
    this.connect();
  }

  private buildSubscriptions(): void {
    this.subscriptions = [];
    for (const pair of this.pairs) {
      const p = pair.toLowerCase();
      // Kline streams for each timeframe
      for (const tf of this.timeframes) {
        this.subscriptions.push(`${p}@kline_${tf}`);
      }
      // Aggregate trades
      this.subscriptions.push(`${p}@aggTrade`);
      // Mini ticker (price)
      this.subscriptions.push(`${p}@miniTicker`);
    }
  }

  private buildUrl(): string {
    const base = config.binance.testnet ? WS_BASE_TESTNET : WS_BASE;
    // Use /ws endpoint instead of /stream?streams= for programmatic subscription
    return base.replace('/stream', '/ws');
  }

  private connect(): void {
    if (this.isConnecting) return;
    this.isConnecting = true;

    const url = this.buildUrl();
    log.info({ url, streams: this.subscriptions.length }, 'Connecting to Binance WebSocket');

    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      log.info('Binance WebSocket connected, sending SUBSCRIBE...');
      this.isConnecting = false;
      this.reconnectAttempts = 0;

      // Subscribe via message instead of URL params
      const subscribeMsg = {
        method: 'SUBSCRIBE',
        params: this.subscriptions,
        id: 1,
      };
      this.ws!.send(JSON.stringify(subscribeMsg));
      log.info({ params: this.subscriptions }, 'SUBSCRIBE message sent');

      this.emit('connected');
      this.startPing();
    });

    this.ws.on('message', (data: WebSocket.RawData) => {
      try {
        this.msgCount++;
        const raw = data.toString();
        if (this.msgCount <= 3) {
          log.info({ raw: raw.substring(0, 300), msgCount: this.msgCount }, 'RAW WebSocket message');
        }
        if (this.msgCount % 500 === 0) {
          log.info({ totalMessages: this.msgCount, uniqueStreams: [...this.seenStreams], klineCount: this.klineCount }, 'WebSocket heartbeat');
        }

        const msg = JSON.parse(raw);

        // Handle SUBSCRIBE response
        if (msg.id && msg.result !== undefined) {
          log.info({ id: msg.id, result: msg.result }, 'SUBSCRIBE response received');
          return;
        }

        // Handle combined stream format: { stream: "...", data: {...} }
        if (msg.stream && msg.data) {
          if (!this.seenStreams.has(msg.stream)) {
            this.seenStreams.add(msg.stream);
            log.info({ stream: msg.stream }, 'New stream type discovered');
          }
          this.handleMessage(msg.stream, msg.data);
          return;
        }

        // Handle direct /ws format: { e: "kline", s: "BTCUSDT", ... }
        if (msg.e) {
          const symbol = (msg.s as string)?.toLowerCase() ?? '';
          let streamName = '';
          if (msg.e === 'kline' && msg.k?.i) {
            streamName = `${symbol}@kline_${msg.k.i}`;
            this.handleMessage(streamName, msg);
          } else if (msg.e === 'aggTrade') {
            streamName = `${symbol}@aggTrade`;
            this.handleMessage(streamName, msg);
          } else if (msg.e === '24hrMiniTicker') {
            streamName = `${symbol}@miniTicker`;
            this.handleMessage(streamName, msg);
          }
          if (streamName && !this.seenStreams.has(streamName)) {
            this.seenStreams.add(streamName);
            log.info({ stream: streamName }, 'New stream type discovered');
          }
          return;
        }
      } catch (err) {
        log.warn({ err }, 'Failed to parse WebSocket message');
      }
    });

    this.ws.on('error', (err) => {
      log.error({ err }, 'WebSocket error');
      this.isConnecting = false;
      this.emit('error', err);
    });

    this.ws.on('close', (code, reason) => {
      log.warn({ code, reason: reason.toString() }, 'WebSocket closed');
      this.isConnecting = false;
      this.stopPing();
      if (this.pingTimeout) {
        clearTimeout(this.pingTimeout);
        this.pingTimeout = null;
      }
      this.scheduleReconnect();
    });

    this.ws.on('pong', () => {
      log.debug('WebSocket pong received');
      if (this.pingTimeout) {
        clearTimeout(this.pingTimeout);
        this.pingTimeout = null;
      }
    });
  }

  private handleMessage(stream: string, data: unknown): void {
    const [symbol, streamType] = stream.split('@');
    const pair = symbol.toUpperCase() as TradingPair;

    if (streamType?.startsWith('kline_')) {
      this.klineCount++;
      const tf = streamType.replace('kline_', '') as Timeframe;
      const payload = (data as { k: KlinePayload }).k;
      const candle = this.parseCandle(payload);
      if (payload.x) {
        log.info({ pair, tf, close: candle.close }, '🕯️ KLINE CLOSED — emitting candle event');
      }
      this.emit('candle', { pair, timeframe: tf, candle, isClosed: payload.x });
      if (payload.x) {
        this.cacheCandle(pair, tf, candle);
      }
      return;
    }

    if (streamType === 'aggTrade') {
      const payload = data as AggTradePayload;
      const trade: AggregateTrade = {
        pair,
        price: parseFloat(payload.p),
        quantity: parseFloat(payload.q),
        side: payload.m ? 'SELL' : 'BUY',
        timestamp: payload.T,
        isBuyerMaker: payload.m,
      };
      this.emit('trade', trade);
      return;
    }

    if (streamType === 'miniTicker') {
      const payload = data as TickerPayload;
      const ticker: MarketTicker = {
        pair,
        price: parseFloat(payload.c),
        bid: parseFloat(payload.b),
        ask: parseFloat(payload.a),
        spread: parseFloat(payload.a) - parseFloat(payload.b),
        volume24h: parseFloat(payload.v),
        change24h: parseFloat(payload.P),
        timestamp: Date.now(),
      };
      this.emit('ticker', ticker);
      redis.setJson(CacheKeys.ticker(pair), ticker, 5).catch(() => {});
      return;
    }

    if (streamType.startsWith('depth')) {
      this.emit('depth', { pair, data });
    }
  }

  private parseCandle(k: KlinePayload): Candle {
    return {
      openTime: k.t,
      open: parseFloat(k.o),
      high: parseFloat(k.h),
      low: parseFloat(k.l),
      close: parseFloat(k.c),
      volume: parseFloat(k.v),
      closeTime: k.T,
      quoteVolume: parseFloat(k.q),
      trades: k.n,
      takerBuyVolume: parseFloat(k.V),
      takerSellVolume: parseFloat(k.v) - parseFloat(k.V),
    };
  }

  private async cacheCandle(pair: TradingPair, tf: Timeframe, candle: Candle): Promise<void> {
    try {
      const key = CacheKeys.candles(pair, tf);
      await redis.lpush(key, JSON.stringify(candle));
      await redis.ltrim(key, 0, 499); // Keep last 500 candles
      await redis.expire(key, 86400);
    } catch (err) {
      log.warn({ err }, 'Failed to cache candle');
    }
  }

  private startPing(): void {
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
        this.pingTimeout = setTimeout(() => {
          log.warn('WebSocket ping timeout — connection is dead (zombie), terminating...');
          this.ws?.terminate();
        }, 10000);
      }
    }, config.websocket.pingIntervalMs);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private scheduleReconnect(): void {
    // Never give up reconnecting — use exponential backoff with cap
    const delay = Math.min(
      config.websocket.reconnectDelayMs * Math.pow(1.5, Math.min(this.reconnectAttempts, 20)),
      60000, // max 60 seconds between attempts
    );
    this.reconnectAttempts++;

    if (this.reconnectAttempts % 10 === 0) {
      log.warn({ attempt: this.reconnectAttempts, delay }, 'WebSocket still reconnecting — persistent connection issues');
    } else {
      log.info({ attempt: this.reconnectAttempts, delay }, 'Scheduling WebSocket reconnect');
    }

    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  stop(): void {
    this.stopPing();
    if (this.pingTimeout) {
      clearTimeout(this.pingTimeout);
      this.pingTimeout = null;
    }
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
