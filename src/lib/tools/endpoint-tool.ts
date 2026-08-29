import { CallToolRequest, CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import { APIFootballClient } from '../api-client/client'
import { LRUCache } from '../cache/lru-cache'
import { generateCacheKey } from '../cache/keys'
import { CACHE_POLICIES, CachePolicyName } from '../cache/policies'
import { getToolArguments } from './params'
import { logger } from '../logger/logger'
import { PREMIER_LEAGUE_ID } from '../api-client/endpoints'

export type ParamType = 'number' | 'string' | 'boolean'

export interface EndpointParamSpec {
  /** Query-string name expected by API-Football (e.g. "league", "fixture") */
  apiName: string
  type: ParamType
  description: string
  required?: boolean
  enum?: readonly string[]
  /** Static default injected when the caller omits the value */
  default?: number | string | boolean
}

export interface EndpointToolSpec {
  name: string
  description: string
  /** API path, e.g. "/fixtures/headtohead" */
  endpoint: string
  /** Tool argument name -> spec. Tool argument names are camelCase. */
  params: Record<string, EndpointParamSpec>
  cache: CachePolicyName
  /** Aggregate every page of a paginated endpoint */
  paginate?: boolean
  /** API-Football requires at least one of these argument groups */
  requireOneOf?: readonly (readonly string[])[]
  /** Raise an explicit error when none of the listed args is present */
  hint?: string
}

/** Shorthand builders used by endpoint-specs.ts */
export const P = {
  league: (required = false): EndpointParamSpec => ({
    apiName: 'league', type: 'number', required, default: PREMIER_LEAGUE_ID,
    description: `League ID (defaults to ${PREMIER_LEAGUE_ID} = Premier League)`
  }),
  season: (required = false): EndpointParamSpec => ({
    apiName: 'season', type: 'number', required,
    description: 'Season year (YYYY, e.g. 2024 for 2024-25)'
  }),
  num: (apiName: string, description: string, required = false): EndpointParamSpec => ({
    apiName, type: 'number', description, required
  }),
  str: (apiName: string, description: string, required = false, enumValues?: readonly string[]): EndpointParamSpec => {
    const spec: EndpointParamSpec = { apiName, type: 'string', description, required }
    if (enumValues) spec.enum = enumValues
    return spec
  },
  bool: (apiName: string, description: string): EndpointParamSpec => ({
    apiName, type: 'boolean', description
  })
}

export class EndpointTool implements Tool {
  [key: string]: unknown
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, { type: ParamType; description: string; enum?: readonly string[] }>
    required?: string[]
  }

  constructor (
    private spec: EndpointToolSpec,
    private apiClient: APIFootballClient,
    private cache: LRUCache
  ) {
    this.name = spec.name
    this.description = spec.description

    const properties: Record<string, { type: ParamType; description: string; enum?: readonly string[] }> = {}
    const required: string[] = []
    for (const [arg, p] of Object.entries(spec.params)) {
      properties[arg] = p.enum
        ? { type: p.type, description: p.description, enum: p.enum }
        : { type: p.type, description: p.description }
      if (p.required) required.push(arg)
    }
    this.inputSchema = required.length > 0
      ? { type: 'object', properties, required }
      : { type: 'object', properties }
  }

  async call (request: CallToolRequest): Promise<CallToolResult> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-arguments
      const args = getToolArguments<Record<string, unknown>>(request)
      const query: Record<string, string | number | boolean | undefined> = {}
      const missing: string[] = []

      for (const [arg, p] of Object.entries(this.spec.params)) {
        let value = args[arg]
        if ((value === undefined || value === null || value === '') && p.default !== undefined) {
          value = p.default
        }
        if (value === undefined || value === null || value === '') {
          if (p.required) missing.push(arg)
          continue
        }
        if (p.type === 'number' && typeof value !== 'number') {
          const n = Number(value)
          if (Number.isNaN(n)) return this.error(`Parameter "${arg}" must be a number`)
          value = n
        }
        if (p.enum && !p.enum.includes(String(value))) {
          return this.error(`Parameter "${arg}" must be one of: ${p.enum.join(', ')}`)
        }
        query[p.apiName] = value as string | number | boolean
      }

      if (missing.length > 0) {
        return this.error(`Missing required parameter(s): ${missing.join(', ')}`)
      }

      if (this.spec.requireOneOf) {
        const ok = this.spec.requireOneOf.some(group =>
          group.every(arg => {
            const p = this.spec.params[arg]
            return p !== undefined && query[p.apiName] !== undefined
          })
        )
        if (!ok) {
          const groups = this.spec.requireOneOf.map(g => g.join(' + ')).join(' | ')
          return this.error(`${this.name} requires one of: ${groups}${this.spec.hint ? `. ${this.spec.hint}` : ''}`)
        }
      }

      const cacheKey = generateCacheKey(this.name, query)
      const cached = this.cache.get(cacheKey)
      if (cached) {
        return { content: [{ type: 'text', text: JSON.stringify(cached, null, 2) }] }
      }

      const apiResponse = this.spec.paginate
        ? await this.apiClient.requestAllPages(this.spec.endpoint, query)
        : await this.apiClient.request(this.spec.endpoint, query)

      const result = {
        endpoint: this.spec.endpoint,
        parameters: query,
        results: apiResponse.results,
        paging: apiResponse.paging,
        response: apiResponse.response
      }

      const policy = CACHE_POLICIES[this.spec.cache]
      this.cache.set(cacheKey, result, policy.ttl)

      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    } catch (error) {
      logger.error(`Error in ${this.name}`, error as Error)
      return this.error(error instanceof Error ? error.message : 'Unknown error')
    }
  }

  private error (message: string): CallToolResult {
    return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true }
  }
}
