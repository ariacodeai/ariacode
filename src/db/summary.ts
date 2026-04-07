/**
 * Human-readable terminal rendering of a parsed Prisma schema.
 */

import type { PrismaSchemaInfo, PrismaModel, PrismaField } from './schema.js';
import pc from 'picocolors';
import Table from 'cli-table3';

// ---------------------------------------------------------------------------
// Field rendering helpers
// ---------------------------------------------------------------------------

function fieldTypeLabel(field: PrismaField): string {
  const base = field.type;
  const suffix = field.isList ? '[]' : field.isOptional ? '?' : '';
  return base + suffix;
}

function fieldModifiers(field: PrismaField): string {
  const mods: string[] = [];
  if (field.isId) mods.push('@id');
  if (field.isUnique) mods.push('@unique');
  if (field.defaultValue !== null) mods.push(`@default(${field.defaultValue})`);
  if (field.isRelation) mods.push('relation');
  return mods.join(' ');
}

// ---------------------------------------------------------------------------
// Model rendering
// ---------------------------------------------------------------------------

function renderModel(model: PrismaModel, colorEnabled: boolean): string {
  const lines: string[] = [];

  const name = colorEnabled ? pc.bold(pc.cyan(model.name)) : model.name;
  lines.push(`  ${name}`);

  if (model.documentation) {
    lines.push(`  ${colorEnabled ? pc.dim(model.documentation) : model.documentation}`);
  }

  // Fields table
  const table = new Table({
    head: ['Field', 'Type', 'Modifiers'].map((h) => (colorEnabled ? pc.bold(h) : h)),
    style: { head: [], border: [] },
    chars: {
      top: '─',
      'top-mid': '┬',
      'top-left': '┌',
      'top-right': '┐',
      bottom: '─',
      'bottom-mid': '┴',
      'bottom-left': '└',
      'bottom-right': '┘',
      left: '│',
      'left-mid': '├',
      mid: '─',
      'mid-mid': '┼',
      right: '│',
      'right-mid': '┤',
      middle: '│',
    },
  });

  for (const field of model.fields) {
    const typeStr = fieldTypeLabel(field);
    const mods = fieldModifiers(field);
    table.push([
      colorEnabled && field.isId ? pc.yellow(field.name) : field.name,
      colorEnabled && field.isRelation ? pc.magenta(typeStr) : typeStr,
      colorEnabled ? pc.dim(mods) : mods,
    ]);
  }

  // Indent table lines
  const tableStr = table.toString();
  for (const line of tableStr.split('\n')) {
    lines.push('  ' + line);
  }

  // Indexes
  if (model.indexes.length > 0) {
    const indexStr = model.indexes
      .map((idx) => {
        const label = idx.type === 'unique' ? '@@unique' : idx.type === 'fulltext' ? '@@fulltext' : '@@index';
        return `${label}([${idx.fields.join(', ')}])${idx.name ? ` "${idx.name}"` : ''}`;
      })
      .join(', ');
    const prefix = colorEnabled ? pc.dim('Indexes:') : 'Indexes:';
    lines.push(`  ${prefix} ${indexStr}`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render a full schema summary to a string for terminal output.
 */
export function renderSchemaSummary(info: PrismaSchemaInfo, colorEnabled = true): string {
  const lines: string[] = [];

  const header = colorEnabled
    ? pc.bold(`Prisma Schema: ${info.path}`)
    : `Prisma Schema: ${info.path}`;
  lines.push(header);

  if (info.datasourceProvider) {
    const providerLine = colorEnabled
      ? pc.dim(`Provider: ${info.datasourceProvider}`)
      : `Provider: ${info.datasourceProvider}`;
    lines.push(providerLine);
  }

  lines.push('');

  // Models
  const modelsHeader = colorEnabled
    ? pc.bold(`Models (${info.models.length})`)
    : `Models (${info.models.length})`;
  lines.push(modelsHeader);

  for (const model of info.models) {
    lines.push('');
    lines.push(renderModel(model, colorEnabled));
  }

  // Enums
  if (info.enums.length > 0) {
    lines.push('');
    const enumsHeader = colorEnabled
      ? pc.bold(`Enums (${info.enums.length})`)
      : `Enums (${info.enums.length})`;
    lines.push(enumsHeader);

    for (const enumDef of info.enums) {
      const enumName = colorEnabled ? pc.cyan(enumDef.name) : enumDef.name;
      lines.push(`  ${enumName}: ${enumDef.values.join(', ')}`);
    }
  }

  return lines.join('\n');
}

/**
 * Render a single model summary (for --model filter).
 */
export function renderModelSummary(model: PrismaModel, colorEnabled = true): string {
  return renderModel(model, colorEnabled);
}
