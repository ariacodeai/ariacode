/**
 * Shared filesystem helpers — atomic writes, safe JSON parsing.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';

/**
 * Atomically write a file by writing to a temp file first, then renaming.
 * - Uses fsync to ensure data is flushed to disk before rename.
 * - Preserves original file permissions (important for 0600 config files).
 * - Temp file is named with the target basename for easy orphan attribution.
 */
export function writeFileAtomic(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmpPath = path.join(dir, `.${base}.tmp-${randomUUID().slice(0, 8)}`);

  // Capture original permissions before writing (if file exists).
  // Mask off file-type bits (S_IFMT) — we only want the permission bits.
  let originalMode: number | null = null;
  try {
    originalMode = fs.statSync(filePath).mode & 0o7777;
  } catch {
    // File doesn't exist yet — no permissions to preserve
  }

  // For new files, default to 0o644. Callers that need stricter permissions
  // (e.g. 0o600 for config.toml) should chmod after writeFileAtomic returns,
  // or the file should already exist with the desired mode.
  const mode = originalMode ?? 0o644;

  try {
    // Write to temp file
    const fd = fs.openSync(tmpPath, 'w', mode);
    try {
      fs.writeSync(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    // Ensure permissions match regardless of umask
    fs.chmodSync(tmpPath, mode);

    // Atomic rename
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    // Clean up temp file on failure
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup errors
    }
    throw err;
  }
}

/**
 * Safely read and parse a JSON file. Throws a descriptive error on failure.
 */
export function readJsonFile(filePath: string): unknown {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    throw new Error(
      `Cannot read ${path.basename(filePath)}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Invalid JSON in ${path.basename(filePath)}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Detect the user's shell rc file based on $SHELL.
 * macOS bash uses .bash_profile (not .bashrc). Linux bash uses .bashrc.
 */
export function getShellRcPath(): string {
  const shell = process.env['SHELL'] ?? '';
  if (shell.endsWith('/zsh')) return path.join(os.homedir(), '.zshrc');
  if (shell.endsWith('/bash')) {
    // macOS bash sources .bash_profile, not .bashrc
    return path.join(os.homedir(), process.platform === 'darwin' ? '.bash_profile' : '.bashrc');
  }
  if (shell.endsWith('/fish')) return path.join(os.homedir(), '.config', 'fish', 'config.fish');
  // Default: zsh on macOS, bash on Linux
  return path.join(os.homedir(), process.platform === 'darwin' ? '.zshrc' : '.bashrc');
}
