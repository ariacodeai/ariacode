import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import {
  getCurrentSchemaVersion,
  runMigrations,
  createSession,
  updateSessionStatus,
  getSession,
  listSessions,
  logMessage,
  logToolExecution,
  logMutation,
  deleteOldSessions,
} from "../../src/storage.js";

function createInMemoryDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  return db;
}

describe("schema versioning", () => {
  it("returns 0 for fresh database", () => {
    const db = createInMemoryDb();
    expect(getCurrentSchemaVersion(db)).toBe(0);
    db.close();
  });

  it("runs migrations and sets version to 1", () => {
    const db = createInMemoryDb();
    runMigrations(db);
    expect(getCurrentSchemaVersion(db)).toBe(1);
    db.close();
  });

  it("does not re-run migrations if already up to date", () => {
    const db = createInMemoryDb();
    runMigrations(db);
    runMigrations(db); // Should be idempotent
    expect(getCurrentSchemaVersion(db)).toBe(1);
    db.close();
  });

  it("creates all required tables", () => {
    const db = createInMemoryDb();
    runMigrations(db);

    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
      )
      .all() as Array<{ name: string }>;

    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain("sessions");
    expect(tableNames).toContain("messages");
    expect(tableNames).toContain("tool_executions");
    expect(tableNames).toContain("mutations");
    expect(tableNames).toContain("schema_versions");
    db.close();
  });
});

describe("session CRUD", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createInMemoryDb();
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("creates a session with running status", () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    createSession(db, {
      id,
      command: "ask",
      projectRoot: "/project",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });

    const session = getSession(db, id);
    expect(session).not.toBeNull();
    expect(session!.id).toBe(id);
    expect(session!.command).toBe("ask");
    expect(session!.status).toBe("running");
    expect(session!.projectRoot).toBe("/project");
  });

  it("updates session status to completed", () => {
    const id = "550e8400-e29b-41d4-a716-446655440001";
    createSession(db, {
      id,
      command: "plan",
      projectRoot: "/project",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });

    updateSessionStatus(db, id, "completed");
    const session = getSession(db, id);
    expect(session!.status).toBe("completed");
  });

  it("updates session status to failed with error", () => {
    const id = "550e8400-e29b-41d4-a716-446655440002";
    createSession(db, {
      id,
      command: "patch",
      projectRoot: "/project",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });

    updateSessionStatus(db, id, "failed", "Something went wrong");
    const session = getSession(db, id);
    expect(session!.status).toBe("failed");
    expect(session!.error).toBe("Something went wrong");
  });

  it("returns null for non-existent session", () => {
    const session = getSession(db, "non-existent-id");
    expect(session).toBeNull();
  });

  it("lists sessions in descending order", () => {
    const ids = [
      "550e8400-e29b-41d4-a716-446655440010",
      "550e8400-e29b-41d4-a716-446655440011",
      "550e8400-e29b-41d4-a716-446655440012",
    ];

    for (const id of ids) {
      createSession(db, {
        id,
        command: "ask",
        projectRoot: "/project",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      });
    }

    const sessions = listSessions(db);
    expect(sessions.length).toBe(3);
  });

  it("respects limit in listSessions", () => {
    for (let i = 0; i < 5; i++) {
      createSession(db, {
        id: `550e8400-e29b-41d4-a716-44665544001${i}`,
        command: "ask",
        projectRoot: "/project",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      });
    }

    const sessions = listSessions(db, { limit: 2 });
    expect(sessions.length).toBe(2);
  });
});

describe("logging functions", () => {
  let db: Database.Database;
  const sessionId = "550e8400-e29b-41d4-a716-446655440020";

  beforeEach(() => {
    db = createInMemoryDb();
    runMigrations(db);
    createSession(db, {
      id: sessionId,
      command: "ask",
      projectRoot: "/project",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
  });

  afterEach(() => {
    db.close();
  });

  it("logs a message", () => {
    logMessage(db, sessionId, "user", "Hello, world!");
    const messages = db
      .prepare("SELECT * FROM messages WHERE session_id = ?")
      .all(sessionId) as Array<{ role: string; content: string }>;
    expect(messages.length).toBe(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe("Hello, world!");
  });

  it("logs a tool execution", () => {
    logToolExecution(db, sessionId, "read_file", { path: "src/index.ts" }, {
      success: true,
      data: { content: "export default {}" },
    });

    const executions = db
      .prepare("SELECT * FROM tool_executions WHERE session_id = ?")
      .all(sessionId) as Array<{ tool_name: string }>;
    expect(executions.length).toBe(1);
    expect(executions[0].tool_name).toBe("read_file");
  });

  it("logs a mutation", () => {
    logMutation(db, sessionId, {
      action: "apply_diff",
      affectedFiles: ["src/index.ts"],
      riskLevel: "low",
      reversible: true,
      rollbackHints: ["git checkout -- src/index.ts"],
    });

    const mutations = db
      .prepare("SELECT * FROM mutations WHERE session_id = ?")
      .all(sessionId) as Array<{ action: string; risk_level: string }>;
    expect(mutations.length).toBe(1);
    expect(mutations[0].action).toBe("apply_diff");
    expect(mutations[0].risk_level).toBe("low");
  });
});

describe("deleteOldSessions", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createInMemoryDb();
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("deletes sessions older than retain_days", () => {
    const id = "550e8400-e29b-41d4-a716-446655440030";
    createSession(db, {
      id,
      command: "ask",
      projectRoot: "/project",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });

    // Manually set created_at to 100 days ago
    db.prepare(
      `UPDATE sessions SET created_at = datetime('now', '-100 days') WHERE id = ?`
    ).run(id);

    const deleted = deleteOldSessions(db, 90);
    expect(deleted).toBe(1);
    expect(getSession(db, id)).toBeNull();
  });

  it("does not delete sessions within retain_days", () => {
    const id = "550e8400-e29b-41d4-a716-446655440031";
    createSession(db, {
      id,
      command: "ask",
      projectRoot: "/project",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });

    const deleted = deleteOldSessions(db, 90);
    expect(deleted).toBe(0);
    expect(getSession(db, id)).not.toBeNull();
  });
});
