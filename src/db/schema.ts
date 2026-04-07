/**
 * Prisma schema parser — wraps @mrleebo/prisma-ast to provide a clean typed interface.
 * Schema-aware only: no database connections, no DATABASE_URL parsing.
 */

import { z } from 'zod';
import { getSchema } from '@mrleebo/prisma-ast';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Zod schemas & types
// ---------------------------------------------------------------------------

export const PrismaFieldSchema = z.object({
  name: z.string(),
  type: z.string(),
  isList: z.boolean(),
  isOptional: z.boolean(),
  isId: z.boolean(),
  isUnique: z.boolean(),
  isRelation: z.boolean(),
  relationName: z.string().nullable(),
  relationFields: z.array(z.string()).default([]),
  relationReferences: z.array(z.string()).default([]),
  defaultValue: z.string().nullable(),
  attributes: z.array(z.string()).default([]),
});

export const PrismaModelSchema = z.object({
  name: z.string(),
  fields: z.array(PrismaFieldSchema),
  indexes: z
    .array(
      z.object({
        fields: z.array(z.string()),
        type: z.enum(['index', 'unique', 'fulltext']),
        name: z.string().nullable(),
      }),
    )
    .default([]),
  documentation: z.string().nullable(),
});

export const PrismaEnumSchema = z.object({
  name: z.string(),
  values: z.array(z.string()),
  documentation: z.string().nullable(),
});

export const PrismaSchemaInfoSchema = z.object({
  path: z.string(),
  datasourceProvider: z.string().nullable(),
  models: z.array(PrismaModelSchema),
  enums: z.array(PrismaEnumSchema),
  generators: z
    .array(
      z.object({
        name: z.string(),
        provider: z.string(),
      }),
    )
    .default([]),
});

export type PrismaField = z.infer<typeof PrismaFieldSchema>;
export type PrismaModel = z.infer<typeof PrismaModelSchema>;
export type PrismaEnum = z.infer<typeof PrismaEnumSchema>;
export type PrismaSchemaInfo = z.infer<typeof PrismaSchemaInfoSchema>;

// ---------------------------------------------------------------------------
// Schema path resolution
// ---------------------------------------------------------------------------

export function findSchemaPath(projectRoot: string): string | null {
  const resolvedRoot = path.resolve(projectRoot);
  const candidates = [
    path.join(resolvedRoot, 'prisma', 'schema.prisma'),
    path.join(resolvedRoot, 'schema.prisma'),
  ];
  // Verify candidates are within project root (defense in depth)
  return candidates.find((p) => p.startsWith(resolvedRoot) && fs.existsSync(p)) ?? null;
}

// ---------------------------------------------------------------------------
// AST extraction helpers
// ---------------------------------------------------------------------------

function extractDatasourceProvider(ast: ReturnType<typeof getSchema>): string | null {
  const ds = ast.list.find((n: any) => n.type === 'datasource') as any;
  if (!ds) return null;
  const providerAssignment = ds.assignments?.find((a: any) => a.key === 'provider');
  if (!providerAssignment) return null;
  const raw = providerAssignment.value;
  if (typeof raw === 'string') return raw.replace(/^"|"$/g, '');
  return null;
}

function extractGenerators(ast: ReturnType<typeof getSchema>): Array<{ name: string; provider: string }> {
  return ast.list
    .filter((n: any) => n.type === 'generator')
    .map((gen: any) => {
      const providerAssignment = gen.assignments?.find((a: any) => a.key === 'provider');
      const raw = providerAssignment?.value ?? '';
      const provider = typeof raw === 'string' ? raw.replace(/^"|"$/g, '') : String(raw);
      return { name: gen.name as string, provider };
    });
}

function extractDefaultValue(attr: any): string | null {
  if (!attr?.args?.length) return null;
  const arg = attr.args[0];
  const val = arg?.value;
  if (!val) return null;
  if (typeof val === 'string') return val.replace(/^"|"$/g, '');
  if (val.type === 'function') {
    const params = val.params?.map((p: any) => (typeof p === 'string' ? p.replace(/^"|"$/g, '') : String(p))).join(', ') ?? '';
    return params ? `${val.name}(${params})` : `${val.name}()`;
  }
  return String(val);
}

function extractRelationArgs(attr: any): { fields: string[]; references: string[]; name: string | null } {
  const result = { fields: [] as string[], references: [] as string[], name: null as string | null };
  if (!attr?.args) return result;
  for (const arg of attr.args) {
    const kv = arg?.value;
    if (!kv) continue;
    if (kv.type === 'keyValue') {
      if (kv.key === 'fields' && kv.value?.type === 'array') {
        result.fields = (kv.value.args ?? []).map((a: any) => typeof a === 'string' ? a : String(a));
      } else if (kv.key === 'references' && kv.value?.type === 'array') {
        result.references = (kv.value.args ?? []).map((a: any) => typeof a === 'string' ? a : String(a));
      } else if (kv.key === 'name') {
        result.name = typeof kv.value === 'string' ? kv.value.replace(/^"|"$/g, '') : null;
      }
    } else if (typeof kv === 'string') {
      // positional name argument
      result.name = kv.replace(/^"|"$/g, '');
    }
  }
  return result;
}

