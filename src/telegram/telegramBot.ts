import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config';
import { createLogger } from '../utils/logger';
import { performanceAnalytics } from '../analytics/performanceAnalytics';
import { signalEngine } from '../signals/signalEngine';
import { dryRunExecutor } from '../execution/dryrun/dryRunExecutor';
import { marketRegimeEngine } from '../regime/marketRegimeEngine';
import { sessionFilter } from '../session/sessionFilter';
import { frequencyLimiter } from '../strategy/frequencyLimiter';
import { strategyManager } from '../strategy/strategyModes';
import type { TradingSignal, Position } from '../utils/types';
import type { RegimeAnalysis, NoTradeDecision, LossStreakState } from '../utils/types2';
import type { EnrichedSignal } from '../signals/signalEngine';

const log = createLogger('telegram-v2');

export class TelegramNotifier {
  private bot: TelegramBot | null = null;
  private chatId: string;
  private noTradeCount = 0;
  private lastNoTradeAlert = 0;

  constructor() {
    this.chatId = config.telegram.chatId;
    if (config.telegram.botToken && config.telegram.chatId) {
      try {
        this.bot = new TelegramBot(config.telegram.botToken, { polling: true, request: { family: 4 } as any });
        this.registerCommands();
        log.info('Telegram bot v2 initialized');
      } catch (err) {
        log.warn({ err }, 'Failed to initialize Telegram bot');
      }
    }
  }

  private registerCommands(): void {
    if (!this.bot) return;

    this.bot.onText(/\/status/, async () => {
      const metrics = await performanceAnalytics.getMetrics(undefined, undefined, undefined, config.trading.mode);
      const wallet = dryRunExecutor.getWallet();
      const session = sessionFilter.getCurrentSession();
      const streak = await frequencyLimiter.getLossStreakState();
      const freq = await frequencyLimiter.getFrequencyState(strategyManager.getMode());
      const sysStatus = await frequencyLimiter.getSystemStatus();

      const statusEmoji = sysStatus === 'trading' ? '🟢' : sysStatus === 'cooldown' ? '🔴' : '🟡';
      await this.sendMessage(
        `${statusEmoji} *Platform Status*\n\n` +
        `Mode: \`${strategyManager.getMode().toUpperCase()}\`\n` +
        `System: \`${sysStatus.toUpperCase()}\`\n` +
        `Session: \`${session.name} (${session.quality}/100)\`\n\n` +
        `💰 *Wallet*\n` +
        `Balance: \`$${wallet.balance.toFixed(2)}\`\n` +
        `Equity: \`$${wallet.equity.toFixed(2)}\`\n` +
        `Daily PnL: \`${wallet.dailyPnl >= 0 ? '+' : ''}$${wallet.dailyPnl.toFixed(2)}\`\n` +
        `Open: \`${dryRunExecutor.getOpenPositions().length}\`\n\n` +
        `🎯 *Today*\n` +
        `Trades: ${freq.tradesToday}/${freq.maxTradesDay}\n` +
        `Loss streak: ${streak.consecutiveLosses}\n` +
        `In cooldown: ${streak.inCooldown ? '⛔ YES' : '✅ NO'}\n\n` +
        `📊 *Performance*\n` +
        `Win Rate: ${metrics.winRate.toFixed(1)}%\n` +
        `Profit Factor: ${metrics.profitFactor.toFixed(2)}\n` +
        `Total PnL: $${metrics.totalPnl.toFixed(2)}`, true);
    });

    this.bot.onText(/\/regime/, async () => {
      const lines: string[] = ['📊 *Market Regimes*\n'];
      for (const pair of config.trading.pairs) {
        const regime = await marketRegimeEngine.getCached(pair as any);
        if (regime) {
          const emoji = regime.tradingAllowed ? '✅' : '⛔';
          lines.push(`${emoji} *${pair}*: \`${regime.regime}\` (${regime.confidence}%)`);
          lines.push(`   _${regime.description.slice(0, 80)}_\n`);
        }
      }
      await this.sendMessage(lines.join('\n'), true);
    });

    this.bot.onText(/\/mode (.+)/, async (msg, match) => {
      const mode = match?.[1]?.toLowerCase() as any;
      const valid = ['scalping', 'swing', 'investing', 'safe', 'aggressive'];
      if (!valid.includes(mode)) {
        await this.sendMessage(`❌ Invalid mode. Use: ${valid.join(', ')}`);
        return;
      }
      await strategyManager.setMode(mode);
      const cfg = strategyManager.getConfig();
      await this.sendMessage(
        `✅ *Mode changed to ${mode.toUpperCase()}*\n\n` +
        `Max trades/day: ${cfg.maxTradesPerDay}\n` +
        `Min confidence: ${cfg.minConfidence}%\n` +
        `Min RR: ${cfg.minRR}:1\n` +
        `_${cfg.description}_`, true);
    });

    this.bot.onText(/\/signals/, async () => {
      const signals = await signalEngine.getAllLatestSignals();
      if (!signals.length) {
        await this.sendMessage('📭 No active signals. System is being selective.');
        return;
      }
      for (const s of signals) await this.sendSignalAlert(s);
    });

    this.bot.onText(/\/help/, async () => {
      await this.sendMessage(
        `*Commands*\n\n` +
        `/status — Full platform status\n` +
        `/regime — Current market regimes\n` +
        `/signals — Active signals\n` +
        `/mode <name> — Change strategy mode\n` +
        `   scalping, swing, investing, safe, aggressive\n` +
        `/help — This message`, true);
    });

    this.bot.on('polling_error', (err) => log.warn({ err }, 'Telegram polling error'));
  }

