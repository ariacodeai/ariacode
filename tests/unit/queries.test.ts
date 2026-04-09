import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runMigrations, createSession, logMessage, logToolExecution } from '../../src/storage.js';
import {
  parseSinceExpression,
  searchSessions,
  filterSessions,
  exportSessionMarkdown,
} from '../../src/storage/queries.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createInMemoryDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function seedSession(
  db: Database.Database,
  overrides: Partial<{
    id: string;
    command: string;
    projectRoot: string;
    provider: string;
    model: string;
    status: 'running' | 'completed' | 'failed' | 'cancelled';
    createdAt: string;
  }> = {},
): string {
  const id = overrides.id ?? randomUUID();
  createSession(db, {
    id,
    command: overrides.command ?? 'ask',
    projectRoot: overrides.projectRoot ?? '/home/user/project',
    provider: overrides.provider ?? 'anthropic',
    model: overrides.model ?? 'claude-3-5-sonnet',
  });
  if (overrides.status && overrides.status !== 'running') {
    db.prepare(`UPDATE sessions SET status = ? WHERE id = ?`).run(overrides.status, id);
  }
  if (overrides.createdAt) {
    db.prepare(`UPDATE sessions SET created_at = ? WHERE id = ?`).run(overrides.createdAt, id);
  }
  return id;
}

// ─── parseSinceExpression — happy paths ──────────────────────────────────────

