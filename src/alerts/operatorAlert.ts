import { createLogger } from '../utils/logger';
import { telegramNotifier } from '../telegram/telegramBot';
import type { TradeDirection, TradingPair } from '../utils/types';

const log = createLogger('operator-alert');

export interface EmergencyCloseFailureAlert {
  pair: TradingPair;
  direction: TradeDirection;
  quantity: number;
  exchangeOrderId?: string;
  timestamp: number;
  lastErrorMessage?: string;
}

export interface OperatorAlertService {
  sendEmergencyCloseFailed(event: EmergencyCloseFailureAlert): Promise<void>;
}

export const operatorAlertService: OperatorAlertService = {
  async sendEmergencyCloseFailed(event: EmergencyCloseFailureAlert): Promise<void> {
    try {
      await telegramNotifier.sendEmergencyCloseFailed(event);
    } catch (err) {
      log.error({ err, event }, 'Failed to send emergency-close operator alert');
      throw err;
    }
  },
};
