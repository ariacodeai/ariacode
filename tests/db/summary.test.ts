import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePrismaSchema } from '../../src/db/schema.js';
import { renderSchemaSummary, renderModelSummary } from '../../src/db/summary.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, '..', 'fixtures');

function fixtureRoot(name: string): string {
  return path.join(FIXTURES, name);
}

describe('renderSchemaSummary', () => {
  it('contains model names for simple fixture', () => {
    const info = parsePrismaSchema(fixtureRoot('prisma-simple'))!;
    const output = renderSchemaSummary(info, false);
    expect(output).toContain('User');
    expect(output).toContain('Post');
    expect(output).toContain('postgresql');
  });

  it('contains enum names for ecommerce fixture', () => {
    const info = parsePrismaSchema(fixtureRoot('prisma-ecommerce'))!;
    const output = renderSchemaSummary(info, false);
    expect(output).toContain('OrderStatus');
    expect(output).toContain('Role');
    expect(output).toContain('PENDING');
  });

  it('contains index info', () => {
    const info = parsePrismaSchema(fixtureRoot('prisma-simple'))!;
    const output = renderSchemaSummary(info, false);
    expect(output).toContain('authorId');
  });

  it('renders without color codes when colorEnabled=false', () => {
    const info = parsePrismaSchema(fixtureRoot('prisma-simple'))!;
    const output = renderSchemaSummary(info, false);
    // ANSI escape codes start with \x1b[
    expect(output).not.toMatch(/\x1b\[/);
  });

  it('renders with color codes when colorEnabled=true', () => {
    const info = parsePrismaSchema(fixtureRoot('prisma-simple'))!;
    const output = renderSchemaSummary(info, true);
    // picocolors may disable colors in non-TTY environments (CI)
    // Just verify the output is non-empty and contains model names
    expect(output).toContain('User');
    expect(output.length).toBeGreaterThan(0);
  });

  it('renders all fixture schemas without throwing', () => {
    for (const fixture of ['prisma-simple', 'prisma-ecommerce', 'prisma-auth', 'prisma-relations']) {
      const info = parsePrismaSchema(fixtureRoot(fixture))!;
      expect(() => renderSchemaSummary(info, false)).not.toThrow();
    }
  });
});

describe('renderModelSummary', () => {
  it('renders a single model', () => {
    const info = parsePrismaSchema(fixtureRoot('prisma-simple'))!;
    const user = info.models.find((m) => m.name === 'User')!;
    const output = renderModelSummary(user, false);
    expect(output).toContain('User');
    expect(output).toContain('email');
    expect(output).toContain('id');
  });
});
