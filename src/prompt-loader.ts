/**
 * Shared prompt template loader.
 * Eliminates duplicated __dirname + readFileSync + fallback logic across 6+ action files.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Load a prompt template from src/prompts/{name}.md.
 * Returns the fallback string if the file cannot be read.
 */
export function loadPromptTemplate(name: string, fallback: string): string {
  // Guard against path traversal — name must be a simple identifier
  if (name.includes('/') || name.includes('\\') || name.includes('..') || name.includes('\0')) {
    return fallback;
  }
  const templatePath = join(__dirname, 'prompts', `${name}.md`);
  try {
    return readFileSync(templatePath, 'utf-8');
  } catch {
    return fallback;
  }
}