  async sendSignalAlert(signal: EnrichedSignal): Promise<void> {
    const isLong = signal.direction === 'LONG';
    const emoji = isLong ? '🟢' : '🔴';
    const strengthEmoji = { VERY_STRONG: '💎', STRONG: '⚡', MODERATE: '📊', WEAK: '⚠️' }[signal.strength];
    const consensus = signal.consensusResult;

    await this.sendMessage(
      `${emoji} *APPROVED SIGNAL: ${signal.pair}*\n\n` +
      `Direction: \`${signal.direction}\` ${strengthEmoji}\n` +
      `Mode: \`${strategyManager.getMode().toUpperCase()}\`\n` +
      `Confidence: \`${signal.confidence}%\`\n` +
      `Consensus: \`${consensus?.consensusScore ?? '—'}/100\` (${consensus?.buyVotes ?? 0}B/${consensus?.sellVotes ?? 0}S/${consensus?.waitVotes ?? 0}W)\n` +
      `Quality: \`${signal.qualityScore ?? '—'}/100\` (${signal.qualityGrade ?? '—'})\n` +
      `Regime: \`${signal.regimeDescription?.slice(0, 50) ?? '—'}\`\n` +
      `Session: \`${signal.sessionName ?? '—'}\`\n` +
      `MTF Aligned: \`${signal.mtfAligned ? 'YES' : 'NO'}\`\n\n` +
      `📍 Entry: \`${signal.entry.toFixed(2)}\`\n` +
      `🛑 SL: \`${signal.stopLoss.toFixed(2)}\`\n` +
      `🎯 TP: \`${signal.takeProfit.toFixed(2)}\`\n` +
      `📐 RR: \`${signal.riskReward.toFixed(2)}:1\`\n\n` +
      `*Reasons:*\n${signal.reasons.slice(0, 4).map((r) => `• ${r}`).join('\n')}\n\n` +
      `_${signal.aiValidation?.journal?.slice(0, 200) ?? ''}_`, true);
  }

  async sendNoTradeAlert(pair: string, decision: NoTradeDecision): Promise<void> {
    this.noTradeCount++;
    // Throttle no-trade alerts to once per 10 minutes
    if (Date.now() - this.lastNoTradeAlert < 10 * 60 * 1000) return;
    this.lastNoTradeAlert = Date.now();

    await this.sendMessage(
      `🤚 *NO TRADE — ${pair}*\n\n` +
      `Reason: _${decision.primaryReason}_\n` +
      `Category: \`${decision.category.toUpperCase()}\`\n` +
      `Resume when: ${decision.resumeCondition}\n\n` +
      `_"The best trade is often the trade you do NOT take."_`, true);
  }

