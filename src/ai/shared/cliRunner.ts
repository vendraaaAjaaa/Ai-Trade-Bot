import { spawn } from 'child_process';
import { createLogger } from '../../utils/logger';

const log = createLogger('cli-runner');

export interface CLIRunnerOptions {
  timeoutMs?: number;
  /** Extra env vars to merge (e.g. GEMINI_API_KEY if user happens to have one) */
  extraEnv?: Record<string, string>;
}

export interface CLIResult {
  output: string;
  usedCommand: string;
  fromFallback: boolean;
}

/**
 * Tries every candidate command in order.
 * Pipes the prompt via STDIN — the most reliable cross-version approach
 * for both `codex` and `gemini` CLIs.
 *
 * Returns the first successful response, or falls back to deterministic
 * rule-based text if nothing works.
 */
export async function runCLI(
  candidates: { cmd: string; args: string[] }[],
  prompt: string,
  fallbackFn: (prompt: string) => string,
  opts: CLIRunnerOptions = {},
): Promise<CLIResult> {
  const { timeoutMs = 45_000, extraEnv = {} } = opts;

  for (const { cmd, args } of candidates) {
    const result = await trySpawn(cmd, args, prompt, timeoutMs, extraEnv);
    if (result !== null) {
      return { output: result, usedCommand: cmd, fromFallback: false };
    }
  }

  log.warn({ candidates: candidates.map((c) => c.cmd) }, 'All CLI candidates failed — using deterministic fallback');
  return { output: fallbackFn(prompt), usedCommand: 'fallback', fromFallback: true };
}

function trySpawn(
  cmd: string,
  args: string[],
  stdinData: string,
  timeoutMs: number,
  extraEnv: Record<string, string>,
): Promise<string | null> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let done = false;

    const child = spawn(cmd, args, {
      env: { ...process.env, ...extraEnv },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill('SIGTERM');
      log.debug({ cmd }, 'CLI timed out');
      resolve(null);
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on('error', (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      log.debug({ cmd, err: err.message }, 'CLI spawn error');
      resolve(null);
    });

    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);

      if (code !== 0) {
        log.debug({ cmd, code, stderr: stderr.slice(0, 120) }, 'CLI non-zero exit');
        resolve(null);
        return;
      }

      const trimmed = stdout.trim();
      if (!trimmed || trimmed.length < 10) {
        log.debug({ cmd }, 'CLI returned empty output');
        resolve(null);
        return;
      }

      log.debug({ cmd, chars: trimmed.length }, 'CLI response OK');
      resolve(trimmed);
    });

    // Write prompt to stdin, then close it so the CLI knows input is done
    child.stdin.write(stdinData, 'utf8');
    child.stdin.end();
  });
}

// ---- Structured output parser ----
// Expects the CLI to respond in the format:
//   SCORE: <0-100>
//   JOURNAL: <sentence>
//   RISK: <flag>   (zero or more)

export interface ParsedCLIResponse {
  score: number;
  journal: string;
  risks: string[];
  raw: string;
}

export function parseCLIResponse(raw: string, defaultJournal: string): ParsedCLIResponse {
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  let score = 50;
  let journal = defaultJournal;
  const risks: string[] = [];

  for (const line of lines) {
    const upper = line.toUpperCase();
    if (upper.startsWith('SCORE:')) {
      const n = parseInt(line.slice(6).trim());
      if (!isNaN(n)) score = Math.min(100, Math.max(0, n));
    } else if (upper.startsWith('JOURNAL:')) {
      journal = line.slice(8).trim();
    } else if (upper.startsWith('RISK:')) {
      const risk = line.slice(5).trim();
      if (risk) risks.push(risk);
    }
  }

  return { score, journal, risks, raw };
}
