import { spawn } from 'node:child_process';
import { HttpError } from './http.js';

export function runCommand(command, args = [], {
  cwd,
  env,
  timeoutMs = 120_000,
  input,
  signal,
  maxOutputBytes = 16 * 1024 * 1024,
  allowNonZero = false,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    };

    const onAbort = () => {
      child.kill('SIGKILL');
      finishReject(signal.reason instanceof Error ? signal.reason : new Error('Command aborted'));
    };

    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finishReject(new HttpError(504, `${command} timed out.`, { code: 'subprocess_timeout', retryable: true }));
    }, timeoutMs);
    timer.unref?.();

    child.on('error', (error) => {
      finishReject(new HttpError(500, `Unable to start ${command}: ${error.message}`, { code: 'subprocess_start_failed' }));
    });

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) {
        child.kill('SIGKILL');
        finishReject(new HttpError(413, `${command} output exceeded the configured limit.`, { code: 'subprocess_output_too_large' }));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= maxOutputBytes) stderr.push(chunk);
    });

    child.on('close', (code, closeSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      const result = {
        code: code ?? -1,
        signal: closeSignal,
        stdout: Buffer.concat(stdout, stdoutBytes),
        stderr: Buffer.concat(stderr, Math.min(stderrBytes, maxOutputBytes)),
      };
      if (result.code !== 0 && !allowNonZero) {
        const detail = result.stderr.toString('utf8').trim().slice(0, 2000);
        reject(new HttpError(422, `${command} failed${detail ? `: ${detail}` : ''}`, {
          code: 'subprocess_failed',
          retryable: false,
          details: { command, exit_code: result.code },
        }));
      } else {
        resolve(result);
      }
    });

    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}
