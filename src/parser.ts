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
      const datetimeCheck = schema._def.checks?.find(
        (check: z.ZodStringCheck) => check.kind === "datetime"
      );
      if (datetimeCheck) {
        if (datetimeCheck.offset) {
          result += ".datetime({ offset: true })";
        } else {
          result += ".datetime()";
        }
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
    reference: false,
    ...options,
  };
}

type ResolvedGeneratorConfig = ReturnType<typeof resolveConfig>;

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

  const useReference = resolvedConfig.reference === true;

  /**
   * Collect reference metadata per content type for the referenceMap export.
   * Populated during schema generation, emitted at the end when --reference is enabled.
   */
  const allFieldReferences = new Map<
    string,
    Map<string, { types: string[]; multiple: boolean; optional: boolean }>
  >();

  const schemaDefinitions = Object.entries(schemas)
    .map(([name, schema]) => {
      const fieldReferences = Object.entries(schema.shape.fields.shape).reduce(
        (acc, [field, value]) => {
          const references = isZodSchemaWithReferences(value)
            ? value._references
            : [];
          if (references.length > 0) {
            const isOptional = "typeName" in value._def && value._def.typeName === "ZodOptional";
            let isMultiple = "typeName" in value._def && value._def.typeName === "ZodArray";

            /**
             * Optional arrays have structure: ZodOptional<ZodArray<T>>
             * Check ZodOptional's inner type to detect arrays when required=false
             * (e.g., Contentful Array fields with required: false)
             */
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
        new Map<
          string,
          { types: string[]; multiple: boolean; optional: boolean }
        >()
      );

      if (useReference && fieldReferences.size > 0) {
        allFieldReferences.set(name, fieldReferences);
      }

      /**
       * When --reference is enabled, reference fields use z.string() (entry IDs)
       * instead of z.lazy(() => schema). Types also use string instead of nested
       * content types. This produces flat schemas suitable for storing unresolved
       * entries in a content store, with resolution happening on-demand later.
       */

      return [
        `const ${toBaseSchemaName(name)} = ${zodToString(schema, resolvedConfig)};`,

        `export type ${resolvedConfig.toTypeName(name)} = z.infer<typeof ${toBaseSchemaName(
          name
        )}> & { fields: {${[...fieldReferences.entries()]
          .map(
            ([field, reference]) => {
              if (useReference) {
                const type = reference.multiple ? "string[]" : "string";
                return `${field}${reference.optional ? "?" : ""}: ${type}${reference.optional ? " | undefined" : ""}`;
              }
              return `${field}${reference.optional ? "?" : ""}: (${reference.types
                .map(resolvedConfig.toTypeName)
                .concat(reference.optional ? ["undefined"] : [])
                .join(" | ")})${reference.multiple ? "[]" : ""}`;
            }
          )
          .join(",\n")}} };`,

        `export const ${resolvedConfig.toSchemaName(name)}: z.ZodType<${resolvedConfig.toTypeName(
          name
        )}> = ${toBaseSchemaName(name)}.extend({
          fields: ${toBaseSchemaName(name)}.shape.fields.extend({
            ${[...fieldReferences.entries()]
          .map(
            ([field, reference]) => {
              if (useReference) {
                const schema = reference.multiple ? "z.array(z.string())" : "z.string()";
                return `${field}: ${schema}${reference.optional ? ".optional()" : ""}`;
              }
              return `${field}: z.lazy(() => ${reference.multiple ? "z.array(" : ""}${reference.types.length === 1
                ? resolvedConfig.toSchemaName(reference.types[0])
                : `z.union([${reference.types
                  .map(resolvedConfig.toSchemaName)
                  .join(", ")}])`
              }${reference.multiple ? ")" : ""})${reference.optional ? ".optional()" : ""}`;
            }
          )
          .join(",\n")}
          })
        });`,
      ].join("\n\n");
    })
    .join("\n\n");

  const parts = [imports, internalDefinitions, schemaDefinitions];

  /**
   * When --reference is enabled, export a referenceMap that maps each content
   * type to its reference fields with metadata (referenced types, cardinality).
   * Resolution wrappers use this to know which fields need resolving and to
   * which content types they point.
   */
  if (useReference && allFieldReferences.size > 0) {
    const referenceMapEntries = [...allFieldReferences.entries()]
      .map(([contentType, fields]) => {
        const fieldEntries = [...fields.entries()]
          .map(([field, ref]) => {
            return `    ${field}: { types: ${JSON.stringify(ref.types)}, multiple: ${ref.multiple}, optional: ${ref.optional} }`;
          })
          .join(",\n");
        return `  ${contentType}: {\n${fieldEntries}\n  }`;
      })
      .join(",\n");

    parts.push(
      `export const referenceMap = {\n${referenceMapEntries}\n} as const;`
    );
  }

  const content = parts.join("\n\n");

  return content;
}

function toBaseSchemaName(contentTypeId: string): string {
  return `_base${toPascalCase(contentTypeId)}`;
}
