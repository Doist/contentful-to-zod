import { z } from "zod";
import { isZodSchemaWithInternalReference } from "./augments/internal.js";
import { isZodSchemaWithReferences } from "./augments/reference.js";
import { internalSchemas } from "./schemas/index.js";
import { richTextSchema } from "./schemas/rich-text.js";
import { PrintConfig } from "./types.js";
import { unique } from "./utils/array.js";
import { toPascalCase } from "./utils/string.js";
import { isZodOptionalSchema } from "./utils/zod.js";

/**
 * Converts a Zod schema to its string representation for code generation
 * @param schema - The Zod schema to convert
 * @param config - Resolved generator config
 * @returns A string representation of the schema that can be used in generated code
 */
function zodToString(schema: unknown, config: ResolvedGeneratorConfig): string {
  if (!(schema instanceof z.ZodType)) {
    if (config.abortOnUnknown) {
      throw new Error("Attempted to transform a non-Zod type");
    }
    console.error("Attempted to transform a non-Zod type");
    return "z.unknown()";
  }

  if (!config.flat && isZodSchemaWithInternalReference(schema)) {
    const reference = config.toSchemaName(schema._reference)

    if (isZodOptionalSchema(schema)) {
      return `${reference}.optional()`;
    }

    return reference;
  }

  if (!config.flat && isZodSchemaWithReferences(schema)) {
    return "z.unknown()";
  }

  let result = "";
  switch (schema._def.typeName) {
    case "ZodObject": {
      const shape = schema._def.shape();
      const fields = Object.entries(shape)
        .map(([key, value]) => {
          return `    ${key}: ${zodToString(value, config)}`;
        })
        .join(",\n");
      result = `z.object({\n${fields}\n  })`;
      if (config.passthrough) {
        result += ".passthrough()";
      }
      break;
    }

    case "ZodArray":
      result = `z.array(${zodToString(schema._def.type, config)})`;
      break;

    case "ZodOptional":
      result = `${zodToString(schema._def.innerType, config)}.optional()`;
      break;

    case "ZodString":
      result = "z.string()";
      if (
        schema._def.checks?.some(
          (check: z.ZodStringCheck) => check.kind === "datetime"
        )
      ) {
        result += ".datetime()";
      }
      break;

    case "ZodNumber":
      result = "z.number()";
      if (
        schema._def.checks?.some(
          (check: z.ZodNumberCheck) => check.kind === "int"
        )
      ) {
        result += ".int()";
      }
      break;

    case "ZodBoolean":
      result = "z.boolean()";
      break;

    case "ZodLiteral":
      result = `z.literal(${JSON.stringify(schema._def.value)})`;
      break;

    case "ZodRecord":
      result = `z.record(${zodToString(schema._def.valueType, config)})`;
      break;

    case "ZodUnknown":
      result = "z.unknown()";
      break;

    case "ZodUnion":
      result = `z.union([${schema._def.options
        .map((option: z.ZodType) => zodToString(option, config))
        .join(", ")}])`;
      break;

    case "ZodEnum":
      result = `z.enum(${JSON.stringify(schema._def.values)})`;
      break;

    default:
      if (config.abortOnUnknown) {
        throw new Error(`Unsupported Zod type: ${schema._def.typeName}`);
      }
      console.error(`Unsupported Zod type: ${schema._def.typeName}`);
      return "z.unknown()";
  }

  return result;
}

function findInternalReferences(schema: unknown): string[] {
  if (!(schema instanceof z.ZodType)) {
    return [];
  }

  if (isZodSchemaWithInternalReference(schema)) {
    return [schema._reference];
  }

  switch (schema._def.typeName) {
    case "ZodObject": {
      return Object.values(schema._def.shape()).flatMap(findInternalReferences);
    }

    case "ZodArray":
      return findInternalReferences(schema._def.type);

    case "ZodOptional":
      return findInternalReferences(schema._def.innerType);

    case "ZodUnion":
      return schema._def.options.flatMap(findInternalReferences);

    default:
      return [];
  }
}

