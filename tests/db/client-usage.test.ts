import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { findPrismaClientUsage } from '../../src/db/client-usage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Skip all tests if ripgrep is not installed
function isRgAvailable(): boolean {
  try {
    execFileSync('rg', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const rgAvailable = isRgAvailable();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpProject(files: Record<string, string>): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-client-usage-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
  }
  return tmp;
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('findPrismaClientUsage', () => {
  it('finds prisma.user.findMany calls', async () => {
    if (!rgAvailable) return; // skip if rg not installed
    const tmp = makeTmpProject({
      'src/users.ts': `
const users = await prisma.user.findMany({ where: { active: true } });
const count = await prisma.user.count();
`,
    });

    try {
      const usages = await findPrismaClientUsage(tmp);
      expect(usages.length).toBeGreaterThanOrEqual(1);
      const findMany = usages.find((u) => u.operation === 'findMany');
      expect(findMany).toBeDefined();
      expect(findMany!.model).toBe('user');
    } finally {
      cleanup(tmp);
    }
  });

  it('filters by model name', async () => {
    if (!rgAvailable) return;
    const tmp = makeTmpProject({
      'src/app.ts': `
const users = await prisma.user.findMany();
const orders = await prisma.order.findMany();
`,
    });

    try {
      const usages = await findPrismaClientUsage(tmp, 'user');
      expect(usages.every((u) => u.model === 'user')).toBe(true);
    } finally {
      cleanup(tmp);
    }
  });

  it('returns empty array when no matches', async () => {
    if (!rgAvailable) return;
    const tmp = makeTmpProject({
      'src/app.ts': 'const x = 1;\n',
    });

    try {
      const usages = await findPrismaClientUsage(tmp);
      expect(usages).toHaveLength(0);
    } finally {
      cleanup(tmp);
    }
  });

  it('returns empty array for empty project', async () => {
    if (!rgAvailable) return;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-empty-'));
    try {
      const usages = await findPrismaClientUsage(tmp);
      expect(usages).toHaveLength(0);
    } finally {
      cleanup(tmp);
    }
  });

  it('captures file and line number', async () => {
    if (!rgAvailable) return;
    const tmp = makeTmpProject({
      'src/service.ts': `
// line 2
const result = await prisma.post.create({ data: { title: 'hello' } });
`,
    });

    try {
      const usages = await findPrismaClientUsage(tmp);
      expect(usages.length).toBeGreaterThanOrEqual(1);
      const create = usages.find((u) => u.operation === 'create');
      expect(create).toBeDefined();
      expect(create!.file).toContain('service.ts');
      expect(create!.line).toBeGreaterThan(0);
    } finally {
      cleanup(tmp);
    }
  });
});
