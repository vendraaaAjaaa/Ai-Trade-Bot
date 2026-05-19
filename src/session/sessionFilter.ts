import type { SessionInfo, SessionName } from '../utils/types2';
import { createLogger } from '../utils/logger';

const log = createLogger('session');

// UTC hour ranges for sessions
const SESSIONS: Record<SessionName, { start: number; end: number; quality: number; volumeMult: number }> = {
  london:   { start: 7,  end: 16, quality: 88, volumeMult: 1.4 },
  new_york: { start: 13, end: 22, quality: 90, volumeMult: 1.5 },
  overlap:  { start: 13, end: 16, quality: 95, volumeMult: 1.8 }, // London + NY
  asia:     { start: 0,  end: 7,  quality: 45, volumeMult: 0.7 },
  dead:     { start: 22, end: 24, quality: 20, volumeMult: 0.4 },
};

export class SessionFilter {

  getCurrentSession(): SessionInfo {
    const now = new Date();
    const utcHour = now.getUTCHours();
    return this.getSessionForHour(utcHour);
  }

  getSessionForHour(utcHour: number): SessionInfo {
    // Overlap takes priority
    if (utcHour >= 13 && utcHour < 16) {
      return this.buildSession('overlap', utcHour);
    }
    if (utcHour >= 7 && utcHour < 16) {
      return this.buildSession('london', utcHour);
    }
    if (utcHour >= 13 && utcHour < 22) {
      return this.buildSession('new_york', utcHour);
    }
    if (utcHour >= 0 && utcHour < 7) {
      return this.buildSession('asia', utcHour);
    }
    return this.buildSession('dead', utcHour);
  }

  private buildSession(name: SessionName, utcHour: number): SessionInfo {
    const cfg = SESSIONS[name];
    const isActive = name !== 'dead';
    const isHighQuality = cfg.quality >= 80;
    const tradingAllowed = cfg.quality >= 45;

    // Reduce quality in the last 30 min of session (session close effects)
    let quality = cfg.quality;
    if (name !== 'dead' && name !== 'asia') {
      const minutesLeft = (cfg.end - utcHour) * 60 - new Date().getUTCMinutes();
      if (minutesLeft < 30) quality = Math.max(30, quality - 20);
    }

    const description =
      name === 'overlap' ? 'London + NY overlap — highest liquidity of the day' :
      name === 'london'  ? 'London session — institutional activity, good liquidity' :
      name === 'new_york'? 'New York session — high volume, strong momentum' :
      name === 'asia'    ? 'Asia session — reduced liquidity, choppy conditions' :
                           'Dead zone — avoid trading';

    log.debug({ name, utcHour, quality, tradingAllowed }, 'Session evaluated');

    return {
      name, quality, isActive, isHighQuality, tradingAllowed,
      volumeMultiplier: cfg.volumeMult,
      riskMultiplier: name === 'dead' || name === 'asia' ? 0.5 : 1.0,
      description,
      utcHour,
    };
  }

  isOptimalTime(): boolean {
    const session = this.getCurrentSession();
    return session.quality >= 80;
  }

  getSessionQualityMultiplier(): number {
    const session = this.getCurrentSession();
    return session.quality / 100;
  }
}

export const sessionFilter = new SessionFilter();