describe('parseSinceExpression — happy paths', () => {
  it('parses "3 days ago"', () => {
    const before = Date.now();
    const result = parseSinceExpression('3 days ago');
    const after = Date.now();
    const expected = before - 3 * 86400 * 1000;
    expect(result.getTime()).toBeGreaterThanOrEqual(expected - 100);
    expect(result.getTime()).toBeLessThanOrEqual(after);
  });

  it('parses "2 hours ago"', () => {
    const before = Date.now();
    const result = parseSinceExpression('2 hours ago');
    const expected = before - 2 * 3600 * 1000;
    expect(result.getTime()).toBeGreaterThanOrEqual(expected - 100);
    expect(result.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('parses "30 minutes ago"', () => {
    const before = Date.now();
    const result = parseSinceExpression('30 minutes ago');
    const expected = before - 30 * 60 * 1000;
    expect(result.getTime()).toBeGreaterThanOrEqual(expected - 100);
    expect(result.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('parses ISO date-only "2024-01-15"', () => {
    const result = parseSinceExpression('2024-01-15');
    expect(result.toISOString()).toBe('2024-01-15T00:00:00.000Z');
  });

  it('parses ISO datetime with Z "2024-01-15T10:00:00Z"', () => {
    const result = parseSinceExpression('2024-01-15T10:00:00Z');
    expect(result.toISOString()).toBe('2024-01-15T10:00:00.000Z');
  });

  it('parses ISO datetime without timezone "2024-01-15T10:00:00" (treats as UTC)', () => {
    const result = parseSinceExpression('2024-01-15T10:00:00');
    expect(result.toISOString()).toBe('2024-01-15T10:00:00.000Z');
  });

  it('accepts singular "day"', () => {
    const result = parseSinceExpression('1 day ago');
    expect(result).toBeInstanceOf(Date);
  });

  it('accepts singular "hour"', () => {
    const result = parseSinceExpression('1 hour ago');
    expect(result).toBeInstanceOf(Date);
  });

  it('accepts singular "minute"', () => {
    const result = parseSinceExpression('1 minute ago');
    expect(result).toBeInstanceOf(Date);
  });
});

// ─── parseSinceExpression — error cases ──────────────────────────────────────

describe('parseSinceExpression — error cases', () => {
  const shouldThrow = (expr: string) => {
    expect(() => parseSinceExpression(expr)).toThrow(/Supported formats/);
  };

  it('rejects "0 days ago"', () => shouldThrow('0 days ago'));
  it('rejects "-3 days ago"', () => shouldThrow('-3 days ago'));
  it('rejects "1.5 hours ago"', () => shouldThrow('1.5 hours ago'));
  it('rejects "yesterday"', () => shouldThrow('yesterday'));
  it('rejects "last week"', () => shouldThrow('last week'));
  it('rejects empty string', () => shouldThrow(''));
  it('rejects "now"', () => shouldThrow('now'));
  it('rejects "2024/01/15"', () => shouldThrow('2024/01/15'));
});

// ─── Property 13: Date parser rejects unsupported formats ────────────────────

describe('Property 13: date parser rejects unsupported formats', () => {
  // Feature: aria-code-v023, Property 13: date parser rejects unsupported formats
  it('throws with "Supported formats" for arbitrary non-matching strings', () => {
    // Strings that are clearly not in the supported grammar
    const invalidArb = fc.oneof(
      fc.constantFrom('yesterday', 'last week', 'now', 'tomorrow', 'next month'),
      fc.stringMatching(/^[a-zA-Z ]{3,20}$/), // random words
      fc.integer({ min: -999, max: 0 }).map((n) => `${n} days ago`), // zero/negative
      fc.float({ min: Math.fround(0.1), max: Math.fround(99.9), noNaN: true, noDefaultInfinity: true })
        .filter((n) => !Number.isInteger(n))
        .map((n) => `${n} hours ago`), // fractional
    );

    fc.assert(
      fc.property(invalidArb, (expr) => {
        let threw = false;
        let message = '';
        try {
          parseSinceExpression(expr);
        } catch (e) {
          threw = true;
          message = (e as Error).message;
        }
        return threw && message.includes('Supported formats');
      }),
      { numRuns: 100 },
    );
  });
});

// ─── searchSessions ───────────────────────────────────────────────────────────

describe('searchSessions', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createInMemoryDb();
  });

  afterEach(() => {
    db.close();
  });

  it('returns empty array for empty query', () => {
    seedSession(db);
    expect(searchSessions(db, '')).toEqual([]);
  });

  it('finds session by command', () => {
    const id = seedSession(db, { command: 'patch' });
    seedSession(db, { command: 'ask' });
    const results = searchSessions(db, 'patch');
    expect(results.some((r) => r.session.id === id)).toBe(true);
  });

  it('finds session by project_root', () => {
    const id = seedSession(db, { projectRoot: '/home/user/my-special-project' });
    const results = searchSessions(db, 'my-special-project');
    expect(results.some((r) => r.session.id === id)).toBe(true);
  });

  it('finds session by message content', () => {
    const id = seedSession(db);
    logMessage(db, id, 'user', 'please refactor the authentication module');
    const results = searchSessions(db, 'authentication');
    const match = results.find((r) => r.session.id === id);
    expect(match).toBeDefined();
    expect(match!.matchedInMessages).toBe(true);
  });

  it('is case-insensitive', () => {
    const id = seedSession(db, { command: 'PATCH' });
    const results = searchSessions(db, 'patch');
    expect(results.some((r) => r.session.id === id)).toBe(true);
  });

  it('message matches ranked above metadata-only matches', () => {
    const metaId = seedSession(db, { command: 'refactor' });
    const msgId = seedSession(db, { command: 'ask' });
    logMessage(db, msgId, 'user', 'refactor the login flow');
    const results = searchSessions(db, 'refactor');
    const msgIdx = results.findIndex((r) => r.session.id === msgId);
    const metaIdx = results.findIndex((r) => r.session.id === metaId);
    expect(msgIdx).toBeLessThan(metaIdx);
  });

  it('respects limit option', () => {
    for (let i = 0; i < 10; i++) seedSession(db, { command: 'ask' });
    const results = searchSessions(db, 'ask', { limit: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
  });
});

// ─── Property 5: Search returns no false positives ───────────────────────────

describe('Property 5: search returns no false positives', () => {
  // Feature: aria-code-v023, Property 5: search returns no false positives
  it('every returned session contains the query in command, project_root, or a message', () => {
    const db = createInMemoryDb();

    // Seed a variety of sessions
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = seedSession(db, { command: `cmd-${i}`, projectRoot: `/proj/${i}` });
      logMessage(db, id, 'user', `message content for session ${i}`);
      ids.push(id);
    }

    fc.assert(
      fc.property(fc.constantFrom('cmd-1', 'proj/2', 'content for session 3', 'cmd'), (query) => {
        const results = searchSessions(db, query);
        return results.every((r) => {
          const q = query.toLowerCase();
          const inCommand = r.session.command.toLowerCase().includes(q);
          const inProject = r.session.projectRoot.toLowerCase().includes(q);
          if (inCommand || inProject) return true;
          // Check messages
          const msgs = db
            .prepare(`SELECT content FROM messages WHERE session_id = ?`)
            .all(r.session.id) as { content: string }[];
          return msgs.some((m) => m.content.toLowerCase().includes(q));
        });
      }),
      { numRuns: 100 },
    );

    db.close();
  });
});

// ─── filterSessions ───────────────────────────────────────────────────────────

describe('filterSessions', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createInMemoryDb();
  });

  afterEach(() => {
    db.close();
  });

  it('returns all sessions when no filters', () => {
    seedSession(db);
    seedSession(db);
    const results = filterSessions(db, {});
    expect(results.length).toBe(2);
  });

  it('filters by command', () => {
    seedSession(db, { command: 'patch' });
    seedSession(db, { command: 'ask' });
    const results = filterSessions(db, { command: 'patch' });
    expect(results.every((s) => s.command === 'patch')).toBe(true);
  });

  it('filters by status', () => {
    const id = seedSession(db, { status: 'completed' });
    seedSession(db, { status: 'failed' });
    const results = filterSessions(db, { status: 'completed' });
    expect(results.every((s) => s.status === 'completed')).toBe(true);
    expect(results.some((s) => s.id === id)).toBe(true);
  });

  it('filters by since', () => {
    // Old session
    const oldId = seedSession(db);
    db.prepare(`UPDATE sessions SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`).run(oldId);
    // Recent session
    const newId = seedSession(db);
    const results = filterSessions(db, { since: '1 day ago' });
    expect(results.some((s) => s.id === newId)).toBe(true);
    expect(results.some((s) => s.id === oldId)).toBe(false);
  });

  it('applies multiple filters conjunctively', () => {
    seedSession(db, { command: 'patch', status: 'completed' });
    seedSession(db, { command: 'patch', status: 'failed' });
    seedSession(db, { command: 'ask', status: 'completed' });
    const results = filterSessions(db, { command: 'patch', status: 'completed' });
    expect(results.every((s) => s.command === 'patch' && s.status === 'completed')).toBe(true);
    expect(results.length).toBe(1);
  });

  it('respects limit', () => {
    for (let i = 0; i < 10; i++) seedSession(db);
    const results = filterSessions(db, { limit: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
  });
});

// ─── Property 6a: Filter results satisfy predicates ──────────────────────────

describe('Property 6a: filter results satisfy predicates', () => {
  // Feature: aria-code-v023, Property 6a: filter results satisfy predicates
  it('every returned session satisfies all specified filter predicates', () => {
    const db = createInMemoryDb();

    const commands = ['ask', 'patch', 'plan', 'review'];
    const statuses = ['running', 'completed', 'failed', 'cancelled'] as const;

    // Seed a variety of sessions
    for (const cmd of commands) {
      for (const status of statuses) {
        seedSession(db, { command: cmd, status });
      }
    }

    const commandArb = fc.constantFrom(...commands);
    const statusArb = fc.constantFrom(...statuses);

    fc.assert(
      fc.property(
        fc.record({
          command: fc.option(commandArb, { nil: undefined }),
          status: fc.option(statusArb, { nil: undefined }),
        }),
        (filters) => {
          const results = filterSessions(db, filters);
          return results.every((s) => {
            if (filters.command && s.command !== filters.command) return false;
            if (filters.status && s.status !== filters.status) return false;
            return true;
          });
        },
      ),
      { numRuns: 100 },
    );

    db.close();
  });
});

// ─── Property 6b: Filter results respect limit ───────────────────────────────

describe('Property 6b: filter results respect limit', () => {
  // Feature: aria-code-v023, Property 6b: filter results respect limit
  it('result count is always <= limit', () => {
    const db = createInMemoryDb();
    for (let i = 0; i < 20; i++) seedSession(db);

    fc.assert(
      fc.property(fc.integer({ min: 1, max: 30 }), (limit) => {
        const results = filterSessions(db, { limit });
        return results.length <= limit;
      }),
      { numRuns: 100 },
    );

    db.close();
  });
});

// ─── exportSessionMarkdown ────────────────────────────────────────────────────

describe('exportSessionMarkdown', () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    db = createInMemoryDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-queries-test-'));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('throws Session not found for unknown id', () => {
    expect(() => exportSessionMarkdown(db, 'nonexistent-id', path.join(tmpDir, 'out.md'))).toThrow(
      'Session not found: nonexistent-id',
    );
  });

  it('creates the output file', () => {
    const id = seedSession(db);
    const outPath = path.join(tmpDir, 'session.md');
    exportSessionMarkdown(db, id, outPath);
    expect(fs.existsSync(outPath)).toBe(true);
  });

  it('creates parent directories recursively', () => {
    const id = seedSession(db);
    const outPath = path.join(tmpDir, 'deep', 'nested', 'session.md');
    exportSessionMarkdown(db, id, outPath);
    expect(fs.existsSync(outPath)).toBe(true);
  });

  it('contains session ID in output', () => {
    const id = seedSession(db);
    const outPath = path.join(tmpDir, 'session.md');
    exportSessionMarkdown(db, id, outPath);
    const content = fs.readFileSync(outPath, 'utf8');
    expect(content).toContain(id);
  });

  it('contains required metadata fields', () => {
    const id = seedSession(db, {
      command: 'patch',
      projectRoot: '/home/user/myapp',
      provider: 'anthropic',
      model: 'claude-3-5-sonnet',
      status: 'completed',
    });
    const outPath = path.join(tmpDir, 'session.md');
    exportSessionMarkdown(db, id, outPath);
    const content = fs.readFileSync(outPath, 'utf8');
    expect(content).toContain('patch');
    expect(content).toContain('/home/user/myapp');
    expect(content).toContain('anthropic');
    expect(content).toContain('claude-3-5-sonnet');
    expect(content).toContain('completed');
  });

  it('contains message transcript', () => {
    const id = seedSession(db);
    logMessage(db, id, 'user', 'Hello, please help me refactor this');
    logMessage(db, id, 'assistant', 'Sure, here is my plan');
    const outPath = path.join(tmpDir, 'session.md');
    exportSessionMarkdown(db, id, outPath);
    const content = fs.readFileSync(outPath, 'utf8');
    expect(content).toContain('Hello, please help me refactor this');
    expect(content).toContain('Sure, here is my plan');
    expect(content).toContain('[user]');
    expect(content).toContain('[assistant]');
  });

  it('contains tool executions table', () => {
    const id = seedSession(db);
    logToolExecution(db, id, 'read_file', { path: 'src/index.ts' }, { success: true, data: 'file content' });
    const outPath = path.join(tmpDir, 'session.md');
    exportSessionMarkdown(db, id, outPath);
    const content = fs.readFileSync(outPath, 'utf8');
    expect(content).toContain('read_file');
    expect(content).toContain('Tool Executions');
  });
});

