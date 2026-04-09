// JavaScript sample fixture for syntax highlighting tests
'use strict';

const fs = require('fs');
const path = require('path');

const MAX_RETRIES = 3;
const TIMEOUT_MS = 5000;

/**
 * Retry a promise-returning function up to maxRetries times.
 * @param {() => Promise<any>} fn
 * @param {number} maxRetries
 * @returns {Promise<any>}
 */
async function withRetry(fn, maxRetries = MAX_RETRIES) {
  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      /* wait before retrying */
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
  throw lastError;
}

class EventEmitter {
  constructor() {
    this._listeners = new Map();
  }

  on(event, listener) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, []);
    }
    this._listeners.get(event).push(listener);
    return this;
  }

  emit(event, ...args) {
    const listeners = this._listeners.get(event) ?? [];
    for (const listener of listeners) {
      listener(...args);
    }
  }
}

function loadConfig(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw);
}

const config = loadConfig(path.join(process.cwd(), '.config.json'));
const emitter = new EventEmitter();

module.exports = { withRetry, EventEmitter, loadConfig, config, emitter };