function extractField(prop: any, modelNames: Set<string>): PrismaField {
  const attrs: string[] = [];
  let isId = false;
  let isUnique = false;
  let isRelation = false;
  let relationName: string | null = null;
  let relationFields: string[] = [];
  let relationReferences: string[] = [];
  let defaultValue: string | null = null;

  for (const attr of prop.attributes ?? []) {
    if (attr.type !== 'attribute') continue;
    const name: string = attr.name;
    attrs.push(name);
    if (name === 'id') isId = true;
    if (name === 'unique') isUnique = true;
    if (name === 'default') defaultValue = extractDefaultValue(attr);
    if (name === 'relation') {
      const rel = extractRelationArgs(attr);
      relationName = rel.name;
      relationFields = rel.fields;
      relationReferences = rel.references;
    }
  }

  // A field is a relation if its type is a known model name
  const fieldType = typeof prop.fieldType === 'string' ? prop.fieldType : String(prop.fieldType ?? '');
  if (modelNames.has(fieldType)) {
    isRelation = true;
  }

  return {
    name: prop.name as string,
    type: fieldType,
    isList: Boolean(prop.array),
    isOptional: Boolean(prop.optional),
    isId,
    isUnique,
    isRelation,
    relationName,
    relationFields,
    relationReferences,
    defaultValue,
    attributes: attrs,
  };
}

function extractIndexes(
  properties: any[],
): Array<{ fields: string[]; type: 'index' | 'unique' | 'fulltext'; name: string | null }> {
  const indexes: Array<{ fields: string[]; type: 'index' | 'unique' | 'fulltext'; name: string | null }> = [];

  for (const prop of properties) {
    if (prop.type !== 'attribute' || prop.kind !== 'object') continue;
    const name: string = prop.name;
    if (name !== 'index' && name !== 'unique' && name !== 'fulltext') continue;

    let fields: string[] = [];
    let indexName: string | null = null;

    for (const arg of prop.args ?? []) {
      const val = arg?.value;
      if (!val) continue;
      if (val.type === 'array') {
        fields = (val.args ?? []).map((a: any) => typeof a === 'string' ? a : String(a));
      } else if (val.type === 'keyValue') {
        if (val.key === 'fields' && val.value?.type === 'array') {
          fields = (val.value.args ?? []).map((a: any) => typeof a === 'string' ? a : String(a));
        } else if (val.key === 'name') {
          indexName = typeof val.value === 'string' ? val.value.replace(/^"|"$/g, '') : null;
        }
      }
    }

    indexes.push({ fields, type: name as 'index' | 'unique' | 'fulltext', name: indexName });
  }

  return indexes;
}

function extractModels(ast: ReturnType<typeof getSchema>): PrismaModel[] {
  const modelNodes = ast.list.filter((n: any) => n.type === 'model') as any[];
  const modelNames = new Set(modelNodes.map((m: any) => m.name as string));

  return modelNodes.map((model: any) => {
    const properties: any[] = model.properties ?? [];
    const fields = properties
      .filter((p: any) => p.type === 'field')
      .map((p: any) => extractField(p, modelNames));

    const indexes = extractIndexes(properties);

    // Extract documentation (/// comments stored as comment nodes before the model)
    const docNode = properties.find((p: any) => p.type === 'comment' && p.text?.startsWith('///'));
    const documentation = docNode ? (docNode.text as string).replace(/^\/\/\/\s?/, '').trim() : null;

    return { name: model.name as string, fields, indexes, documentation };
  });
}

function extractEnums(ast: ReturnType<typeof getSchema>): PrismaEnum[] {
  return ast.list
    .filter((n: any) => n.type === 'enum')
    .map((enumNode: any) => {
      const values = (enumNode.enumerators ?? [])
        .filter((e: any) => e.type === 'enumerator')
        .map((e: any) => e.name as string);
      return { name: enumNode.name as string, values, documentation: null };
    });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse schema.prisma file into structured format.
 * Returns null if no schema found.
 * Throws on parse errors so callers can distinguish "no schema" from "bad schema".
 */
export function parsePrismaSchema(projectRoot: string): PrismaSchemaInfo | null {
  const schemaPath = findSchemaPath(projectRoot);
  if (!schemaPath) return null;

  const content = fs.readFileSync(schemaPath, 'utf-8');
  try {
    const ast = getSchema(content);

    return {
      path: path.relative(projectRoot, schemaPath),
      datasourceProvider: extractDatasourceProvider(ast),
      models: extractModels(ast),
      enums: extractEnums(ast),
      generators: extractGenerators(ast),
    };
  } catch (err) {
    throw new Error(
      `Failed to parse ${path.relative(projectRoot, schemaPath)}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Parse schema.prisma from raw content string (for testing / propose_schema_change).
 */
export function parsePrismaSchemaContent(content: string): PrismaSchemaInfo {
  const ast = getSchema(content);
  return {
    path: 'schema.prisma',
    datasourceProvider: extractDatasourceProvider(ast),
    models: extractModels(ast),
    enums: extractEnums(ast),
    generators: extractGenerators(ast),
  };
}
