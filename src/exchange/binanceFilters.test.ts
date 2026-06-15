import { BinanceFilterService, type SymbolFilters } from './binanceFilters';

const btcFilters: SymbolFilters = {
  symbol: 'BTCUSDT',
  priceFilter: { minPrice: '0.10', maxPrice: '1000000', tickSize: '0.10' },
  lotSize: { minQty: '0.001', maxQty: '1000', stepSize: '0.001' },
  marketLotSize: { minQty: '0.001', maxQty: '1000', stepSize: '0.001' },
  minNotional: '100',
};

const lowPriceFilters: SymbolFilters = {
  symbol: 'SOLUSDT',
  priceFilter: { minPrice: '0.0001', maxPrice: '1000', tickSize: '0.0001' },
  lotSize: { minQty: '1', maxQty: '1000000', stepSize: '1' },
  marketLotSize: { minQty: '1', maxQty: '1000000', stepSize: '1' },
  minNotional: '5',
};

describe('BinanceFilterService', () => {
  it('normalizes BTC-like market quantity and prices with symbol filters', async () => {
    const service = new BinanceFilterService(async () => btcFilters);

    const quantity = await service.normalizeMarketOrder('BTCUSDT', 0.123456, 65000);
    const priceFloor = await service.normalizePrice('BTCUSDT', 65000.123, 'floor');
    const priceCeil = await service.normalizePrice('BTCUSDT', 65000.123, 'ceil');

    expect(quantity.quantityText).toBe('0.123');
    expect(quantity.quantity).toBe(0.123);
    expect(priceFloor.priceText).toBe('65000.1');
    expect(priceCeil.priceText).toBe('65000.2');
  });

  it('normalizes low-price altcoin-like filters without fixed BTC decimals', async () => {
    const service = new BinanceFilterService(async () => lowPriceFilters);

    const quantity = await service.normalizeMarketOrder('SOLUSDT', 123.987, 0.125);
    const price = await service.normalizePrice('SOLUSDT', 0.123456, 'ceil');

    expect(quantity.quantityText).toBe('123');
    expect(quantity.quantity).toBe(123);
    expect(price.priceText).toBe('0.1235');
  });

  it('rejects orders below min notional after normalization', async () => {
    const service = new BinanceFilterService(async () => btcFilters);

    await expect(service.normalizeMarketOrder('BTCUSDT', 0.001, 50000))
      .rejects.toThrow(/minNotional/);
  });

  it('rejects quantities that normalize below minQty', async () => {
    const service = new BinanceFilterService(async () => btcFilters);

    await expect(service.normalizeMarketOrder('BTCUSDT', 0.0009, 65000))
      .rejects.toThrow(/below minQty|zero/);
  });
});
