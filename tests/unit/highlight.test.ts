import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { highlight, inferLanguageFromPath } from '../../src/ui/highlight.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, '../fixtures/highlight');

describe('highlight', () => {
  it('highlights TypeScript fixture', () => {
    const content = readFileSync(path.join(fixturesDir, 'sample.ts'), 'utf-8');
    const result = highlight(content, { language: 'typescript' });
    expect(result).toMatchSnapshot();
  });

  it('highlights JavaScript fixture', () => {
    const content = readFileSync(path.join(fixturesDir, 'sample.js'), 'utf-8');
    const result = highlight(content, { language: 'javascript' });
    expect(result).toMatchSnapshot();
  });

  it('highlights Prisma fixture', () => {
    const content = readFileSync(path.join(fixturesDir, 'sample.prisma'), 'utf-8');
    const result = highlight(content, { language: 'prisma' });
    expect(result).toMatchSnapshot();
  });

  it('highlights JSON fixture', () => {
    const content = readFileSync(path.join(fixturesDir, 'sample.json'), 'utf-8');
    const result = highlight(content, { language: 'json' });
    expect(result).toMatchSnapshot();
  });

  it('highlights Markdown fixture', () => {
    const content = readFileSync(path.join(fixturesDir, 'sample.md'), 'utf-8');
    const result = highlight(content, { language: 'markdown' });
    expect(result).toMatchSnapshot();
  });

  it('returns input unchanged for unsupported language', () => {
    const input = 'anything';
    expect(highlight(input, { language: 'cobol' })).toBe(input);
  });
});

describe('inferLanguageFromPath', () => {
  it('maps extensions to the correct language', () => {
    expect(inferLanguageFromPath('foo.ts')).toBe('typescript');
    expect(inferLanguageFromPath('foo.tsx')).toBe('typescript');
    expect(inferLanguageFromPath('foo.js')).toBe('javascript');
    expect(inferLanguageFromPath('foo.jsx')).toBe('javascript');
    expect(inferLanguageFromPath('foo.mjs')).toBe('javascript');
    expect(inferLanguageFromPath('foo.cjs')).toBe('javascript');
    expect(inferLanguageFromPath('foo.prisma')).toBe('prisma');
    expect(inferLanguageFromPath('foo.json')).toBe('json');
    expect(inferLanguageFromPath('foo.md')).toBe('markdown');
    expect(inferLanguageFromPath('foo.rb')).toBeNull();
  });
});
