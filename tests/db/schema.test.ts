import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parsePrismaSchema, parsePrismaSchemaContent, findSchemaPath } from '../../src/db/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, '..', 'fixtures');

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function fixtureRoot(name: string): string {
  return path.join(FIXTURES, name);
}

// ---------------------------------------------------------------------------
// findSchemaPath
// ---------------------------------------------------------------------------

describe('findSchemaPath', () => {
  it('finds prisma/schema.prisma', () => {
    const result = findSchemaPath(fixtureRoot('prisma-simple'));
    expect(result).not.toBeNull();
    expect(result).toContain('schema.prisma');
  });

  it('returns null when no schema exists', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-test-'));
    expect(findSchemaPath(tmp)).toBeNull();
    fs.rmdirSync(tmp);
  });
});

// ---------------------------------------------------------------------------
// parsePrismaSchema — simple fixture
// ---------------------------------------------------------------------------

describe('parsePrismaSchema — prisma-simple', () => {
  const info = parsePrismaSchema(fixtureRoot('prisma-simple'))!;

  it('returns non-null', () => {
    expect(info).not.toBeNull();
  });

  it('detects postgresql provider', () => {
    expect(info.datasourceProvider).toBe('postgresql');
  });

  it('extracts 2 models', () => {
    expect(info.models).toHaveLength(2);
  });

  it('extracts User model fields', () => {
    const user = info.models.find((m) => m.name === 'User')!;
    expect(user).toBeDefined();
    const idField = user.fields.find((f) => f.name === 'id')!;
    expect(idField.isId).toBe(true);
    expect(idField.defaultValue).toContain('cuid');

    const emailField = user.fields.find((f) => f.name === 'email')!;
    expect(emailField.isUnique).toBe(true);

    const nameField = user.fields.find((f) => f.name === 'name')!;
    expect(nameField.isOptional).toBe(true);

    const postsField = user.fields.find((f) => f.name === 'posts')!;
    expect(postsField.isList).toBe(true);
    expect(postsField.isRelation).toBe(true);
  });

  it('extracts Post model with relation', () => {
    const post = info.models.find((m) => m.name === 'Post')!;
    expect(post).toBeDefined();
    const authorField = post.fields.find((f) => f.name === 'author')!;
    expect(authorField.isRelation).toBe(true);
    expect(authorField.relationFields).toContain('authorId');
    expect(authorField.relationReferences).toContain('id');
  });

  it('extracts Post index', () => {
    const post = info.models.find((m) => m.name === 'Post')!;
    expect(post.indexes).toHaveLength(1);
    expect(post.indexes[0].fields).toContain('authorId');
    expect(post.indexes[0].type).toBe('index');
  });

  it('has no enums', () => {
    expect(info.enums).toHaveLength(0);
  });

  it('extracts generator', () => {
    expect(info.generators).toHaveLength(1);
    expect(info.generators[0].provider).toBe('prisma-client-js');
  });
});

// ---------------------------------------------------------------------------
// parsePrismaSchema — ecommerce fixture
// ---------------------------------------------------------------------------

describe('parsePrismaSchema — prisma-ecommerce', () => {
  const info = parsePrismaSchema(fixtureRoot('prisma-ecommerce'))!;

  it('extracts 8 models', () => {
    expect(info.models).toHaveLength(8);
  });

  it('extracts 2 enums', () => {
    expect(info.enums).toHaveLength(2);
    const orderStatus = info.enums.find((e) => e.name === 'OrderStatus')!;
    expect(orderStatus.values).toContain('PENDING');
    expect(orderStatus.values).toContain('DELIVERED');
  });

  it('extracts composite indexes on Order', () => {
    const order = info.models.find((m) => m.name === 'Order')!;
    expect(order.indexes.length).toBeGreaterThanOrEqual(1);
    const userStatusIdx = order.indexes.find((i) => i.fields.includes('userId'));
    expect(userStatusIdx).toBeDefined();
  });

  it('extracts unique index on Review', () => {
    const review = info.models.find((m) => m.name === 'Review')!;
    const uniqueIdx = review.indexes.find((i) => i.type === 'unique');
    expect(uniqueIdx).toBeDefined();
    expect(uniqueIdx!.fields).toContain('userId');
    expect(uniqueIdx!.fields).toContain('productId');
  });
});

// ---------------------------------------------------------------------------
// parsePrismaSchema — auth fixture
// ---------------------------------------------------------------------------

describe('parsePrismaSchema — prisma-auth', () => {
  const info = parsePrismaSchema(fixtureRoot('prisma-auth'))!;

  it('extracts 5 models', () => {
    expect(info.models).toHaveLength(5);
  });

  it('has Role enum', () => {
    const role = info.enums.find((e) => e.name === 'Role')!;
    expect(role).toBeDefined();
    expect(role.values).toContain('ADMIN');
  });

  it('Session has unique sessionToken', () => {
    const session = info.models.find((m) => m.name === 'Session')!;
    const tokenField = session.fields.find((f) => f.name === 'sessionToken')!;
    expect(tokenField.isUnique).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parsePrismaSchema — relations fixture
// ---------------------------------------------------------------------------

describe('parsePrismaSchema — prisma-relations', () => {
  const info = parsePrismaSchema(fixtureRoot('prisma-relations'))!;

  it('extracts 6 models', () => {
    expect(info.models).toHaveLength(6);
  });

  it('PostTag has composite id (no @id field)', () => {
    const postTag = info.models.find((m) => m.name === 'PostTag')!;
    expect(postTag).toBeDefined();
    // composite @@id means no single @id field
    const idFields = postTag.fields.filter((f) => f.isId);
    expect(idFields).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// parsePrismaSchemaContent — stability
// ---------------------------------------------------------------------------

describe('parsePrismaSchemaContent — parse stability', () => {
  it('parsing twice produces identical result', () => {
    const schemaPath = path.join(fixtureRoot('prisma-ecommerce'), 'prisma', 'schema.prisma');
    const content = fs.readFileSync(schemaPath, 'utf-8');
    const first = parsePrismaSchemaContent(content);
    const second = parsePrismaSchemaContent(content);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('parsePrismaSchema — error handling', () => {
  it('returns null for missing schema', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-test-'));
    fs.writeFileSync(path.join(tmp, 'package.json'), '{}');
    expect(parsePrismaSchema(tmp)).toBeNull();
    fs.rmdirSync(tmp, { recursive: true } as any);
  });
});
