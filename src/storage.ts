import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { z } from "zod";

// Schema definitions
export const SessionStatusSchema = z.enum([
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const MessageRoleSchema = z.enum(["user", "assistant", "system"]);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

export const RiskLevelSchema = z.enum(["low", "medium", "high"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export interface Session {
  id: string;
  command: string;
  projectRoot: string;
  provider: string;
  model: string;
  status: SessionStatus;
  createdAt: string;
  completedAt: string | null;
  error: string | null;
}

export interface Message {
  id: number;
  sessionId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface ToolExecution {
  id: number;
  sessionId: string;
  toolName: string;
  input: string;
  output: string | null;
  error: string | null;
  createdAt: string;
}

export interface Mutation {
  id: number;
  sessionId: string;
  action: string;
  affectedFiles: string;
  riskLevel: RiskLevel;
  reversible: boolean;
  rollbackHints: string | null;
  createdAt: string;
}

// Database connection manager
let dbInstance: Database.Database | null = null;

/**
 * Get or create database connection to ~/.aria/history.db
 * Sets file permissions to 600 (user-only read/write)
 */
export function getDatabase(): Database.Database {
  if (dbInstance) {
    return dbInstance;
  }

  const ariaDir = path.join(os.homedir(), ".aria");
  const dbPath = path.join(ariaDir, "history.db");

  // Ensure ~/.aria directory exists
  if (!fs.existsSync(ariaDir)) {
    fs.mkdirSync(ariaDir, { recursive: true, mode: 0o700 });
  }

  // Create database connection
  dbInstance = new Database(dbPath);

  // Set file permissions to 600 (user-only read/write)
  try {
    fs.chmodSync(dbPath, 0o600);
  } catch (error) {
    console.warn("Warning: Could not set database file permissions:", error);
  }

  // Enable foreign keys
  dbInstance.pragma("foreign_keys = ON");

  return dbInstance;
}

/**
 * Close database connection
 */
export function closeDatabase(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

// Ensure database is closed on process exit.
// Use a flag to prevent double-close from signal handlers calling process.exit
// which then triggers the 'exit' handler again.
let _closing = false;
function safeClose(): void {
  if (_closing) return;
  _closing = true;
  closeDatabase();
}
process.on("exit", safeClose);
process.on("SIGINT", () => { safeClose(); process.exit(130); });
process.on("SIGTERM", () => { safeClose(); process.exit(0); });

// Schema versioning
const CURRENT_SCHEMA_VERSION = 1;

type Migration = {
  version: number;
  up: (db: Database.Database) => void;
};

/**
 * Get current schema version from database
 * Returns 0 if schema_versions table doesn't exist
 */
export function getCurrentSchemaVersion(db: Database.Database): number {
  try {
    const result = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='schema_versions'`
      )
      .get() as { name: string } | undefined;

    if (!result) {
      return 0;
    }

    const versionResult = db
      .prepare(`SELECT MAX(version) as version FROM schema_versions`)
      .get() as { version: number | null };

    return versionResult.version ?? 0;
  } catch (error) {
    return 0;
  }
}

/**
 * Run database migrations sequentially
 */
export function runMigrations(db: Database.Database): void {
  const currentVersion = getCurrentSchemaVersion(db);

  if (currentVersion >= CURRENT_SCHEMA_VERSION) {
    return; // Already up to date
  }

  // Create schema_versions table if it doesn't exist
  if (currentVersion === 0) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_versions (
        version INTEGER PRIMARY KEY,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  // Get all migrations that need to be applied
  const migrationsToRun = migrations.filter(
    (m) => m.version > currentVersion && m.version <= CURRENT_SCHEMA_VERSION
  );

  // Sort by version to ensure sequential execution
  migrationsToRun.sort((a, b) => a.version - b.version);

  // Run each migration in a transaction
  for (const migration of migrationsToRun) {
    const transaction = db.transaction(() => {
      migration.up(db);
      db.prepare(`INSERT INTO schema_versions (version) VALUES (?)`).run(
        migration.version
      );
    });

    try {
      transaction();
    } catch (error) {
      throw new Error(
        `Migration to version ${migration.version} failed: ${error}`
      );
    }
  }
}

/**
 * Initialize database with schema
 */
export function initializeDatabase(): Database.Database {
  const db = getDatabase();
  runMigrations(db);
  return db;
}

// Migrations array
const migrations: Migration[] = [
  {
    version: 1,
    up: (db: Database.Database) => {
      // Create sessions table
      db.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          command TEXT NOT NULL,
          project_root TEXT NOT NULL,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed', 'cancelled')),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          completed_at TIMESTAMP,
          error TEXT
        )
      `);

      // Create indexes on sessions table
      db.exec(`
        CREATE INDEX idx_sessions_created_at ON sessions(created_at);
        CREATE INDEX idx_sessions_status ON sessions(status);
      `);

      // Create messages table
      db.exec(`
        CREATE TABLE messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
          content TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        )
      `);

      // Create index on messages table
      db.exec(`
        CREATE INDEX idx_messages_session_id ON messages(session_id);
      `);

      // Create tool_executions table
      db.exec(`
        CREATE TABLE tool_executions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          input TEXT NOT NULL,
          output TEXT,
          error TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        )
      `);

      // Create index on tool_executions table
      db.exec(`
        CREATE INDEX idx_tool_executions_session_id ON tool_executions(session_id);
      `);

      // Create mutations table
      db.exec(`
        CREATE TABLE mutations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          action TEXT NOT NULL,
          affected_files TEXT NOT NULL,
          risk_level TEXT NOT NULL CHECK(risk_level IN ('low', 'medium', 'high')),
          reversible BOOLEAN NOT NULL,
          rollback_hints TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        )
      `);

      // Create index on mutations table
      db.exec(`
        CREATE INDEX idx_mutations_session_id ON mutations(session_id);
      `);
    },
  },
];

// Session CRUD operations

/**
 * Create a new session
 */
export function createSession(
  db: Database.Database,
  session: {
    id: string;
    command: string;
    projectRoot: string;
    provider: string;
    model: string;
  }
): void {
  const stmt = db.prepare(`
    INSERT INTO sessions (id, command, project_root, provider, model, status)
    VALUES (?, ?, ?, ?, ?, 'running')
  `);

  stmt.run(
    session.id,
    session.command,
    session.projectRoot,
    session.provider,
    session.model
  );
}

/**
 * Update session status
 */
export function updateSessionStatus(
  db: Database.Database,
  sessionId: string,
  status: SessionStatus,
  error?: string
): void {
  const stmt = db.prepare(`
    UPDATE sessions
    SET status = ?,
        completed_at = CURRENT_TIMESTAMP,
        error = ?
    WHERE id = ?
  `);

  stmt.run(status, error ?? null, sessionId);
}

/**
 * Get a single session by ID
 */
export function getSession(
  db: Database.Database,
  sessionId: string
): Session | null {
  const stmt = db.prepare(`
    SELECT id, command, project_root as projectRoot, provider, model,
           status, created_at as createdAt, completed_at as completedAt, error
    FROM sessions
    WHERE id = ?
  `);

  return (stmt.get(sessionId) as Session) ?? null;
}

/**
 * List sessions with pagination
 */
export function listSessions(
  db: Database.Database,
  options: {
    limit?: number;
    offset?: number;
    status?: SessionStatus;
  } = {}
): Session[] {
  const { limit = 50, offset = 0, status } = options;

  let query = `
    SELECT id, command, project_root as projectRoot, provider, model,
           status, created_at as createdAt, completed_at as completedAt, error
    FROM sessions
  `;

  const params: unknown[] = [];

  if (status) {
    query += ` WHERE status = ?`;
    params.push(status);
  }

  query += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const stmt = db.prepare(query);
  return stmt.all(...params) as Session[];
}

// Logging functions

/**
 * Log a message to the database
 */
export function logMessage(
  db: Database.Database,
  sessionId: string,
  role: MessageRole,
  content: string
): void {
  const stmt = db.prepare(`
    INSERT INTO messages (session_id, role, content)
    VALUES (?, ?, ?)
  `);

  stmt.run(sessionId, role, content);
}

/**
 * Log a tool execution to the database
 */
export function logToolExecution(
  db: Database.Database,
  sessionId: string,
  toolName: string,
  input: unknown,
  result: { success: boolean; data?: unknown; error?: string }
): void {
  const stmt = db.prepare(`
    INSERT INTO tool_executions (session_id, tool_name, input, output, error)
    VALUES (?, ?, ?, ?, ?)
  `);

  stmt.run(
    sessionId,
    toolName,
    JSON.stringify(input),
    result.success ? JSON.stringify(result.data) : null,
    result.error ?? null
  );
}

/**
 * Log a mutation to the database
 */
export function logMutation(
  db: Database.Database,
  sessionId: string,
  mutation: {
    action: string;
    affectedFiles: string[];
    riskLevel: RiskLevel;
    reversible: boolean;
    rollbackHints?: string[];
  }
): void {
  const stmt = db.prepare(`
    INSERT INTO mutations (session_id, action, affected_files, risk_level, reversible, rollback_hints)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    sessionId,
    mutation.action,
    JSON.stringify(mutation.affectedFiles),
    mutation.riskLevel,
    mutation.reversible ? 1 : 0,
    mutation.rollbackHints ? JSON.stringify(mutation.rollbackHints) : null
  );
}

// Session cleanup

/**
 * Resolve an existing session by ID or create a new one.
 * Used by all action commands to ensure consistent session handling.
 */
export function resolveOrCreateSession(
  db: Database.Database,
  opts: {
    sessionId?: string;
    command: string;
    projectRoot: string;
    provider: string;
    model: string;
  },
): string {
  if (opts.sessionId) {
    const existing = getSession(db, opts.sessionId);
    if (!existing) {
      throw new Error(`Session not found: ${opts.sessionId}`);
    }
    return existing.id;
  }
  const id = randomUUID();
  createSession(db, {
    id,
    command: opts.command,
    projectRoot: opts.projectRoot,
    provider: opts.provider,
    model: opts.model,
  });
  return id;
}

/**
 * Delete sessions older than retainDays
 * Cascading deletes will remove associated messages, tool_executions, and mutations
 */
export function deleteOldSessions(
  db: Database.Database,
  retainDays: number
): number {
  const stmt = db.prepare(`
    DELETE FROM sessions
    WHERE created_at < datetime('now', '-' || ? || ' days')
  `);

  const result = stmt.run(retainDays);
  return result.changes;
}
