export const uuidPattern = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
export const boundedString = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength });
export const objectSchema = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: 'object', properties, required, additionalProperties: false,
});
export const idParams = objectSchema({ id: { type: 'string', pattern: uuidPattern } });