  async sendRegimeAlert(pair: string, regime: RegimeAnalysis): Promise<void> {
    const emoji = regime.tradingAllowed ? '✅' : '⛔';
    await this.sendMessage(
      `${emoji} *REGIME CHANGE: ${pair}*\n\n` +
      `Regime: \`${regime.regime.replace(/_/g, ' ').toUpperCase()}\`\n` +
      `Confidence: \`${regime.confidence}%\`\n` +
      `Trading: \`${regime.tradingAllowed ? 'ALLOWED' : 'BLOCKED'}\`\n` +
      `_${regime.description}_`, true);
  }

  async sendCooldownAlert(streak: LossStreakState): Promise<void> {
    const minutesLeft = Math.ceil((streak.cooldownUntil - Date.now()) / 60000);
    await this.sendMessage(
      `🔴 *LOSS STREAK COOLDOWN ACTIVATED*\n\n` +
      `Consecutive losses: \`${streak.consecutiveLosses}\`\n` +
      `Cooldown: \`${minutesLeft} minutes\`\n` +
      `Reason: ${streak.cooldownReason}\n\n` +
      `_System entering observation mode. No new trades until conditions improve._`, true);
  }

  async sendPositionOpened(position: Position): Promise<void> {
    const emoji = position.direction === 'LONG' ? '🟢' : '🔴';
    await this.sendMessage(
      `${emoji} *POSITION OPENED*\n\n` +
      `${position.pair} ${position.direction} | ${position.leverage}x\n` +
      `Entry: \`${position.entryPrice.toFixed(4)}\`\n` +
      `Size: \`${position.quantity.toFixed(6)}\`\n` +
      `SL: \`${position.stopLoss.toFixed(4)}\` | TP: \`${position.takeProfit.toFixed(4)}\`\n` +
      `Mode: \`${position.mode.toUpperCase()}\``, true);
  }

  async sendPositionClosed(position: Position, reason: string): Promise<void> {
    const pnl = position.realizedPnl;
    const emoji = pnl > 0 ? '✅' : reason === 'LIQUIDATED' ? '💀' : '❌';
    await this.sendMessage(
      `${emoji} *POSITION CLOSED — ${reason}*\n\n` +
      `${position.pair} ${position.direction}\n` +
      `Entry: \`${position.entryPrice.toFixed(4)}\` → Exit: \`${position.currentPrice.toFixed(4)}\`\n` +
      `PnL: \`${pnl >= 0 ? '+' : ''}$${pnl.toFixed(4)}\`\n` +
      `ROE: \`${position.roe.toFixed(2)}%\``, true);
  }

  async sendDailyReport(): Promise<void> {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const metrics = await performanceAnalytics.getMetrics(undefined, today.getTime(), Date.now(), config.trading.mode);
    const wallet = dryRunExecutor.getWallet();
    const freq = await frequencyLimiter.getFrequencyState(strategyManager.getMode());

    await this.sendMessage(
      `📅 *DAILY REPORT — ${today.toLocaleDateString()}*\n\n` +
      `💰 Balance: \`$${wallet.balance.toFixed(2)}\`\n` +
      `📈 Daily PnL: \`${wallet.dailyPnl >= 0 ? '+' : ''}$${wallet.dailyPnl.toFixed(2)}\`\n\n` +
      `📊 *Today's Performance*\n` +
      `Trades: ${freq.tradesToday}/${freq.maxTradesDay}\n` +
      `Wins/Losses: ${metrics.winningTrades}/${metrics.losingTrades}\n` +
      `Win Rate: ${metrics.winRate.toFixed(1)}%\n` +
      `Profit Factor: ${metrics.profitFactor.toFixed(2)}\n` +
      `Max Drawdown: $${metrics.maxDrawdown.toFixed(2)}\n\n` +
      `_Quality over quantity. Discipline is the edge._`, true);
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

  stop(): void { this.bot?.stopPolling(); }
}

export const telegramNotifier = new TelegramNotifier();