// ─── Property 7: Exported markdown contains session ID verbatim ──────────────

describe('Property 7: exported markdown contains session ID verbatim', () => {
  // Feature: aria-code-v023, Property 7: exported markdown contains session ID verbatim
  it('session ID always appears verbatim in exported markdown', () => {
    const db = createInMemoryDb();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-prop7-'));

    try {
      fc.assert(
        fc.property(fc.uuid(), (sessionId) => {
          // Seed a session with this specific ID
          createSession(db, {
            id: sessionId,
            command: 'ask',
            projectRoot: '/proj',
            provider: 'anthropic',
            model: 'claude-3-5-sonnet',
          });

          const outPath = path.join(tmpDir, `${sessionId}.md`);
          exportSessionMarkdown(db, sessionId, outPath);
          const content = fs.readFileSync(outPath, 'utf8');
          return content.includes(sessionId);
        }),
        { numRuns: 100 },
      );
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── Property 8: Exported markdown contains all required fields ──────────────

describe('Property 8: exported markdown contains all required fields', () => {
  // Feature: aria-code-v023, Property 8: exported markdown contains all required fields
  it('markdown always contains command, status, project root, provider, model, and message content', () => {
    const db = createInMemoryDb();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-prop8-'));

    const commands = ['ask', 'patch', 'plan'];
    const statuses = ['completed', 'failed'] as const;
    const providers = ['anthropic', 'openai'];
    const models = ['claude-3-5-sonnet', 'gpt-4o'];

    try {
      fc.assert(
        fc.property(
          fc.record({
            command: fc.constantFrom(...commands),
            status: fc.constantFrom(...statuses),
            provider: fc.constantFrom(...providers),
            model: fc.constantFrom(...models),
            projectRoot: fc.constantFrom('/proj/alpha', '/proj/beta', '/proj/gamma'),
            messageContent: fc.string({ minLength: 5, maxLength: 50 }),
            role: fc.constantFrom('user', 'assistant') as fc.Arbitrary<'user' | 'assistant'>,
          }),
          ({ command, status, provider, model, projectRoot, messageContent, role }) => {
            const id = randomUUID();
            createSession(db, { id, command, projectRoot, provider, model });
            db.prepare(`UPDATE sessions SET status = ? WHERE id = ?`).run(status, id);
            logMessage(db, id, role, messageContent);

            const outPath = path.join(tmpDir, `${id}.md`);
            exportSessionMarkdown(db, id, outPath);
            const content = fs.readFileSync(outPath, 'utf8');

            return (
              content.includes(command) &&
              content.includes(status) &&
              content.includes(projectRoot) &&
              content.includes(provider) &&
              content.includes(model) &&
              content.includes(messageContent) &&
              content.includes(role)
            );
          },
        ),
        { numRuns: 100 },
      );
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
