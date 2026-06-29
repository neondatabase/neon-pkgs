/* eslint-disable @typescript-eslint/no-non-null-asserted-optional-chain */
/* eslint-disable @typescript-eslint/no-non-null-assertion */
import SwaggerParser from '@apidevtools/swagger-parser';
import { createWriteStream } from 'node:fs';
import { OpenAPIV3 } from 'openapi-types';

const EXTRACT_PROPERTIES = [
  'ProjectCreateRequest',
  'ProjectUpdateRequest',
  'BranchCreateRequest',
  'BranchCreateRequestEndpointOptions',
  'BranchUpdateRequest',
  'EndpointCreateRequest',
  'EndpointUpdateRequest',
  'DatabaseCreateRequest',
  'RoleCreateRequest',
];

const typesMapping = {
  array: 'array',
  integer: 'number',
  string: 'string',
  boolean: 'boolean',
} as const;

(async () => {
  // Source the Neon OpenAPI spec from the `@neon/sdk` workspace package, which
  // vendors it under `spec/` (kept in sync via its `spec:pull` script). This
  // replaces the spec that used to ship inside `@neondatabase/api-client`.
  const spec: OpenAPIV3.Document = (await SwaggerParser.dereference(
    '../sdk/spec/neon-openapi.json',
  )) as any;
  const outFile = createWriteStream('./src/parameters.gen.ts', 'utf8');
  outFile.write('// FILE IS GENERATED, DO NOT EDIT\n\n');
  EXTRACT_PROPERTIES.forEach((name) => {
    const schema = spec.components?.schemas?.[name] as OpenAPIV3.SchemaObject;
    const parseProperties = (
      schema: OpenAPIV3.SchemaObject,
      context: string[] = [],
    ) => {
      Object.entries(
        schema.properties as Record<string, OpenAPIV3.SchemaObject>,
      ).forEach(([key, value]) => {
        if (value.type === 'object' && value.properties) {
          parseProperties(value, [...context, key]);
        } else if (value.type! in typesMapping) {
          outFile.write(
            `  '${[...context, key].join('.')}': {
              type: ${JSON.stringify(
                typesMapping[value.type as keyof typeof typesMapping],
              )},
              description: ${JSON.stringify(value.description)},
              demandOption: ${
                schema.required?.includes(key) ? 'true' : 'false'
              },\n`,
          );
          if (value.enum) {
            outFile.write(` choices: ${JSON.stringify(value.enum)},\n`);
          }
          outFile.write('  },\n');
        }
      });
    };
    outFile.write(
      `export const ${name[0].toLowerCase()}${name.slice(1)} = {\n`,
    );
    parseProperties(schema);
    outFile.write(`} as const;\n\n`);
  });
  outFile.end();
})();
