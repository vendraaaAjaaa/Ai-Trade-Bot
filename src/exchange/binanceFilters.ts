/**
 * =============================================
 * BINANCE_FILTERS — Phase 8 Order Formatting Safety
 * =============================================
 *
 * Changes from Phase 8:
 *   - Fetches and caches USD-M Futures exchangeInfo symbol filters.
 *   - Normalizes quantities and prices using stepSize and tickSize.
 *   - Rejects orders that fail min/max quantity or min-notional checks.
 *
 * Safety preserved:
 *   - Quantity is never rounded up above the risk-approved size.
 *   - Invalid or missing exchange filters fail closed.
 */

import axios from 'axios';
import { config } from '../config';
import { createLogger } from '../utils/logger';
import type { TradingPair } from '../utils/types';

const log = createLogger('binance-filters');
const FILTER_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

export class OrderFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderFormatError';
  }
}

export interface PriceFilter {
  minPrice: string;
  maxPrice: string;
  tickSize: string;
}

export interface QuantityFilter {
  minQty: string;
  maxQty: string;
  stepSize: string;
}

export interface SymbolFilters {
  symbol: TradingPair;
  priceFilter: PriceFilter;
  lotSize: QuantityFilter;
  marketLotSize: QuantityFilter;
  minNotional: string;
}

export interface NormalizedQuantity {
  quantity: number;
  quantityText: string;
  notional: number;
}

export interface NormalizedPrice {
  price: number;
  priceText: string;
}

interface BinanceExchangeInfo {
  symbols: BinanceSymbolInfo[];
}

interface BinanceSymbolInfo {
  symbol: string;
  filters: BinanceFilter[];
}

interface BinanceFilter {
  filterType: string;
  minPrice?: string;
  maxPrice?: string;
  tickSize?: string;
  minQty?: string;
  maxQty?: string;
  stepSize?: string;
  notional?: string;
  minNotional?: string;
}

type FilterFetcher = (pair: TradingPair) => Promise<SymbolFilters>;
type RoundingMode = 'floor' | 'ceil';

interface CacheEntry {
  filters: SymbolFilters;
  expiresAt: number;
}

export class BinanceFilterService {
  private readonly baseUrl: string;
  private readonly cache = new Map<TradingPair, CacheEntry>();
  private readonly fetcher?: FilterFetcher;

  constructor(fetcher?: FilterFetcher) {
    this.baseUrl = config.binance.testnet
      ? config.binance.testnetFuturesUrl
      : config.binance.futuresBaseUrl;
    this.fetcher = fetcher;
  }

  async getSymbolFilters(pair: TradingPair): Promise<SymbolFilters> {
    const now = Date.now();
    const cached = this.cache.get(pair);
    if (cached && cached.expiresAt > now) {
      return cached.filters;
    }

    const filters = this.fetcher ? await this.fetcher(pair) : await this.fetchFromExchangeInfo(pair);
    this.cache.set(pair, { filters, expiresAt: now + FILTER_CACHE_TTL_MS });
    return filters;
  }

  async normalizeMarketOrder(pair: TradingPair, requestedQuantity: number, referencePrice: number): Promise<NormalizedQuantity> {
    const filters = await this.getSymbolFilters(pair);
    const lot = this.usableMarketLot(filters);
    return this.normalizeQuantity(pair, requestedQuantity, referencePrice, lot, filters.minNotional, 'market quantity');
  }

  async normalizeReduceOnlyQuantity(pair: TradingPair, requestedQuantity: number, referencePrice: number): Promise<NormalizedQuantity> {
    const filters = await this.getSymbolFilters(pair);
    return this.normalizeQuantity(pair, requestedQuantity, referencePrice, filters.lotSize, filters.minNotional, 'reduce-only quantity');
  }

  async normalizePrice(pair: TradingPair, requestedPrice: number, rounding: RoundingMode): Promise<NormalizedPrice> {
    const filters = await this.getSymbolFilters(pair);
    if (!Number.isFinite(requestedPrice) || requestedPrice <= 0) {
      throw new OrderFormatError(`${pair}: price must be a positive finite number`);
    }

    const normalized = normalizeByIncrement(requestedPrice, filters.priceFilter.tickSize, rounding);
    const minPrice = Number(filters.priceFilter.minPrice);
    const maxPrice = Number(filters.priceFilter.maxPrice);

    if (minPrice > 0 && normalized.value < minPrice) {
      throw new OrderFormatError(`${pair}: normalized price ${normalized.text} is below minPrice ${filters.priceFilter.minPrice}`);
    }

    if (maxPrice > 0 && normalized.value > maxPrice) {
      throw new OrderFormatError(`${pair}: normalized price ${normalized.text} is above maxPrice ${filters.priceFilter.maxPrice}`);
    }

    return { price: normalized.value, priceText: normalized.text };
  }