/**
 * Combines default options with user-specified options
 * @param options
 * @returns
 */
function resolveConfig(options: PrintConfig) {
  return {
    toTypeName(contentTypeId: string): string {
      return toPascalCase(contentTypeId);
    },
    toSchemaName(contentTypeId: string): string {
      return `${contentTypeId}Schema`;
    },
    flat: false,
    ...options,
  };
}

type ResolvedGeneratorConfig = ReturnType<typeof resolveConfig>;

/**
 * Gets the include depth for a specific content type.
 * Returns Infinity if no limit is set (full validation).
 * Returns 0 if the schema should be flat (no reference validation).
 */
function getIncludeDepth(
  contentTypeId: string,
  config: ResolvedGeneratorConfig
): number {
  if (config.flat) {
    return 0;
  }
  
  const { includeDepth } = config;
  
  if (includeDepth === undefined) {
    return Infinity;
  }
  
  if (typeof includeDepth === 'number') {
    return includeDepth;
  }
  
  // Object with per-schema depths
  return includeDepth[contentTypeId] ?? includeDepth['default'] ?? Infinity;
}

type SchemaMap = Record<string, z.ZodObject<{ fields: z.ZodObject<z.ZodRawShape> }>>;

type FieldReferenceInfo = {
  types: string[];
  multiple: boolean;
  optional: boolean;
};

/**
 * Extracts field reference information from a schema
 */
function extractFieldReferences(
  schema: z.ZodObject<{ fields: z.ZodObject<z.ZodRawShape> }>
): Map<string, FieldReferenceInfo> {
  return Object.entries(schema.shape.fields.shape).reduce(
    (acc, [field, value]) => {
      const references = isZodSchemaWithReferences(value)
        ? value._references
        : [];
      if (references.length > 0) {
        const isOptional = "typeName" in value._def && value._def.typeName === "ZodOptional";
        let isMultiple = "typeName" in value._def && value._def.typeName === "ZodArray";

        if (isOptional) {
          const innerType = value._def.innerType;
          isMultiple = "typeName" in innerType._def && innerType._def.typeName === "ZodArray";
        }

        acc.set(field, {
          types: references,
          multiple: isMultiple,
          optional: isOptional,
        });
      }
      return acc;
    },
    new Map<string, FieldReferenceInfo>()
  );
}

/**
 * Generates a reference field with depth tracking.
 * If currentDepth > maxDepth, returns z.unknown().optional()
 * Otherwise, inlines the referenced schema structure and recurses.
 */
function generateReferenceWithDepth(
  fieldName: string,
  refInfo: FieldReferenceInfo,
  currentDepth: number,
  maxDepth: number,
  allSchemas: SchemaMap,
  config: ResolvedGeneratorConfig,
  visitedPath: Set<string> = new Set()
): string {
  // Beyond depth limit - use z.unknown()
  if (currentDepth > maxDepth) {
    return `${fieldName}: z.unknown()${refInfo.optional ? '.optional()' : ''}`;
  }

  // At depth limit with no more depth to go - use z.unknown() for nested refs
  // but still validate the immediate structure
  if (currentDepth === maxDepth) {
    // Generate inline schema for the referenced type(s), but with all their refs as z.unknown()
    const inlineSchemas = refInfo.types.map(refType => {
      const refSchema = allSchemas[refType];
      if (!refSchema) {
        return 'z.unknown()';
      }
      return generateInlineSchema(refSchema, currentDepth + 1, maxDepth, allSchemas, config, visitedPath);
    });

    const schemaExpr = inlineSchemas.length === 1
      ? inlineSchemas[0]
      : `z.union([${inlineSchemas.join(', ')}])`;

    const wrappedExpr = refInfo.multiple ? `z.array(${schemaExpr})` : schemaExpr;
    return `${fieldName}: ${wrappedExpr}${refInfo.optional ? '.optional()' : ''}`;
  }

  // Within depth limit - inline the schema and recurse
  const inlineSchemas = refInfo.types.map(refType => {
    // Check for circular references
    if (visitedPath.has(refType)) {
      // Use z.lazy for circular refs to avoid infinite recursion
      return `z.lazy(() => ${config.toSchemaName(refType)})`;
    }
    
    const refSchema = allSchemas[refType];
    if (!refSchema) {
      return 'z.unknown()';
    }
    return generateInlineSchema(refSchema, currentDepth + 1, maxDepth, allSchemas, config, new Set([...visitedPath, refType]));
  });

  const schemaExpr = inlineSchemas.length === 1
    ? inlineSchemas[0]
    : `z.union([${inlineSchemas.join(', ')}])`;

  const wrappedExpr = refInfo.multiple ? `z.array(${schemaExpr})` : schemaExpr;
  return `${fieldName}: ${wrappedExpr}${refInfo.optional ? '.optional()' : ''}`;
}

