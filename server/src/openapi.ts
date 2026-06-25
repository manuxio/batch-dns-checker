import { SUPPORTED_RECORD_TYPES } from './types';

/**
 * OpenAPI 3.0 specification for the CONI SVC DNS Checker API. Served as JSON at
 * /api/openapi.json and rendered with Swagger UI at /api/docs.
 */
export const openapiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'CONI SVC DNS Checker API',
    version: '1.0.1',
    description:
      'Verifies that hostnames resolve, on ALL their authoritative nameservers, ' +
      'to the expected record TYPE and VALUE. Checks run as batches; results are ' +
      'grouped by secondary-level domain and can be downloaded. The last 10 ' +
      'batches are retained for consultation.',
  },
  servers: [{ url: '/api', description: 'API base path' }],
  tags: [
    { name: 'Batches', description: 'Create, monitor, stop and inspect batches' },
    { name: 'Export', description: 'Download results and the input template' },
    { name: 'Meta', description: 'Service metadata' },
  ],
  paths: {
    '/health': {
      get: {
        tags: ['Meta'],
        summary: 'Health check',
        responses: {
          '200': {
            description: 'Service is up',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Health' },
              },
            },
          },
        },
      },
    },
    '/record-types': {
      get: {
        tags: ['Meta'],
        summary: 'List supported DNS record types',
        responses: {
          '200': {
            description: 'Supported record types',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    recordTypes: {
                      type: 'array',
                      items: { type: 'string', enum: [...SUPPORTED_RECORD_TYPES] },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/template': {
      get: {
        tags: ['Export'],
        summary: 'Download a demo input template',
        parameters: [
          {
            name: 'format',
            in: 'query',
            schema: { type: 'string', enum: ['xlsx', 'csv'], default: 'xlsx' },
          },
        ],
        responses: {
          '200': {
            description: 'Template file',
            content: {
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
                { schema: { type: 'string', format: 'binary' } },
              'text/csv': { schema: { type: 'string', format: 'binary' } },
            },
          },
        },
      },
    },
    '/batches': {
      get: {
        tags: ['Batches'],
        summary: 'List recent batches (most recent first, max 10)',
        responses: {
          '200': {
            description: 'Batch summaries',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    batches: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/BatchSummary' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      post: {
        tags: ['Batches'],
        summary: 'Upload a file and start a new check batch',
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['file'],
                properties: {
                  file: {
                    type: 'string',
                    format: 'binary',
                    description: 'CSV or XLSX with columns hostname, type, value',
                  },
                  name: {
                    type: 'string',
                    description: 'Optional human-friendly batch name',
                  },
                },
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Batch created and started',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Batch' },
              },
            },
          },
          '400': {
            description: 'Invalid file or no valid rows',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
              },
            },
          },
        },
      },
    },
    '/batches/{id}': {
      get: {
        tags: ['Batches'],
        summary: 'Get a batch with full results',
        parameters: [{ $ref: '#/components/parameters/BatchId' }],
        responses: {
          '200': {
            description: 'Full batch',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Batch' },
              },
            },
          },
          '404': { description: 'Batch not found' },
        },
      },
      delete: {
        tags: ['Batches'],
        summary: 'Delete a batch',
        parameters: [{ $ref: '#/components/parameters/BatchId' }],
        responses: {
          '204': { description: 'Deleted' },
          '404': { description: 'Batch not found' },
        },
      },
    },
    '/batches/{id}/status': {
      get: {
        tags: ['Batches'],
        summary: 'Lightweight progress for polling',
        parameters: [{ $ref: '#/components/parameters/BatchId' }],
        responses: {
          '200': {
            description: 'Progress',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/BatchStatus' },
              },
            },
          },
          '404': { description: 'Batch not found' },
        },
      },
    },
    '/batches/{id}/groups': {
      get: {
        tags: ['Batches'],
        summary: 'Results grouped by secondary-level domain',
        parameters: [{ $ref: '#/components/parameters/BatchId' }],
        responses: {
          '200': {
            description: 'Grouped results',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    groups: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/DomainGroup' },
                    },
                  },
                },
              },
            },
          },
          '404': { description: 'Batch not found' },
        },
      },
    },
    '/batches/{id}/rerun': {
      post: {
        tags: ['Batches'],
        summary: 'Re-run a batch (clones its rows into a new, duplicated batch)',
        parameters: [{ $ref: '#/components/parameters/BatchId' }],
        responses: {
          '201': {
            description: 'New batch created and started',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Batch' },
              },
            },
          },
          '404': { description: 'Source batch not found' },
        },
      },
    },
    '/check': {
      post: {
        tags: ['Batches'],
        summary: 'Verify a single record synchronously (no persistence)',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['hostname', 'type', 'value'],
                properties: {
                  hostname: { type: 'string', example: 'example.it' },
                  type: { type: 'string', enum: [...SUPPORTED_RECORD_TYPES] },
                  value: {
                    type: 'string',
                    example: 'ns1.example.it & ns2.example.it',
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Single host result',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/HostResult' },
              },
            },
          },
          '400': {
            description: 'Invalid input',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
              },
            },
          },
        },
      },
    },
    '/batches/{id}/stop': {
      post: {
        tags: ['Batches'],
        summary: 'Request cancellation of a running batch',
        parameters: [{ $ref: '#/components/parameters/BatchId' }],
        responses: {
          '202': { description: 'Stop requested' },
          '404': { description: 'No running batch with that id' },
        },
      },
    },
    '/batches/{id}/export': {
      get: {
        tags: ['Export'],
        summary: 'Download batch results',
        parameters: [
          { $ref: '#/components/parameters/BatchId' },
          {
            name: 'format',
            in: 'query',
            schema: { type: 'string', enum: ['xlsx', 'csv'], default: 'xlsx' },
          },
        ],
        responses: {
          '200': {
            description: 'Result file (includes authoritative NS queried)',
            content: {
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
                { schema: { type: 'string', format: 'binary' } },
              'text/csv': { schema: { type: 'string', format: 'binary' } },
            },
          },
          '404': { description: 'Batch not found' },
        },
      },
    },
  },
  components: {
    parameters: {
      BatchId: {
        name: 'id',
        in: 'path',
        required: true,
        schema: { type: 'string', format: 'uuid' },
      },
    },
    schemas: {
      Health: {
        type: 'object',
        properties: {
          status: { type: 'string', example: 'ok' },
          name: { type: 'string', example: 'CONI SVC DNS Checker' },
          version: { type: 'string' },
        },
      },
      Error: {
        type: 'object',
        properties: {
          error: { type: 'string' },
          details: { type: 'object', additionalProperties: true },
        },
      },
      BatchCounts: {
        type: 'object',
        properties: {
          ok: { type: 'integer' },
          warning: { type: 'integer' },
          error: { type: 'integer' },
          cancelled: { type: 'integer' },
        },
      },
      BatchStatus: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          status: {
            type: 'string',
            enum: [
              'pending',
              'running',
              'completed',
              'stopped',
              'interrupted',
              'error',
            ],
          },
          total: { type: 'integer' },
          completed: { type: 'integer' },
          counts: { $ref: '#/components/schemas/BatchCounts' },
        },
      },
      BatchSummary: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string', nullable: true },
          fileName: { type: 'string', nullable: true },
          status: { type: 'string' },
          total: { type: 'integer' },
          completed: { type: 'integer' },
          counts: { $ref: '#/components/schemas/BatchCounts' },
          invalidCount: { type: 'integer' },
          createdAt: { type: 'string', format: 'date-time' },
          startedAt: { type: 'string', format: 'date-time', nullable: true },
          finishedAt: { type: 'string', format: 'date-time', nullable: true },
        },
      },
      NsAnswer: {
        type: 'object',
        properties: {
          nsName: { type: 'string' },
          nsIp: { type: 'string', nullable: true },
          status: {
            type: 'string',
            enum: ['ok', 'mismatch', 'error', 'timeout'],
          },
          returnedValues: { type: 'array', items: { type: 'string' } },
          extraValues: { type: 'array', items: { type: 'string' } },
          error: { type: 'string' },
        },
      },
      HostResult: {
        type: 'object',
        properties: {
          hostname: { type: 'string' },
          queryName: {
            type: 'string',
            description:
              'Actual FQDN queried (differs for policy types, e.g. _dmarc.<host>)',
          },
          registrableDomain: { type: 'string' },
          type: { type: 'string', enum: [...SUPPORTED_RECORD_TYPES] },
          expectedValue: {
            type: 'string',
            description:
              "Compound values: 'a & b' = both required; 'a | b' = at least one, " +
              'and only listed values allowed.',
          },
          matchMode: { type: 'string', enum: ['single', 'all', 'any'] },
          zone: { type: 'string', nullable: true },
          authoritativeNameservers: {
            type: 'array',
            items: { type: 'string' },
          },
          nsAnswers: {
            type: 'array',
            items: { $ref: '#/components/schemas/NsAnswer' },
          },
          status: {
            type: 'string',
            enum: ['pending', 'ok', 'warning', 'error', 'cancelled'],
          },
          warnings: { type: 'array', items: { type: 'string' } },
          message: { type: 'string' },
        },
      },
      DomainGroup: {
        type: 'object',
        properties: {
          domain: { type: 'string' },
          total: { type: 'integer' },
          counts: { $ref: '#/components/schemas/BatchCounts' },
          results: {
            type: 'array',
            items: { $ref: '#/components/schemas/HostResult' },
          },
        },
      },
      Batch: {
        allOf: [
          { $ref: '#/components/schemas/BatchSummary' },
          {
            type: 'object',
            properties: {
              results: {
                type: 'array',
                items: { $ref: '#/components/schemas/HostResult' },
              },
              invalidRows: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    rowNumber: { type: 'integer' },
                    error: { type: 'string' },
                    raw: { type: 'object', additionalProperties: true },
                  },
                },
              },
            },
          },
        ],
      },
    },
  },
} as const;