  private async fetchFromExchangeInfo(pair: TradingPair): Promise<SymbolFilters> {
    const response = await axios.get<BinanceExchangeInfo>(`${this.baseUrl}/fapi/v1/exchangeInfo`, { timeout: 10000 });
    const symbol = response.data.symbols.find((item) => item.symbol === pair);
    if (!symbol) {
      throw new OrderFormatError(`${pair}: missing exchangeInfo symbol filters`);
    }

    const priceFilter = symbol.filters.find((filter) => filter.filterType === 'PRICE_FILTER');
    const lotSize = symbol.filters.find((filter) => filter.filterType === 'LOT_SIZE');
    const marketLotSize = symbol.filters.find((filter) => filter.filterType === 'MARKET_LOT_SIZE');
    const minNotional = symbol.filters.find((filter) => filter.filterType === 'MIN_NOTIONAL' || filter.filterType === 'NOTIONAL');

    const parsed = {
      symbol: pair,
      priceFilter: this.parsePriceFilter(pair, priceFilter),
      lotSize: this.parseQuantityFilter(pair, lotSize, 'LOT_SIZE'),
      marketLotSize: marketLotSize
        ? this.parseQuantityFilter(pair, marketLotSize, 'MARKET_LOT_SIZE')
        : this.parseQuantityFilter(pair, lotSize, 'LOT_SIZE'),
      minNotional: minNotional?.notional ?? minNotional?.minNotional ?? '0',
    };

    log.debug({ pair }, 'Loaded Binance symbol filters');
    return parsed;
  }

  private parsePriceFilter(pair: TradingPair, filter: BinanceFilter | undefined): PriceFilter {
    if (!filter?.tickSize || !filter.minPrice || !filter.maxPrice) {
      throw new OrderFormatError(`${pair}: missing PRICE_FILTER fields`);
    }

    return {
      minPrice: filter.minPrice,
      maxPrice: filter.maxPrice,
      tickSize: filter.tickSize,
    };
  }

  private parseQuantityFilter(pair: TradingPair, filter: BinanceFilter | undefined, filterName: string): QuantityFilter {
    if (!filter?.stepSize || !filter.minQty || !filter.maxQty) {
      throw new OrderFormatError(`${pair}: missing ${filterName} fields`);
    }

    return {
      minQty: filter.minQty,
      maxQty: filter.maxQty,
      stepSize: filter.stepSize,
    };
  }

  private usableMarketLot(filters: SymbolFilters): QuantityFilter {
    return Number(filters.marketLotSize.stepSize) > 0 ? filters.marketLotSize : filters.lotSize;
  }

  private normalizeQuantity(
    pair: TradingPair,
    requestedQuantity: number,
    referencePrice: number,
    lot: QuantityFilter,
    minNotionalText: string,
    label: string,
  ): NormalizedQuantity {
    if (!Number.isFinite(requestedQuantity) || requestedQuantity <= 0) {
      throw new OrderFormatError(`${pair}: ${label} must be a positive finite number`);
    }

    if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
      throw new OrderFormatError(`${pair}: reference price must be a positive finite number`);
    }

    const normalized = normalizeByIncrement(requestedQuantity, lot.stepSize, 'floor');
    const minQty = Number(lot.minQty);
    const maxQty = Number(lot.maxQty);

    if (normalized.value <= 0) {
      throw new OrderFormatError(`${pair}: normalized ${label} is zero`);
    }

    if (minQty > 0 && normalized.value < minQty) {
      throw new OrderFormatError(`${pair}: normalized ${label} ${normalized.text} is below minQty ${lot.minQty}`);
    }

    if (maxQty > 0 && normalized.value > maxQty) {
      throw new OrderFormatError(`${pair}: normalized ${label} ${normalized.text} is above maxQty ${lot.maxQty}`);
    }

    const notional = normalized.value * referencePrice;
    const minNotional = Number(minNotionalText);
    if (minNotional > 0 && notional < minNotional) {
      throw new OrderFormatError(`${pair}: order notional ${notional.toFixed(8)} is below minNotional ${minNotionalText}`);
    }

    return {
      quantity: normalized.value,
      quantityText: normalized.text,
      notional,
    };
  }
}

function normalizeByIncrement(value: number, increment: string, rounding: RoundingMode): { value: number; text: string } {
  const scale = decimalScale(increment);
  const factor = 10 ** scale;
  const incrementInt = decimalStringToInt(increment, scale);
  if (incrementInt <= 0n) {
    throw new OrderFormatError(`Invalid exchange increment ${increment}`);
  }

  const scaledValue = BigInt(
    rounding === 'ceil'
      ? Math.ceil(value * factor - 1e-9)
      : Math.floor(value * factor + 1e-9),
  );

  const remainder = scaledValue % incrementInt;
  const normalizedInt = remainder === 0n
    ? scaledValue
    : rounding === 'ceil'
      ? scaledValue + (incrementInt - remainder)
      : scaledValue - remainder;

  return {
    value: Number(normalizedInt) / factor,
    text: scaledIntToString(normalizedInt, scale),
  };
}

function decimalScale(value: string): number {
  const normalized = value.toLowerCase();
  if (normalized.includes('e')) {
    const asNumber = Number(normalized);
    if (!Number.isFinite(asNumber)) {
      throw new OrderFormatError(`Invalid decimal increment ${value}`);
    }
    return decimalScale(asNumber.toFixed(20).replace(/0+$/, ''));
  }

  const [, fractional = ''] = normalized.split('.');
  return fractional.length;
}

function decimalStringToInt(value: string, scale: number): bigint {
  const normalized = value.trim();
  const [wholePart, fractionalPart = ''] = normalized.split('.');
  const whole = BigInt(wholePart || '0') * (10n ** BigInt(scale));
  const paddedFractional = `${fractionalPart}${'0'.repeat(scale)}`.slice(0, scale);
  return whole + BigInt(paddedFractional || '0');
}

function scaledIntToString(value: bigint, scale: number): string {
  if (scale === 0) return value.toString();

  const factor = 10n ** BigInt(scale);
  const whole = value / factor;
  const fraction = (value % factor).toString().padStart(scale, '0').replace(/0+$/, '');
  return fraction ? `${whole.toString()}.${fraction}` : whole.toString();
}

export const binanceFilterService = new BinanceFilterService();