/**
 * Generates an inline schema for a content type with depth tracking
 */
function generateInlineSchema(
  schema: z.ZodObject<{ fields: z.ZodObject<z.ZodRawShape> }>,
  currentDepth: number,
  maxDepth: number,
  allSchemas: SchemaMap,
  config: ResolvedGeneratorConfig,
  visitedPath: Set<string>
): string {
  const fieldsShape = schema.shape.fields.shape;
  const fieldReferences = extractFieldReferences(schema);
  
  // Generate field definitions
  const fieldDefs = Object.entries(fieldsShape).map(([fieldName, fieldSchema]) => {
    const refInfo = fieldReferences.get(fieldName);
    
    if (refInfo) {
      // This is a reference field - handle with depth tracking
      return generateReferenceWithDepth(
        fieldName,
        refInfo,
        currentDepth,
        maxDepth,
        allSchemas,
        config,
        visitedPath
      );
    }
    
    // Regular field - convert normally
    return `${fieldName}: ${zodToString(fieldSchema, { ...config, flat: true })}`;
  });

  // Get the sys shape
  const sysStr = zodToString(schema.shape.fields.shape.sys, { ...config, flat: true });

  return `z.object({
    sys: ${sysStr},
    fields: z.object({
      ${fieldDefs.join(',\n      ')}
    })
  })`;
}

/**
 * Generates TypeScript file content containing Zod schema definitions and their types
 * @param schemas - Record of schema names to their Zod schema objects
 * @param config - Print configuration options
 */
