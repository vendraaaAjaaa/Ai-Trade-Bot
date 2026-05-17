import pino from 'pino';
import { config } from '../config';

const transport =
  config.app.nodeEnv === 'development'
    ? pino.transport({
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      })
    : undefined;

export const logger = pino(
  {
    level: config.app.logLevel,
    base: { service: 'trading-platform' },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  transport,
);

export function createLogger(module: string) {
  return logger.child({ module });
}
