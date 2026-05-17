import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config';
import { createLogger } from '../utils/logger';
import { performanceAnalytics } from '../analytics/performanceAnalytics';
import { signalEngine } from '../signals/signalEngine';
import { dryRunExecutor } from '../execution/dryrun/dryRunExecutor';
import type { TradingSignal, Position } from '../utils/types';

const log = createLogger('telegram');

export class TelegramNotifier {
  private bot: TelegramBot | null = null;
  private chatId: string;

  constructor() {
    this.chatId = config.telegram.chatId;

    if (config.telegram.botToken && config.telegram.chatId) {
      try {
        this.bot = new TelegramBot(config.telegram.botToken, { polling: true });
        this.registerCommands();
        log.info('Telegram bot initialized');
      } catch (err) {
        log.warn({ err }, 'Failed to initialize Telegram bot');
      }
    } else {
      log.warn('Telegram bot not configured (BOT_TOKEN or CHAT_ID missing)');
    }
  }

  private registerCommands(): void {
    if (!this.bot) return;

    this.bot.onText(/\/status/, async (msg) => {
      const metrics = await performanceAnalytics.getMetrics(undefined, undefined, undefined, config.trading.mode);
      const wallet = dryRunExecutor.getWallet();
      const text = `📊 *Trading Status*\n\n` +
        `Mode: \`${config.trading.mode.toUpperCase()}\`\n` +
        `Balance: \`$${wallet.balance.toFixed(2)}\`\n` +
        `Equity: \`$${wallet.equity.toFixed(2)}\`\n` +
        `Daily PnL: \`$${wallet.dailyPnl.toFixed(2)}\`\n` +
        `Open Positions: \`${dryRunExecutor.getOpenPositions().length}\`\n\n` +
        `📈 *Performance*\n` +
        `Trades: ${metrics.totalTrades}\n` +
        `Win Rate: ${metrics.winRate.toFixed(1)}%\n` +
        `Total PnL: $${metrics.totalPnl.toFixed(2)}\n` +
        `Profit Factor: ${metrics.profitFactor.toFixed(2)}`;
      await this.sendMessage(text, true);
    });

    this.bot.onText(/\/signals/, async (msg) => {
      const signals = await signalEngine.getAllLatestSignals();
      if (signals.length === 0) {
        await this.sendMessage('No active signals at this time.');
        return;
      }
      for (const s of signals) {
        await this.sendSignalAlert(s);
      }
    });

    this.bot.onText(/\/positions/, async (msg) => {
      const positions = dryRunExecutor.getOpenPositions();
      if (positions.length === 0) {
        await this.sendMessage('No open positions.');
        return;
      }
      for (const p of positions) {
        await this.sendPositionUpdate(p);
      }
    });

    this.bot.onText(/\/help/, async (msg) => {
      const text = `*Available Commands*\n\n` +
        `/status - Platform status & performance\n` +
        `/signals - Latest signals\n` +
        `/positions - Open positions\n` +
        `/help - This message`;
      await this.sendMessage(text, true);
    });

    this.bot.on('polling_error', (err) => log.warn({ err }, 'Telegram polling error'));
  }

  async sendSignalAlert(signal: TradingSignal): Promise<void> {
    const emoji = signal.direction === 'LONG' ? '🟢' : '🔴';
    const strengthEmoji = {
      VERY_STRONG: '💎', STRONG: '⚡', MODERATE: '📊', WEAK: '⚠️',
    }[signal.strength];

    const text = `${emoji} *NEW SIGNAL: ${signal.pair}*\n\n` +
      `Direction: \`${signal.direction}\` ${strengthEmoji}\n` +
      `Confidence: \`${signal.confidence}%\`\n` +
      `Strength: \`${signal.strength}\`\n\n` +
      `📍 Entry: \`${signal.entry.toFixed(2)}\`\n` +
      `🛑 Stop Loss: \`${signal.stopLoss.toFixed(2)}\`\n` +
      `🎯 Take Profit: \`${signal.takeProfit.toFixed(2)}\`\n` +
      `📐 R:R: \`${signal.riskReward.toFixed(2)}:1\`\n\n` +
      `*Reasons:*\n${signal.reasons.slice(0, 4).map((r) => `• ${r}`).join('\n')}\n\n` +
      `${signal.aiValidation ? `*AI Journal:*\n_${signal.aiValidation.journal.substring(0, 200)}_` : ''}`;

    await this.sendMessage(text, true);
  }

