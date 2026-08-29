import { describe, it, expect, vi } from 'vitest'
import { EndpointTool, P } from '../../src/lib/tools/endpoint-tool'
import { ENDPOINT_SPECS } from '../../src/lib/tools/endpoint-specs'
import { LRUCache } from '../../src/lib/cache/lru-cache'
import type { APIFootballClient } from '../../src/lib/api-client/client'

function makeClient (response: unknown[] = [{ ok: true }]) {
  const request = vi.fn().mockResolvedValue({ results: response.length, paging: { current: 1, total: 1 }, response })
  const requestAllPages = vi.fn().mockResolvedValue({ results: response.length, paging: { current: 2, total: 2 }, response })
  return { client: { request, requestAllPages } as unknown as APIFootballClient, request, requestAllPages }
}

const cache = () => new LRUCache({ maxSize: 10, defaultTtl: 1000, checkInterval: 60000 })

describe('EndpointTool', () => {
  it('maps camelCase args to API query names and injects defaults', async () => {
    const { client, request } = makeClient()
    const tool = new EndpointTool({
      name: 'x', description: 'x', endpoint: '/players/topscorers', cache: 'CURRENT',
      params: { leagueId: P.league(), season: P.season(true) }
    }, client, cache())

    const res = await tool.call({ method: 'tools/call', params: { name: 'x', arguments: { season: 2024 } } })
    expect(res.isError).toBeUndefined()
    expect(request).toHaveBeenCalledWith('/players/topscorers', { league: 39, season: 2024 })
  })

  it('reports missing required params without calling the API', async () => {
    const { client, request } = makeClient()
    const tool = new EndpointTool({
      name: 'x', description: 'x', endpoint: '/predictions', cache: 'CURRENT',
      params: { fixtureId: P.num('fixture', 'f', true) }
    }, client, cache())
    const res = await tool.call({ method: 'tools/call', params: { name: 'x', arguments: {} } })
    expect(res.isError).toBe(true)
    expect(request).not.toHaveBeenCalled()
  })

  it('enforces requireOneOf groups', async () => {
    const { client, request } = makeClient()
    const tool = new EndpointTool({
      name: 'x', description: 'x', endpoint: '/transfers', cache: 'PROFILES',
      params: { playerId: P.num('player', 'p'), teamId: P.num('team', 't') },
      requireOneOf: [['playerId'], ['teamId']]
    }, client, cache())
    const bad = await tool.call({ method: 'tools/call', params: { name: 'x', arguments: {} } })
    expect(bad.isError).toBe(true)
    const good = await tool.call({ method: 'tools/call', params: { name: 'x', arguments: { teamId: 40 } } })
    expect(good.isError).toBeUndefined()
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('serves the second identical call from cache', async () => {
    const { client, request } = makeClient()
    const tool = new EndpointTool({
      name: 'x', description: 'x', endpoint: '/timezone', cache: 'HISTORICAL', params: {}
    }, client, cache())
    await tool.call({ method: 'tools/call', params: { name: 'x', arguments: {} } })
    await tool.call({ method: 'tools/call', params: { name: 'x', arguments: {} } })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('uses requestAllPages when paginate is set', async () => {
    const { client, requestAllPages } = makeClient()
    const tool = new EndpointTool({
      name: 'x', description: 'x', endpoint: '/players', cache: 'CURRENT', paginate: true,
      params: { leagueId: P.league(), season: P.season(true) }
    }, client, cache())
    await tool.call({ method: 'tools/call', params: { name: 'x', arguments: { season: 2024 } } })
    expect(requestAllPages).toHaveBeenCalledWith('/players', { league: 39, season: 2024 })
  })

  it('every spec has a unique name and valid JSON schema', () => {
    const names = ENDPOINT_SPECS.map(s => s.name)
    expect(new Set(names).size).toBe(names.length)
    for (const spec of ENDPOINT_SPECS) {
      const tool = new EndpointTool(spec, makeClient().client, cache())
      expect(tool.inputSchema.type).toBe('object')
      for (const arg of spec.requireOneOf?.flat() ?? []) {
        expect(spec.params[arg], `${spec.name}.requireOneOf references unknown arg ${arg}`).toBeDefined()
      }
    }
  })
})
