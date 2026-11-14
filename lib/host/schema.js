/**
 * JSON Schema helpers for the remote tool surface.
 *
 * `tools.register()` takes a REGISTRY-READY raw JSON Schema — not the authoring
 * shorthand `defineTool()` accepts. The registry runs
 * `assertSupportedJsonSchema()` on `output.schema` and rejects every
 * `required: true` written on a property node
 * (`schema.properties.x.required is not supported on type "string"`), every
 * `required` beside `oneOf`, and every key outside the supported subset.
 *
 * The authoring shorthand compiles `required: true` into an object-level
 * `required: ['a', 'b']` array, which is exactly what the gate expects, and it
 * also wraps a `parameters` map in `{ type: 'object', properties, required }`.
 * This plugin registers directly and cannot import `@deepseek-ai/dsh-tools`
 * (it is not a dependency and does not resolve from the installed package), so
 * both conversions live here.
 *
 * Getting this wrong is silent: `register()` throws, each tool is caught by the
 * caller's per-tool guard, and the result is an agent that kept its LOCAL tools
 * while the system prompt claimed it was working in the cloud.
 *
 * @module dsh-codespace-workspace/host/schema
 */

/** Whether a value is a plain object (not an array, not null). */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Rewrite an authoring-shorthand schema into a registry-ready one.
 *
 * Lifts every `required: true` on a property node into the parent object's
 * `required` string array, recursing through object properties, array items and
 * `oneOf` members. Every other key is preserved verbatim.
 *
 * @param {unknown} schema - the authoring-shorthand schema.
 * @returns {unknown} a registry-ready schema with no property-level `required`.
 */
export function registrySchema(schema) {
  if (!isRecord(schema)) return schema

  const out = { ...schema }

  if (Array.isArray(schema.oneOf)) {
    out.oneOf = schema.oneOf.map((member) => registrySchema(member))
    // A `oneOf` node may not carry `required` at all (the gate reports
    // "required is not supported beside oneOf"), and members are member
    // schemas, not objects, so nothing there can declare one either.
    delete out.required
  }

  if (isRecord(schema.properties)) {
    const properties = {}
    const required = []
    for (const [name, propertySchema] of Object.entries(schema.properties)) {
      if (!isRecord(propertySchema)) {
        properties[name] = propertySchema
        continue
      }
      const { required: wants, ...rest } = propertySchema
      properties[name] = registrySchema(rest)
      if (wants === true) required.push(name)
    }
    out.properties = properties
    // An empty array is legal but the local tools omit it entirely, so match
    // them: a present-but-empty `required` is a difference the model can see.
    if (required.length > 0) out.required = required
    else delete out.required
  }

  if (schema.items !== undefined) out.items = registrySchema(schema.items)

  return out
}

/**
 * Compile an authoring-shorthand `parameters` map into a raw JSON Schema.
 *
 * Mirrors `parameterSchemaSpecToJsonSchema()` from `@deepseek-ai/dsh-tools`:
 * the map becomes `{ type: 'object', properties, required }`, and any
 * side-effect-free property keys (`required`, `description`) are moved where
 * the wire format expects them.
 *
 * @param {unknown} spec - per-property parameter definitions.
 * @returns {{type: 'object', properties: object, required?: string[]}} the compiled schema.
 */
export function parameterSchema(spec) {
  if (!isRecord(spec)) return { type: 'object', properties: {} }
  const properties = {}
  const required = []
  for (const [name, propertySpec] of Object.entries(spec)) {
    if (!isRecord(propertySpec)) {
      properties[name] = propertySpec
      continue
    }
    const { required: wants, ...rest } = propertySpec
    properties[name] = registrySchema(rest)
    if (wants === true) required.push(name)
  }
  return required.length > 0
    ? { type: 'object', properties, required }
    : { type: 'object', properties }
}

/**
 * Normalize one tool definition for `tools.register()`.
 *
 * `output.schema` is validated by the registry, and `parameters` is projected
 * to the model verbatim, so BOTH have to be in wire form before registering.
 *
 * @param {object} definition - the authoring-shorthand definition.
 * @returns {object} a copy safe to hand to `tools.register()`.
 */
export function registryDefinition(definition) {
  return {
    ...definition,
    parameters: parameterSchema(definition.parameters),
    output: {
      ...definition.output,
      schema: registrySchema(definition.output.schema),
    },
  }
}