export function printTypescriptSchemas(
  schemas: Record<
    string,
    z.ZodObject<{
      fields: z.ZodObject<z.ZodRawShape>;
    }>
  >,
  config: PrintConfig
): string {
  const resolvedConfig = resolveConfig(config);

  const internalReferences = unique(
    Object.values(schemas).flatMap(findInternalReferences)
  );

  const imports = [
    `import { z } from "zod";`,
    ...(internalReferences.includes(richTextSchema._reference)
      ? ["import type { Document } from '@contentful/rich-text-types';"]
      : []),
  ].join("\n");

  const internalDefinitions = internalReferences
    .map((reference) => {
      const schema = internalSchemas.find(
        (schema) => schema._reference === reference
      );

      if (!schema) {
        throw new Error(`Could not find internal schema for ${reference}`);
      }

      return [
        `export const ${resolvedConfig.toSchemaName(reference)} = ${zodToString(
          schema,
          {
            ...resolvedConfig,
            flat: true,
          }
        )}${schema._typeCast ? ` as z.ZodType<${schema._typeCast}>` : ""};`,

        `export type ${resolvedConfig.toTypeName(reference)} = z.infer<typeof ${resolvedConfig.toSchemaName(reference)}>;`,
      ].join("\n\n");
    })
    .join("\n\n");

  const schemaDefinitions = Object.entries(schemas)
    .map(([name, schema]) => {
      const schemaIncludeDepth = getIncludeDepth(name, resolvedConfig);
      const fieldReferences = extractFieldReferences(schema);
      const hasDepthLimit = schemaIncludeDepth !== Infinity;

      // If this schema has a depth limit, generate with inline depth tracking
      if (hasDepthLimit && schemaIncludeDepth > 0) {
        // Generate reference fields with depth tracking
        const refFieldDefs = [...fieldReferences.entries()].map(([field, refInfo]) => {
          return generateReferenceWithDepth(
            field,
            refInfo,
            1, // Start at depth 1 for direct references
            schemaIncludeDepth,
            schemas,
            resolvedConfig,
            new Set([name])
          );
        });

        // For depth-limited schemas, let TypeScript infer the type from the schema
        // rather than declaring an explicit type with 'unknown' fields
        return [
          `const ${toBaseSchemaName(name)} = ${zodToString(schema, resolvedConfig)};`,

          `export const ${resolvedConfig.toSchemaName(name)} = ${toBaseSchemaName(name)}.extend({
          fields: ${toBaseSchemaName(name)}.shape.fields.extend({
            ${refFieldDefs.join(",\n            ")}
          })
        });`,

          `export type ${resolvedConfig.toTypeName(name)} = z.infer<typeof ${resolvedConfig.toSchemaName(name)}>;`,
        ].join("\n\n");
      }

      // If includeDepth is 0, don't resolve any references (flat schema)
      // References become z.unknown().optional() to accept unresolved links
      if (schemaIncludeDepth === 0) {
        return [
          `const ${toBaseSchemaName(name)} = ${zodToString(schema, resolvedConfig)};`,

          `export type ${resolvedConfig.toTypeName(name)} = z.infer<typeof ${toBaseSchemaName(
            name
          )}> & { fields: {${[...fieldReferences.entries()]
            .map(
              ([field, reference]) =>
                `${field}?: unknown`
            )
            .join(",\n")}} };`,

          `export const ${resolvedConfig.toSchemaName(name)}: z.ZodType<${resolvedConfig.toTypeName(
            name
          )}> = ${toBaseSchemaName(name)}.extend({
            fields: ${toBaseSchemaName(name)}.shape.fields.extend({
              ${[...fieldReferences.entries()]
            .map(
              ([field, reference]) =>
                `${field}: z.unknown().optional()`
            )
            .join(",\n")}
            })
          });`,
        ].join("\n\n");
      }

      // No depth limit - use z.lazy() references (original behavior)
      return [
        `const ${toBaseSchemaName(name)} = ${zodToString(schema, resolvedConfig)};`,

        `export type ${resolvedConfig.toTypeName(name)} = z.infer<typeof ${toBaseSchemaName(
          name
        )}> & { fields: {${[...fieldReferences.entries()]
          .map(
            ([field, reference]) =>
              `${field}${reference.optional ? "?" : ""}: (${reference.types
                .map(resolvedConfig.toTypeName)
                .concat(reference.optional ? ["undefined"] : [])
                .join(" | ")})${reference.multiple ? "[]" : ""}`
          )
          .join(",\n")}} };`,

        `export const ${resolvedConfig.toSchemaName(name)}: z.ZodType<${resolvedConfig.toTypeName(
          name
        )}> = ${toBaseSchemaName(name)}.extend({
          fields: ${toBaseSchemaName(name)}.shape.fields.extend({
            ${[...fieldReferences.entries()]
          .map(
            ([field, reference]) =>
              `${field}: z.lazy(() => ${reference.multiple ? "z.array(" : ""}${reference.types.length === 1
                ? resolvedConfig.toSchemaName(reference.types[0])
                : `z.union([${reference.types
                  .map(resolvedConfig.toSchemaName)
                  .join(", ")}])`
              }${reference.multiple ? ")" : ""})${reference.optional ? ".optional()" : ""}`
          )
          .join(",\n")}
          })
        });`,
      ].join("\n\n");
    })
    .join("\n\n");

  const content = [imports, internalDefinitions, schemaDefinitions].join(
    "\n\n"
  );

  return content;
}

function toBaseSchemaName(contentTypeId: string): string {
  return `_base${toPascalCase(contentTypeId)}`;
}