  async sendPositionOpened(position: Position): Promise<void> {
    const emoji = position.direction === 'LONG' ? '🟢' : '🔴';
    const text = `${emoji} *POSITION OPENED*\n\n` +
      `Pair: \`${position.pair}\`\n` +
      `Direction: \`${position.direction}\`\n` +
      `Entry: \`${position.entryPrice.toFixed(4)}\`\n` +
      `Size: \`${position.quantity.toFixed(6)}\`\n` +
      `Leverage: \`${position.leverage}x\`\n` +
      `SL: \`${position.stopLoss.toFixed(4)}\`\n` +
      `TP: \`${position.takeProfit.toFixed(4)}\`\n` +
      `Mode: \`${position.mode.toUpperCase()}\``;

    await this.sendMessage(text, true);
  }

  async sendPositionClosed(position: Position, reason: string): Promise<void> {
    const pnl = position.realizedPnl;
    const emoji = pnl > 0 ? '✅' : '❌';
    const text = `${emoji} *POSITION CLOSED - ${reason}*\n\n` +
      `Pair: \`${position.pair}\`\n` +
      `Direction: \`${position.direction}\`\n` +
      `Entry: \`${position.entryPrice.toFixed(4)}\`\n` +
      `Exit: \`${position.currentPrice.toFixed(4)}\`\n` +
      `PnL: \`${pnl > 0 ? '+' : ''}$${pnl.toFixed(4)}\`\n` +
      `ROE: \`${position.roe.toFixed(2)}%\``;

    await this.sendMessage(text, true);
  }

  async sendPositionUpdate(position: Position): Promise<void> {
    const pnlEmoji = position.unrealizedPnl >= 0 ? '📈' : '📉';
    const text = `${pnlEmoji} *${position.pair} ${position.direction}*\n` +
      `Entry: \`${position.entryPrice.toFixed(4)}\` → Current: \`${position.currentPrice.toFixed(4)}\`\n` +
      `PnL: \`${position.unrealizedPnl >= 0 ? '+' : ''}$${position.unrealizedPnl.toFixed(4)}\` ` +
      `(ROE: ${position.roe.toFixed(2)}%)`;
    await this.sendMessage(text, true);
  }

  async sendRiskWarning(message: string): Promise<void> {
    await this.sendMessage(`⚠️ *RISK WARNING*\n\n${message}`, true);
  }

  async sendDailyReport(): Promise<void> {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const metrics = await performanceAnalytics.getMetrics(
        undefined, today.getTime(), Date.now(), config.trading.mode,
      );
      const wallet = dryRunExecutor.getWallet();

      const text = `📅 *Daily Report - ${today.toLocaleDateString()}*\n\n` +
        `Balance: \`$${wallet.balance.toFixed(2)}\`\n` +
        `Daily PnL: \`$${wallet.dailyPnl >= 0 ? '+' : ''}${wallet.dailyPnl.toFixed(2)}\`\n\n` +
        `Trades Today: ${metrics.totalTrades}\n` +
        `Wins: ${metrics.winningTrades} | Losses: ${metrics.losingTrades}\n` +
        `Win Rate: ${metrics.winRate.toFixed(1)}%\n` +
        `Profit Factor: ${metrics.profitFactor.toFixed(2)}\n` +
        `Max Drawdown: $${metrics.maxDrawdown.toFixed(2)}`;

      await this.sendMessage(text, true);
    } catch (err) {
      log.warn({ err }, 'Failed to send daily report');
    }
  }

  async sendMessage(text: string, parseMarkdown = false): Promise<void> {
    if (!this.bot || !this.chatId) return;
    try {
      await this.bot.sendMessage(this.chatId, text, {
        parse_mode: parseMarkdown ? 'Markdown' : undefined,
        disable_web_page_preview: true,
      });
    } catch (err) {
      log.warn({ err }, 'Failed to send Telegram message');
    }
  }

  stop(): void {
    this.bot?.stopPolling();
  }
}

export const telegramNotifier = new TelegramNotifier();
