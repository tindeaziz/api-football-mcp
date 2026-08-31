#!/usr/bin/env node
/**
 * Matchday 360° report — API-Football v3
 *
 * Usage:
 *   node scripts/matchday-report.mjs [--date YYYY-MM-DD] [--seasons 4] [--leagues 39,61,135,140]
 *                                    [--bookmaker 8] [--out reports/] [--refresh]
 *
 * Env: API_FOOTBALL_KEY (required)
 *
 * For every fixture of the day in the selected leagues, the script pulls:
 *   predictions, odds (1N2 / over-under / BTTS), injuries, head-to-head,
 *   lineups (if published), team statistics over N seasons for both clubs.
 * It fits a weighted Poisson model, compares model probabilities with the
 * bookmaker's implied probabilities (margin removed) and ranks fixtures by
 * the largest gap ("edge"). Output: one self-contained HTML page.
 *
 * All raw API responses are cached on disk under .cache/report/ so a re-run
 * on the same day costs almost no API calls. --refresh ignores the cache.
 *
 * If ANTHROPIC_API_KEY is set, each match is also sent to Claude with the
 * numbers above and a fixed set of reading rules; the returned French
 * analysis (verdict, main pick, alternative, what to avoid, reasoning) and a
 * day synthesis are embedded in the page. --no-llm skips this step.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ----------------------------------------------------------------- config

const BASE = process.env.API_BASE_URL ?? 'https://v3.football.api-sports.io'
const KEY = process.env.API_FOOTBALL_KEY
const PACE_MS = Number(process.env.API_PACE_MS ?? 250) // Pro plan: 300 req/min
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY
const ANALYSIS_MODEL = process.env.ANALYSIS_MODEL ?? (ANTHROPIC_KEY ? 'claude-sonnet-5' : 'deepseek-chat')
const PROVIDER = ANALYSIS_MODEL.toLowerCase().startsWith('deepseek') ? 'deepseek' : 'anthropic'
const LLM_KEY = PROVIDER === 'deepseek' ? DEEPSEEK_KEY : ANTHROPIC_KEY

export const LEAGUES = {
  39: { name: 'Premier League', country: 'England', avgHome: 1.55, avgAway: 1.35 },
  61: { name: 'Ligue 1', country: 'France', avgHome: 1.50, avgAway: 1.25 },
  135: { name: 'Serie A', country: 'Italy', avgHome: 1.45, avgAway: 1.25 },
  140: { name: 'La Liga', country: 'Spain', avgHome: 1.45, avgAway: 1.20 },
  78: { name: 'Bundesliga', country: 'Germany', avgHome: 1.75, avgAway: 1.45 },
  88: { name: 'Eredivisie', country: 'Netherlands', avgHome: 1.75, avgAway: 1.40 },
  40: { name: 'Championship', country: 'England', avgHome: 1.45, avgAway: 1.20 },
  62: { name: 'Ligue 2', country: 'France', avgHome: 1.35, avgAway: 1.10 },
  43: { name: 'National League', country: 'England', avgHome: 1.45, avgAway: 1.20 },
  2: { name: 'Champions League', country: 'Europe', avgHome: 1.65, avgAway: 1.35, cup: true },
  3: { name: 'Europa League', country: 'Europe', avgHome: 1.55, avgAway: 1.30, cup: true }
}
// avgHome/avgAway = typical goals per match for home/away sides in that league
// (used to normalise attack/defence strengths). Adjust if you prefer to derive
// them from data — see leagueAverages() below for a data-driven override.

const SEASON_WEIGHTS = [1.0, 0.6, 0.35, 0.2, 0.1] // most recent complete season first
const EDGE_FLAG = 0.05 // 5 points of probability = worth a look

// ------------------------------------------------------------------- args

function parseArgs (argv) {
  const args = { seasons: 4, leagues: Object.keys(LEAGUES).map(Number), bookmaker: 8, out: 'reports', refresh: false, llm: true }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === '--date') args.date = next()
    else if (a === '--seasons') args.seasons = Number(next())
    else if (a === '--leagues') args.leagues = next().split(',').map(Number)
    else if (a === '--bookmaker') args.bookmaker = Number(next())
    else if (a === '--out') args.out = next()
    else if (a === '--refresh') args.refresh = true
    else if (a === '--no-llm') args.llm = false
  }
  if (!args.date) {
    const d = new Date(); d.setUTCDate(d.getUTCDate() + 1)
    args.date = d.toISOString().slice(0, 10)
  }
  return args
}

export function currentSeason (date = new Date()) {
  return date.getUTCMonth() >= 6 ? date.getUTCFullYear() : date.getUTCFullYear() - 1 // July switch
}

// ------------------------------------------------------------------ client

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
let lastCall = 0
const cacheDir = path.join(process.cwd(), '.cache', 'report')

async function api (endpoint, params, { ttlMs, refresh } = {}) {
  const url = new URL(BASE + endpoint)
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null) url.searchParams.set(k, String(v)) })
  const key = createHash('sha1').update(url.toString()).digest('hex').slice(0, 20)
  const file = path.join(cacheDir, `${key}.json`)

  if (!refresh && existsSync(file)) {
    const cached = JSON.parse(await readFile(file, 'utf8'))
    if (!ttlMs || Date.now() - cached.at < ttlMs) return cached.data
  }

  let json
  for (let attempt = 1; attempt <= 3; attempt++) {
    const wait = PACE_MS - (Date.now() - lastCall)
    if (wait > 0) await sleep(wait)
    lastCall = Date.now()
    try {
      const res = await fetch(url, { headers: { 'x-apisports-key': KEY } })
      json = await res.json()
      break
    } catch (err) {
      const cause = err.cause?.code ?? err.message
      if (attempt === 3) throw new Error(`network error on ${endpoint} (${cause})`)
      await sleep(1500 * attempt)
    }
  }
  const errs = json.errors
  if (errs && (Array.isArray(errs) ? errs.length : Object.keys(errs).length)) {
    throw new Error(`${endpoint} ${JSON.stringify(params)} → ${JSON.stringify(errs)}`)
  }
  await mkdir(cacheDir, { recursive: true })
  await writeFile(file, JSON.stringify({ at: Date.now(), data: json.response }))
  return json.response
}

const HOUR = 3600_000
const DAY = 24 * HOUR

// ----------------------------------------------------------------- fetching

async function collectFixture (fx, args) {
  const id = fx.fixture.id
  const league = fx.league.id
  const home = fx.teams.home.id
  const away = fx.teams.away.id
  const opts = { refresh: args.refresh }

  const [prediction, oddsRaw, injuries, h2h, lineups] = await Promise.all([
    api('/predictions', { fixture: id }, { ttlMs: 6 * HOUR, ...opts }).then(r => r[0] ?? null).catch(e => ({ error: e.message })),
    api('/odds', { fixture: id, bookmaker: args.bookmaker }, { ttlMs: 2 * HOUR, ...opts }).then(r => r[0] ?? null).catch(e => ({ error: e.message })),
    api('/injuries', { fixture: id }, { ttlMs: 6 * HOUR, ...opts }).catch(() => []),
    api('/fixtures/headtohead', { h2h: `${home}-${away}`, last: 10 }, { ttlMs: DAY, ...opts }).catch(() => []),
    api('/fixtures/lineups', { fixture: id }, { ttlMs: HOUR, ...opts }).catch(() => [])
  ])

  const season = currentSeason(new Date(fx.fixture.date))
  const seasons = Array.from({ length: args.seasons + 1 }, (_, i) => season - i) // current + N complete
  const stats = {}
  const context = {}
  for (const team of [home, away]) {
    stats[team] = {}
    for (const s of seasons) {
      const ttl = s < season ? 30 * DAY : 6 * HOUR
      // For cup fixtures a team's per-cup history is sparse (few matches, not every season);
      // the thin-data fallback and the last-6 xG blend carry most of the weight there.
      stats[team][s] = await api('/teams/statistics', { league, season: s, team }, { ttlMs: ttl, ...opts }).catch(() => null)
    }
    context[team] = await collectTeamContext(team, season, opts)
  }

  // League-level context, cached across fixtures of the same league
  const standings = await api('/standings', { league, season }, { ttlMs: 6 * HOUR, ...opts })
    .then(r => r[0]?.league?.standings?.flat() ?? []).catch(() => [])
  const topScorers = await api('/players/topscorers', { league, season: season - 1 }, { ttlMs: 30 * DAY, ...opts }).catch(() => [])

  return { fixture: fx, prediction, odds: oddsRaw, injuries, h2h, lineups, stats, seasons, context, standings, topScorers }
}

/** Recent matches with xG, summer transfers and current coach for one team. */
const isFriendly = (f) => /friendl|amical|club friendlies|pre-season/i.test(f.league?.name ?? '') || f.league?.id === 667

async function collectTeamContext (team, season, opts) {
  // Ask for 10, keep the last 6 competitive ones (pre-season friendlies inflate xG and goals)
  const recentList = await api('/fixtures', { team, last: 10 }, { ttlMs: 6 * HOUR, ...opts })
    .then(r => r.filter(f => !isFriendly(f)).slice(0, 6)).catch(() => [])
  const ids = recentList.map(f => f.fixture.id)
  const recent = ids.length
    ? await api('/fixtures', { ids: ids.join('-') }, { ttlMs: 6 * HOUR, ...opts }).catch(() => recentList)
    : []
  const transfers = await api('/transfers', { team }, { ttlMs: DAY, ...opts }).then(r => r ?? []).catch(() => [])
  const coach = await api('/coachs', { team }, { ttlMs: DAY, ...opts }).then(r => r ?? []).catch(() => [])
  const squad = await api('/players/squads', { team }, { ttlMs: DAY, ...opts }).then(r => r?.[0]?.players ?? []).catch(() => [])
  return { recent, transfers, coach, squad, season }
}

// -------------------------------------------------------------------- model

const num = (v) => (v === null || v === undefined ? 0 : Number(v))

function rates (teamStats, side) {
  // side = 'home' | 'away' ; returns { att, def, played }
  if (!teamStats?.fixtures) return null
  const played = num(teamStats.fixtures.played[side])
  if (!played) return null
  return {
    att: num(teamStats.goals.for.total[side]) / played,
    def: num(teamStats.goals.against.total[side]) / played,
    played
  }
}

function weightedRates (perSeason, seasons, side) {
  // seasons[0] = current (partial). Weight it by games played (max 1 at 10 games),
  // then complete seasons with SEASON_WEIGHTS.
  let att = 0; let def = 0; let w = 0
  seasons.forEach((s, i) => {
    const r = rates(perSeason[s], side)
    if (!r) return
    const weight = i === 0 ? Math.min(1, r.played / 10) : (SEASON_WEIGHTS[i - 1] ?? 0.05)
    att += r.att * weight; def += r.def * weight; w += weight
  })
  return w ? { att: att / w, def: def / w, weight: w } : null
}

function poisson (l, k) { let f = 1; for (let i = 2; i <= k; i++) f *= i; return Math.exp(-l) * l ** k / f }

const RECENT_XG_WEIGHT = 0.3 // share of the strength taken from last-6 xG (venue-agnostic)
const MIN_DATA_WEIGHT = 1.0 // below this, blend toward a generic promoted-side profile

function promotedProfile (side, lg) {
  // A typical newly promoted side: scores ~15% below and concedes ~25% above the league average
  return side === 'home'
    ? { att: lg.avgHome * 0.85, def: lg.avgAway * 1.25, weight: 0 }
    : { att: lg.avgAway * 0.85, def: lg.avgHome * 1.25, weight: 0 }
}

function withFallback (base, side, lg) {
  const fallback = promotedProfile(side, lg)
  if (!base) return { ...fallback, fallback: 'no history in this division — generic promoted profile used' }
  if (base.weight >= MIN_DATA_WEIGHT) return base
  const w = base.weight / MIN_DATA_WEIGHT // 0..1 share of real data
  return {
    att: base.att * w + fallback.att * (1 - w),
    def: base.def * w + fallback.def * (1 - w),
    weight: base.weight,
    fallback: `thin history (weight ${base.weight.toFixed(2)}) — blended ${Math.round((1 - w) * 100)}% with a generic promoted profile`
  }
}

function blendRecent (base, recent, side, lg) {
  // recent: { xgFor, xgAgainst } per match over the last 6 games, any venue.
  // Convert venue-agnostic xG rates into the venue frame of the historical rates.
  if (!base || !recent || recent.matches < 3 || recent.xgFor == null) return base
  const leagueAvg = (lg.avgHome + lg.avgAway) / 2
  const venueAvgFor = side === 'home' ? lg.avgHome : lg.avgAway
  const venueAvgAgainst = side === 'home' ? lg.avgAway : lg.avgHome
  const att = recent.xgFor / leagueAvg * venueAvgFor
  const def = recent.xgAgainst / leagueAvg * venueAvgAgainst
  return {
    att: base.att * (1 - RECENT_XG_WEIGHT) + att * RECENT_XG_WEIGHT,
    def: base.def * (1 - RECENT_XG_WEIGHT) + def * RECENT_XG_WEIGHT,
    weight: base.weight,
    recentBlended: true
  }
}

export function fitModel (data) {
  const { fixture, stats, seasons, context } = data
  const lg = LEAGUES[fixture.league.id] ?? { avgHome: 1.5, avgAway: 1.3 }
  const home = fixture.teams.home.id; const away = fixture.teams.away.id
  let H = withFallback(weightedRates(stats[home], seasons, 'home'), 'home', lg)
  let A = withFallback(weightedRates(stats[away], seasons, 'away'), 'away', lg)
  const rh = recentForm(context?.[home]?.recent ?? [], home)
  const ra = recentForm(context?.[away]?.recent ?? [], away)
  H = blendRecent(H, rh, 'home', lg)
  A = blendRecent(A, ra, 'away', lg)

  const lambdaHome = (H.att / lg.avgHome) * (A.def / lg.avgAway) * lg.avgHome
  const lambdaAway = (A.att / lg.avgAway) * (H.def / lg.avgHome) * lg.avgAway

  const grid = []
  let pH = 0; let pD = 0; let pA = 0; let over25 = 0; let btts = 0
  for (let i = 0; i <= 7; i++) {
    for (let j = 0; j <= 7; j++) {
      const p = poisson(lambdaHome, i) * poisson(lambdaAway, j)
      grid.push({ h: i, a: j, p })
      if (i > j) pH += p; else if (i === j) pD += p; else pA += p
      if (i + j > 2) over25 += p
      if (i > 0 && j > 0) btts += p
    }
  }
  grid.sort((x, y) => y.p - x.p)
  return {
    lambdaHome, lambdaAway,
    probs: { home: pH, draw: pD, away: pA, over25, under25: 1 - over25, btts, noBtts: 1 - btts },
    topScores: grid.slice(0, 5),
    strengths: { home: H, away: A }
  }
}

// -------------------------------------------------------------------- odds

function implied (values, { overlapping = false } = {}) {
  // values: [{value, odd}] -> normalised probabilities (margin removed) + raw odds.
  // Double-chance outcomes overlap (they sum to ~2), so their margin is removed per-outcome
  // using the same factor as a fair 3-way book instead of renormalising to 1.
  const raw = values.map(v => ({ label: v.value, odd: Number(v.odd), p: 1 / Number(v.odd) }))
  const sum = raw.reduce((s, r) => s + r.p, 0)
  const target = overlapping ? 2 : 1
  return { margin: sum - target, items: raw.map(r => ({ ...r, p: r.p / (sum / target) })) }
}

export function marketView (oddsRaw) {
  if (!oddsRaw?.bookmakers?.[0]) return null
  const bets = oddsRaw.bookmakers[0].bets
  const find = (name) => bets.find(b => b.name === name)
  const out = { bookmaker: oddsRaw.bookmakers[0].name, updated: oddsRaw.update }
  const mw = find('Match Winner')
  if (mw) out.matchWinner = implied(mw.values)
  const ou = find('Goals Over/Under')
  if (ou) {
    const pair = ou.values.filter(v => v.value === 'Over 2.5' || v.value === 'Under 2.5')
    if (pair.length === 2) out.over25 = implied(pair)
  }
  const bt = find('Both Teams Score')
  if (bt) out.btts = implied(bt.values)
  const dc = find('Double Chance')
  if (dc) out.doubleChance = implied(dc.values, { overlapping: true })
  return out
}

export function edges (model, market) {
  if (!model || !market) return []
  const rows = []
  const push = (label, modelP, item) => {
    if (!item) return
    rows.push({ label, model: modelP, market: item.p, odd: item.odd, edge: modelP - item.p, ev: modelP * item.odd - 1 })
  }
  const mw = market.matchWinner?.items ?? []
  push('Home win', model.probs.home, mw.find(i => i.label === 'Home'))
  push('Draw', model.probs.draw, mw.find(i => i.label === 'Draw'))
  push('Away win', model.probs.away, mw.find(i => i.label === 'Away'))
  const ou = market.over25?.items ?? []
  push('Over 2.5', model.probs.over25, ou.find(i => i.label === 'Over 2.5'))
  push('Under 2.5', model.probs.under25, ou.find(i => i.label === 'Under 2.5'))
  const bt = market.btts?.items ?? []
  push('Both teams score', model.probs.btts, bt.find(i => i.label === 'Yes'))
  push('Not both score', model.probs.noBtts, bt.find(i => i.label === 'No'))
  const dc = market.doubleChance?.items ?? []
  push('Home or draw (1X)', model.probs.home + model.probs.draw, dc.find(i => /home\/draw|1x/i.test(i.label)))
  push('Draw or away (X2)', model.probs.draw + model.probs.away, dc.find(i => /draw\/away|x2/i.test(i.label)))
  push('Home or away (12)', model.probs.home + model.probs.away, dc.find(i => /home\/away|^12$/i.test(i.label)))
  return rows.sort((a, b) => b.edge - a.edge)
}

// ---------------------------------------------------------------- summarise

function seasonTable (perSeason, seasons) {
  return seasons.map(s => {
    const t = perSeason[s]
    if (!t?.fixtures) return { season: s, played: 0 }
    const f = t.fixtures
    return {
      season: s, played: f.played.total, w: f.wins.total, d: f.draws.total, l: f.loses.total,
      gf: t.goals.for.total.total, ga: t.goals.against.total.total,
      homeRecord: `${f.wins.home}-${f.draws.home}-${f.loses.home}`,
      awayRecord: `${f.wins.away}-${f.draws.away}-${f.loses.away}`,
      cleanSheets: t.clean_sheet?.total, failedToScore: t.failed_to_score?.total,
      form: (t.form ?? '').slice(-10),
      formation: t.lineups?.[0]?.formation
    }
  })
}

function h2hSummary (h2h, homeId) {
  const done = h2h.filter(m => m.fixture.status.short === 'FT')
  const rec = { homeTeamWins: 0, draws: 0, awayTeamWins: 0, goals: 0, matches: [] }
  for (const m of done) {
    const hg = m.goals.home; const ag = m.goals.away
    const homeTeamIsHome = m.teams.home.id === homeId
    const homeTeamGoals = homeTeamIsHome ? hg : ag; const otherGoals = homeTeamIsHome ? ag : hg
    if (homeTeamGoals > otherGoals) rec.homeTeamWins++; else if (homeTeamGoals === otherGoals) rec.draws++; else rec.awayTeamWins++
    rec.goals += hg + ag
    rec.matches.push({ date: m.fixture.date.slice(0, 10), comp: m.league.name, home: m.teams.home.name, away: m.teams.away.name, score: `${hg}-${ag}` })
  }
  rec.avgGoals = done.length ? rec.goals / done.length : null
  return rec
}

const statOf = (block, type) => {
  const v = block?.statistics?.find(x => x.type === type)?.value
  if (v === null || v === undefined || v === '') return null
  return typeof v === 'string' && v.endsWith('%') ? Number(v.slice(0, -1)) : Number(v)
}

export function recentForm (fixtures, teamId) {
  const done = fixtures.filter(f => f.fixture?.status?.short === 'FT' || f.fixture?.status?.short === 'AET' || f.fixture?.status?.short === 'PEN')
    .sort((a, b) => new Date(b.fixture.date) - new Date(a.fixture.date))
  const rows = []
  let xgFor = 0; let xgAgainst = 0; let xgCount = 0; let gf = 0; let ga = 0; let pts = 0
  for (const f of done) {
    const isHome = f.teams.home.id === teamId
    const goalsFor = isHome ? f.goals.home : f.goals.away
    const goalsAgainst = isHome ? f.goals.away : f.goals.home
    const mine = f.statistics?.find(s => s.team.id === teamId)
    const theirs = f.statistics?.find(s => s.team.id !== teamId)
    const xgF = statOf(mine, 'expected_goals'); const xgA = statOf(theirs, 'expected_goals')
    if (xgF !== null && xgA !== null) { xgFor += xgF; xgAgainst += xgA; xgCount++ }
    gf += goalsFor; ga += goalsAgainst
    const result = goalsFor > goalsAgainst ? 'W' : goalsFor === goalsAgainst ? 'D' : 'L'
    pts += result === 'W' ? 3 : result === 'D' ? 1 : 0
    rows.push({
      date: f.fixture.date.slice(0, 10), comp: f.league.name, venue: isHome ? 'H' : 'A',
      opponent: isHome ? f.teams.away.name : f.teams.home.name, score: `${goalsFor}-${goalsAgainst}`, result,
      xg: xgF !== null ? `${xgF.toFixed(2)} – ${xgA.toFixed(2)}` : null,
      shotsOnTarget: statOf(mine, 'Shots on Goal'), possession: statOf(mine, 'Ball Possession')
    })
  }
  const n = done.length
  return {
    matches: n, form: rows.map(r => r.result).join(''), pointsPerGame: n ? +(pts / n).toFixed(2) : null,
    goalsFor: n ? +(gf / n).toFixed(2) : null, goalsAgainst: n ? +(ga / n).toFixed(2) : null,
    xgFor: xgCount ? +(xgFor / xgCount).toFixed(2) : null, xgAgainst: xgCount ? +(xgAgainst / xgCount).toFixed(2) : null,
    xgMatches: xgCount, rows
  }
}

function transferSummary (transfersRaw, teamId, season, squad = []) {
  // API returns [{ player, transfers: [{date, type, teams:{in,out}}] }]. It also lists loan
  // returns, youth moves and "N/A" entries, so an arrival only counts when the player is in
  // today's official squad; departures only when he is not.
  const since = new Date(`${season}-06-01`)
  const inSquad = new Set(squad.map(p => p.id))
  const arrivals = []; const departures = []
  for (const p of transfersRaw ?? []) {
    for (const t of p.transfers ?? []) {
      const d = new Date(t.date)
      if (Number.isNaN(d) || d < since) continue
      const type = t.type ?? ''
      if (/^n\/a$/i.test(type)) continue
      const entry = { player: p.player?.name, date: t.date, type, from: t.teams?.out?.name, to: t.teams?.in?.name }
      if (t.teams?.in?.id === teamId && inSquad.has(p.player?.id)) arrivals.push(entry)
      else if (t.teams?.out?.id === teamId && !inSquad.has(p.player?.id)) departures.push(entry)
    }
  }
  const permanent = (l) => l.filter(e => !/loan|prêt|return/i.test(e.type)).length
  const squadSize = squad.length || null
  const pa = permanent(arrivals)
  return {
    arrivals: arrivals.length, departures: departures.length, permanentArrivals: pa, squadSize,
    turnover: squadSize ? +(pa / squadSize).toFixed(2) : null,
    list: [...arrivals, ...departures].slice(0, 12)
  }
}

function coachSummary (coachRaw, teamId, matchDate) {
  let best = null
  for (const c of coachRaw ?? []) {
    for (const spell of c.career ?? []) {
      if (spell.team?.id !== teamId || spell.end) continue
      const start = spell.start ? new Date(spell.start) : null
      if (!best || (start && (!best.start || start > best.start))) best = { name: c.name, start }
    }
  }
  if (!best) {
    const c = (coachRaw ?? []).find(x => x.team?.id === teamId)
    if (!c) return null
    return { name: c.name, since: null, daysInCharge: null, isNew: false, uncertain: true }
  }
  const days = best.start ? Math.round((new Date(matchDate) - best.start) / DAY) : null
  const since = best.start?.toISOString().slice(0, 10) ?? null
  // API-Football dates intersaison appointments to July 1st: the day count is then nominal
  const nominal = since !== null && /-07-01$/.test(since)
  return { name: best.name, since, daysInCharge: days, isNew: days !== null && days < 90, appointedThisSummer: nominal && days !== null && days < 120 }
}

function standingSummary (standings, teamId) {
  const row = (standings ?? []).find(r => r.team?.id === teamId)
  if (!row) return null
  return { rank: row.rank, points: row.points, played: row.all?.played, form: row.form, goalsDiff: row.goalsDiff, description: row.description }
}

function keyPlayerAbsences (topScorers, injuries, teamId) {
  // Top scorers of the previous season for this team, crossed with today's absences
  const mine = (topScorers ?? []).filter(p => p.statistics?.[0]?.team?.id === teamId)
    .map(p => ({ id: p.player.id, name: p.player.name, goals: p.statistics[0].goals?.total ?? 0, assists: p.statistics[0].goals?.assists ?? 0 }))
  const absentIds = new Set((injuries ?? []).filter(i => i.team?.id === teamId).map(i => i.player?.id))
  return { topScorers: mine.slice(0, 3), absentKeyPlayers: mine.filter(p => absentIds.has(p.id)) }
}

function injurySummary (injuries) {
  return injuries.map(i => ({ team: i.team.name, player: i.player.name, type: i.player.type, reason: i.player.reason }))
}

function lineupSummary (lineups) {
  return lineups.map(l => ({ team: l.team.name, formation: l.formation, coach: l.coach?.name, xi: (l.startXI ?? []).map(p => p.player.name) }))
}

function teamContext (data, teamId) {
  const c = data.context?.[teamId]
  if (!c) return null
  const season = currentSeason(new Date(data.fixture.fixture.date))
  return {
    standing: standingSummary(data.standings, teamId),
    recent: recentForm(c.recent ?? [], teamId),
    transfers: transferSummary(c.transfers, teamId, season, c.squad),
    coach: coachSummary(c.coach, teamId, data.fixture.fixture.date),
    keyPlayers: keyPlayerAbsences(data.topScorers, data.injuries, teamId)
  }
}

export function analyse (data) {
  const model = fitModel(data)
  const market = marketView(data.odds)
  const e = edges(model, market)
  const fx = data.fixture
  const apiPred = data.prediction?.predictions
  return {
    id: fx.fixture.id,
    kickoff: fx.fixture.date,
    league: { id: fx.league.id, name: fx.league.name, round: fx.league.round },
    venue: fx.fixture.venue?.name,
    home: { id: fx.teams.home.id, name: fx.teams.home.name, logo: fx.teams.home.logo },
    away: { id: fx.teams.away.id, name: fx.teams.away.name, logo: fx.teams.away.logo },
    model, market, edges: e,
    bestEdge: e[0]?.edge ?? -1,
    apiPrediction: apiPred ? { advice: apiPred.advice, percent: apiPred.percent, winner: apiPred.winner?.name } : null,
    apiComparison: data.prediction?.comparison ?? null,
    seasons: { home: seasonTable(data.stats[fx.teams.home.id], data.seasons), away: seasonTable(data.stats[fx.teams.away.id], data.seasons) },
    h2h: h2hSummary(data.h2h, fx.teams.home.id),
    injuries: injurySummary(data.injuries),
    lineups: lineupSummary(data.lineups),
    context: {
      home: teamContext(data, fx.teams.home.id),
      away: teamContext(data, fx.teams.away.id)
    },
    notes: [
      data.prediction?.error ? `Prediction unavailable: ${data.prediction.error}` : null,
      data.odds?.error ? `Odds unavailable: ${data.odds.error}` : null,
      !model ? 'Model not fitted' : null,
      model?.strengths.home.fallback ? `${fx.teams.home.name}: ${model.strengths.home.fallback}` : null,
      model?.strengths.away.fallback ? `${fx.teams.away.name}: ${model.strengths.away.fallback}` : null,
      ...['home', 'away'].flatMap(side => {
        const t = side === 'home' ? fx.teams.home : fx.teams.away
        const c = data.context?.[t.id] ? teamContext(data, t.id) : null
        if (!c) return []
        const out = []
        if (c.coach?.isNew) out.push(`${t.name}: new coach ${c.coach.name} (${c.coach.appointedThisSummer ? 'appointed this summer' : `${c.coach.daysInCharge} days in charge`}) — history may not describe this team`)
        if (c.transfers.turnover !== null ? c.transfers.turnover >= 0.35 : c.transfers.permanentArrivals >= 8) out.push(`${t.name}: ${c.transfers.permanentArrivals} permanent summer arrivals (${Math.round((c.transfers.turnover ?? 0) * 100)}% of the squad) — heavily rebuilt`)
        if (c.keyPlayers.absentKeyPlayers.length) out.push(`${t.name}: key scorer(s) absent — ${c.keyPlayers.absentKeyPlayers.map(p => `${p.name} (${p.goals} goals last season)`).join(', ')}`)
        if (c.recent.xgMatches && c.recent.xgFor !== null && c.recent.goalsFor !== null && c.recent.goalsFor - c.recent.xgFor > 0.6) out.push(`${t.name}: scoring well above xG recently (${c.recent.goalsFor} vs ${c.recent.xgFor}) — likely to regress`)
        if (c.recent.xgMatches && c.recent.xgFor !== null && c.recent.goalsFor !== null && c.recent.xgFor - c.recent.goalsFor > 0.6) out.push(`${t.name}: creating far more than it scores (xG ${c.recent.xgFor} vs ${c.recent.goalsFor} goals) — underperforming`)
        return out
      })
    ].filter(Boolean)
  }
}


// ---------------------------------------------------------------------- llm

const READING_RULES = `Tu es un analyste de paris sportifs prudent et honnête. On te donne, pour un match,
les chiffres d'un modèle de Poisson pondéré sur plusieurs saisons, les probabilités implicites du
bookmaker (marge retirée), l'historique des deux clubs, les confrontations directes, les absences et
les compositions si publiées. Tu écris en français, de façon directe, sans jargon inutile.

Règles de lecture, à appliquer systématiquement :
1. Le marché est la référence. Un écart modèle/marché de moins de 4 points n'est pas un edge.
   Un écart de plus de 12 points sur le 1N2 est presque toujours une erreur du modèle, pas une
   opportunité : cherche la cause (club avec peu de saisons dans la division, promu, mercato
   lourd, adversaire dont le bilan extérieur biaise le calcul) et dis-le.
2. Si la direction du modèle est plausible mais son ampleur suspecte, recommande la double chance
   plutôt que la victoire sèche.
3. Pour un match de coupe d'Europe, l'historique "dans cette compétition" est mince par nature :
   appuie-toi d'abord sur la forme récente (xG), le classement domestique et les absences, et
   traite les probabilités du modèle avec une réserve supplémentaire.
4. Les absences comptent par poste et par nombre : 3-4 attaquants absents d'un côté pèse plus que
   n'importe quel chiffre historique ; un milieu ou une charnière remaniés peuvent aussi bien ouvrir
   le match que l'affaiblir — ne conclus pas dans un seul sens.
5. Un club avec une seule saison de données (weight < 1.2) doit être lu avec ses vrais bilans
   domicile/extérieur, pas avec les probabilités du modèle.
6. Un Poisson simple surestime les totaux élevés et sous-estime les scores bas et les nuls. Un edge
   à deux chiffres sur under/over ou BTTS est suspect ; un edge de 5 à 9 points sur un total,
   appuyé par le profil des équipes (buts par match domicile/extérieur), peut être retenu.
7. Une seule recommandation principale par match, une alternative, et ce qu'il faut éviter.
   Le pari principal doit être pris dans la table "edges" fournie et avoir un edge d'au moins 4
   points ; s'il n'en existe aucun, mainPick vaut exactement "Pas de pari" et confidence vaut 1.
   Recommander un pari à edge nul "pour dire quelque chose" est une faute.
8. Confiance sur 1 à 5. Un 4 ou 5 exige que le modèle, le marché et les absences convergent.
9. Ne jamais présenter une probabilité comme une certitude ; un pari recommandé perd souvent.
10. Un edge à deux chiffres est suspect sur toutes les lignes (1N2, double chance, totaux, BTTS),
   pas seulement sur la victoire sèche. Si tu qualifies l'avantage du modèle sur une équipe
   d'artefact, ne parie pas dans ce sens, même via la double chance : choisis une autre ligne ou
   "Pas de pari".
11. Cite toujours la cote réelle fournie (y compris pour la double chance) ; n'en invente jamais.
12. Le bloc "context" est prioritaire sur l'historique long : classement et forme actuels, xG des 6
   derniers matchs (une équipe qui marque bien au-dessus de son xG va régresser ; l'inverse aussi),
   effectif remanié (35 % de l'effectif arrivé cet été ou plus = l'historique ne décrit plus
   l'équipe ; en dessous, un mercato normal), coach nommé cet été ou depuis moins de 90 jours, et buteurs majeurs de la saison passée absents aujourd'hui.
   Quand le contexte contredit le modèle, dis-le et suis le contexte.

Réponds uniquement en JSON, sans texte autour, avec exactement ces clés :
{"verdict": "une phrase", "confidence": 1-5, "mainPick": "pari + cote réelle, ou 'Pas de pari'",
 "mainPickEdge": nombre (l'edge en points lu dans la table edges pour ce pari, 0 si Pas de pari),
 "altPick": "pari ou null", "avoid": "ce qu'il ne faut pas jouer, ou null",
 "reasoning": "3 à 6 phrases, les faits qui pèsent, les réserves"}`

const SYNTHESIS_RULES = `Tu reçois les lectures de tous les matchs du jour. Écris en français une synthèse
en JSON : {"summary": "3 à 5 phrases sur la journée : où sont les vrais edges, où le modèle s'emballe, ce
que le marché semble savoir", "ranked": [{"match": "Équipe A – Équipe B", "pick": "…", "confidence": 1-5,
"why": "une phrase"}], "avoidToday": ["…"]}. Classe ranked par confiance décroissante puis par edge.
Maximum 6 entrées dans ranked ; n'y mets que des matchs dont mainPick n'est pas "Pas de pari".
Rappelle en une phrase finale que ce sont des opinions probabilistes.`

async function llmFetch (url, options) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await fetch(url, options)
    } catch (err) {
      const cause = err.cause?.code ?? err.message
      if (attempt === 3) throw new Error(`network error calling ${new URL(url).host} (${cause})`)
      await sleep(1500 * attempt)
    }
  }
}

async function claude (system, user, maxTokens = 3000, attempt = 1) {
  let text; let stopReason
  if (PROVIDER === 'deepseek') {
    const res = await llmFetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${DEEPSEEK_KEY}` },
      body: JSON.stringify({
        model: ANALYSIS_MODEL, max_tokens: maxTokens,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
      })
    })
    const json = await res.json()
    if (!res.ok) throw new Error(`DeepSeek API ${res.status}: ${JSON.stringify(json.error ?? json)}`)
    text = json.choices?.[0]?.message?.content ?? ''
    stopReason = json.choices?.[0]?.finish_reason
  } else {
    const res = await llmFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: ANALYSIS_MODEL, max_tokens: maxTokens, system,
        messages: [{ role: 'user', content: user }]
      })
    })
    const json = await res.json()
    if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${JSON.stringify(json.error ?? json)}`)
    text = (json.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('')
    stopReason = json.stop_reason
  }
  const parsed = extractJson(text)
  if (parsed) return parsed

  await mkdir(cacheDir, { recursive: true })
  await writeFile(path.join(cacheDir, `llm-fail-${Date.now()}.txt`), `provider=${PROVIDER} stop_reason=${stopReason}\n\n${text}`)
  if (attempt < 2) {
    // Truncated or malformed: retry once with more room and a stricter reminder
    return claude(system + '\n\nRéponds avec un seul objet JSON compact, sans retour à la ligne dans les valeurs.', user, maxTokens + 1500, attempt + 1)
  }
  const err = new Error(`invalid JSON after ${attempt} attempts (stop_reason=${stopReason}); raw saved in .cache/report/llm-fail-*.txt`)
  err.rawText = text
  throw err
}

function extractJson (text) {
  const cleaned = text.replace(/```json|```/g, '').trim()
  const start = cleaned.indexOf('{'); const end = cleaned.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  const candidate = cleaned.slice(start, end + 1)
  try { return JSON.parse(candidate) } catch { /* try a lenient repair below */ }
  // Common model slips: trailing commas, unescaped newlines inside strings
  const repaired = candidate
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/(?<=:\s*"[^"]*)\n(?=[^"]*")/g, ' ')
  try { return JSON.parse(repaired) } catch { return null }
}

const NO_BET = /^pas de pari/i

function checkAnalysis (m) {
  // Cross-check the written pick against the numbers; returns human-readable flags.
  const a = m.analysis; const flags = []
  if (!a || a.error) return flags
  if (NO_BET.test(a.mainPick ?? '')) return flags
  const edge = Number(a.mainPickEdge)
  if (!Number.isFinite(edge)) flags.push('Edge du pari principal non renseigné par l\'analyse.')
  else if (edge < 4) flags.push(`Pari principal retenu avec un edge de ${edge.toFixed(1)} point(s) — sous le seuil de 4 : à considérer comme "pas de pari".`)
  // Does the stated pick correspond to a line the model actually flagged?
  const t = (a.mainPick ?? '').toLowerCase()
  const best = m.edges.filter(e => e.edge >= 0.04).map(e => e.label.toLowerCase())
  const matches = best.some(l =>
    (l.includes('over') && /plus de|over/.test(t)) || (l.includes('under') && /moins de|under/.test(t)) ||
    (l.includes('both teams') && /btts|deux équipes|both teams/.test(t) && !/\bnon\b|\bno\b|ne marquent pas/.test(t)) ||
    (l.includes('not both') && /btts|deux équipes|both teams/.test(t) && /\bnon\b|\bno\b|ne marquent pas/.test(t)) ||
    (l.includes('1x') && /1x|ou nul/.test(t) && t.includes(m.home.name.toLowerCase().slice(0, 5))) ||
    (l.includes('x2') && /x2|nul ou/.test(t)) ||
    (l === 'home win' && t.includes(m.home.name.toLowerCase().slice(0, 5)) && !/ou nul|1x/.test(t)) ||
    (l === 'away win' && t.includes(m.away.name.toLowerCase().slice(0, 5)) && !/nul ou|x2/.test(t)) ||
    (l === 'draw' && /^nul|match nul/.test(t)))
  if (best.length && !matches) flags.push('Le pari principal ne correspond à aucune ligne à edge ≥ 4 points dans la table.')
  return flags
}

function compactForLlm (m) {
  // Strip logos and long lists; keep what the reading rules need.
  return {
    match: `${m.home.name} – ${m.away.name}`, league: m.league.name, kickoff: m.kickoff, venue: m.venue,
    model: m.model ? {
      expectedGoals: [m.model.lambdaHome, m.model.lambdaAway].map(x => +x.toFixed(2)),
      probs: Object.fromEntries(Object.entries(m.model.probs).map(([k, v]) => [k, +(v * 100).toFixed(0)])),
      topScores: m.model.topScores.map(s => `${s.h}-${s.a} ${(s.p * 100).toFixed(0)}%`),
      dataWeight: { home: +m.model.strengths.home.weight.toFixed(2), away: +m.model.strengths.away.weight.toFixed(2) }
    } : null,
    market: m.market ? {
      bookmaker: m.market.bookmaker,
      matchWinner: m.market.matchWinner?.items.map(i => `${i.label} ${(i.p * 100).toFixed(0)}% @${i.odd}`),
      over25: m.market.over25?.items.map(i => `${i.label} ${(i.p * 100).toFixed(0)}% @${i.odd}`),
      btts: m.market.btts?.items.map(i => `${i.label} ${(i.p * 100).toFixed(0)}% @${i.odd}`),
      doubleChance: m.market.doubleChance?.items.map(i => `${i.label} ${(i.p * 100).toFixed(0)}% @${i.odd}`)
    } : null,
    edges: m.edges.map(e => `${e.label}: modèle ${(e.model * 100).toFixed(0)} / marché ${(e.market * 100).toFixed(0)} / edge ${(e.edge * 100).toFixed(1)}`),
    seasons: { home: m.seasons.home, away: m.seasons.away },
    h2h: { record: `${m.h2h.homeTeamWins}-${m.h2h.draws}-${m.h2h.awayTeamWins}`, avgGoals: m.h2h.avgGoals, last: m.h2h.matches.slice(0, 6) },
    injuries: m.injuries, lineups: m.lineups.map(l => ({ team: l.team, formation: l.formation, xi: l.xi })),
    context: m.context && Object.fromEntries(['home', 'away'].map(side => {
      const c = m.context[side]
      if (!c) return [side, null]
      return [side, {
        standing: c.standing,
        recent: c.recent && { form: c.recent.form, pointsPerGame: c.recent.pointsPerGame, goals: `${c.recent.goalsFor} for / ${c.recent.goalsAgainst} against per match`, xg: c.recent.xgFor !== null ? `${c.recent.xgFor} for / ${c.recent.xgAgainst} against per match (${c.recent.xgMatches} matches)` : 'unavailable', matches: c.recent.rows.map(r => `${r.date} ${r.venue} ${r.opponent} ${r.score}${r.xg ? ' (xG ' + r.xg + ')' : ''}`) },
        transfers: c.transfers && { arrivals: c.transfers.arrivals, departures: c.transfers.departures, permanentArrivals: c.transfers.permanentArrivals, notable: c.transfers.list.slice(0, 8).map(t => `${t.player}: ${t.from} → ${t.to} (${t.type})`) },
        coach: c.coach,
        keyPlayers: c.keyPlayers
      }]
    })),
    apiPrediction: m.apiPrediction, notes: m.notes
  }
}

export async function narrate (matches) {
  for (const m of matches) {
    process.stderr.write(`  ✎ ${m.home.name} – ${m.away.name} … `)
    try {
      m.analysis = await claude(READING_RULES, JSON.stringify(compactForLlm(m)))
      m.analysis.checks = checkAnalysis(m)
      console.error(m.analysis.checks.length ? `ok (${m.analysis.checks.length} flag)` : 'ok')
    } catch (err) {
      m.analysis = { error: err.message, raw: err.rawText ? err.rawText.slice(0, 1200) : null }
      console.error(`failed (${err.message})`)
    }
  }
  const digest = matches.filter(m => m.analysis && !m.analysis.error).map(m => ({
    match: `${m.home.name} – ${m.away.name}`, league: m.league.name, bestEdge: +(m.bestEdge * 100).toFixed(1), ...m.analysis
  }))
  try {
    return await claude(SYNTHESIS_RULES, JSON.stringify(digest), 3000)
  } catch (err) {
    return { error: err.message }
  }
}

// --------------------------------------------------------------------- html

const pct = (p) => (p === undefined || p === null ? '—' : `${(p * 100).toFixed(0)}%`)
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

export function renderHtml (report) {
  const { date, generatedAt, matches, args } = report
  const byLeague = {}
  for (const m of matches) (byLeague[m.league.name] ??= []).push(m)
  const json = JSON.stringify(report).replace(/</g, '\\u003c')

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Matchday ${date} — analyse 360°</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Roboto+Mono:wght@400;500;700&display=swap" rel="stylesheet">
<style>
:root{
  --red:#E4002B;--red-dark:#B80022;--black:#111111;--grey-1:#F5F5F7;--grey-2:#E8E8EC;--grey-3:#8A8A93;--text:#1B1B1F;--text-2:#5C5C66;
  --odd-bg:#FFFFFF;--odd-border:#D9D9DE;--pick:#FFE600;--model:#111111;--market:#00A86B;--edge:#E4002B;--edge-soft:#FDE7EA;
  --body:'Inter',system-ui,sans-serif;--mono:'Roboto Mono',monospace;
}
*{box-sizing:border-box}
body{margin:0;background:var(--grey-1);color:var(--text);font-family:var(--body);font-size:14px;line-height:1.45}
/* top bar */
header{background:var(--red);color:#fff;padding:0 24px;height:56px;display:flex;align-items:center;justify-content:space-between;gap:16px}
header h1{font-size:18px;font-weight:800;letter-spacing:.2px;margin:0;display:flex;align-items:center;gap:12px}
header h1 small{font-weight:500;font-size:12px;opacity:.85;letter-spacing:0}
.meta{font-family:var(--mono);font-size:11px;opacity:.9;text-align:right}
.disclaimer{margin:0;padding:8px 24px;background:var(--black);color:#ddd;font-size:12px}
.disclaimer b{color:#fff}
main{display:grid;grid-template-columns:400px 1fr;min-height:calc(100vh - 92px)}
/* match list, bookmaker style */
nav{background:#fff;border-right:1px solid var(--grey-2);overflow:auto}
nav h2{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:#fff;background:var(--black);margin:0;padding:8px 14px;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;z-index:1}
nav h2 span{font-weight:500;font-family:var(--mono);font-size:10px;opacity:.7;text-transform:none;letter-spacing:0}
nav button{display:grid;grid-template-columns:1fr auto;gap:8px;width:100%;text-align:left;background:#fff;border:0;border-bottom:1px solid var(--grey-2);padding:10px 14px;cursor:pointer;font:inherit;color:var(--text);align-items:center}
nav button:hover{background:var(--grey-1)}
nav button[aria-selected="true"]{background:#FFF5F6;box-shadow:inset 4px 0 0 var(--red)}
nav button:focus-visible{outline:2px solid var(--red);outline-offset:-2px}
nav .teams{font-weight:600;font-size:13px;line-height:1.3}
nav .teams span{display:block}
nav .sub{font-family:var(--mono);font-size:10px;color:var(--text-2);margin-top:3px}
.odds{display:flex;gap:4px}
.odd{width:52px;height:38px;border:1px solid var(--odd-border);border-radius:4px;background:var(--odd-bg);display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:var(--mono);font-size:12px;font-weight:700;line-height:1}
.odd small{font-family:var(--body);font-size:9px;font-weight:500;color:var(--text-2);margin-bottom:3px}
.odd.pick{background:var(--pick);border-color:#E6CF00}
.odd.na{color:var(--grey-3);font-weight:400}
.edge-pill{font-family:var(--mono);font-size:10px;padding:2px 6px;border-radius:3px;background:var(--edge-soft);color:var(--red-dark);font-weight:700;margin-left:6px}
.edge-pill.none{background:var(--grey-2);color:var(--text-2)}
/* panels */
#panels{min-width:0}
section.match{display:none;padding:22px 28px 60px;max-width:1120px;min-width:0}
section.match[aria-hidden="false"]{display:block}
.title{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.title img{width:40px;height:40px;object-fit:contain}
.title h2{font-size:26px;font-weight:800;margin:0;line-height:1;letter-spacing:-.3px}
.title .vs{font-size:14px;color:var(--text-2);font-weight:600}
.kick{font-family:var(--mono);font-size:11px;color:var(--text-2);margin:6px 0 18px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.card{background:#fff;border:1px solid var(--grey-2);border-radius:8px;padding:14px 16px;min-width:0;overflow-x:auto}
.card h3{font-size:11px;letter-spacing:.6px;text-transform:uppercase;margin:0 0 10px;color:var(--text-2);font-weight:700}
.card.wide{grid-column:1/-1}
/* signature: model bar with market ticks */
.bar{position:relative;height:36px;border-radius:6px;overflow:hidden;display:flex;margin:6px 0 4px}
.bar span{display:flex;align-items:center;justify-content:center;font-family:var(--mono);font-weight:700;font-size:14px;color:#fff;min-width:0}
.bar .h{background:var(--black)}.bar .d{background:#55555E}.bar .a{background:#9A9AA6}
.ticks{position:relative;height:10px;margin-bottom:8px}
.ticks i{position:absolute;top:0;width:2px;height:10px;background:var(--market)}
.legend{font-family:var(--mono);font-size:10px;color:var(--text-2);display:flex;gap:16px;flex-wrap:wrap}
.legend b{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{font-size:10px;letter-spacing:.5px;text-transform:uppercase;color:var(--text-2);text-align:left;padding:5px 6px;border-bottom:1px solid var(--grey-2);font-weight:700}
td{padding:6px;border-bottom:1px solid var(--grey-1);font-family:var(--mono);font-size:12px;white-space:nowrap}
td.txt{font-family:var(--body);font-size:13px;white-space:normal}
tr.flag td{background:var(--edge-soft)}
.pos{color:var(--red-dark);font-weight:700}.neg{color:var(--text-2)}
.note{background:#FFF8E0;border-left:3px solid var(--pick);padding:8px 12px;font-size:13px;margin-bottom:8px;border-radius:0 4px 4px 0}
.form{font-family:var(--mono);letter-spacing:2px}
.form b{color:var(--market)}.form i{color:var(--red);font-style:normal}.form u{text-decoration:none;color:var(--grey-3)}
.scores{display:flex;gap:8px;flex-wrap:wrap}
.scores div{font-family:var(--mono);font-size:18px;font-weight:700;padding:6px 12px;border:1px solid var(--grey-2);border-radius:6px;background:var(--grey-1)}
.scores div small{display:block;font-size:10px;font-weight:400;color:var(--text-2)}
.empty{color:var(--text-2);font-style:italic}
/* reading card */
.read{border:0;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.08);border-top:4px solid var(--red)}
.read .verdict{font-size:20px;font-weight:800;line-height:1.2;margin:0 0 8px;letter-spacing:-.2px}
.read .conf{font-family:var(--mono);font-size:11px;color:var(--text-2)}
.read .conf b{color:var(--red);letter-spacing:2px}
.picks{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:12px 0}
.picks div{background:var(--grey-1);border:1px solid var(--grey-2);border-radius:6px;padding:10px 12px;font-weight:600}
.picks small{display:block;font-size:10px;letter-spacing:.5px;text-transform:uppercase;color:var(--text-2);font-weight:700;margin-bottom:4px}
.picks .main{background:var(--pick);border-color:#E6CF00;color:var(--black)}
.synth ol{padding-left:20px}.synth li{margin-bottom:8px}
@media (max-width:900px){main{grid-template-columns:1fr}nav{border-right:0;max-height:45vh}.grid{grid-template-columns:1fr}section.match{padding:16px}.picks{grid-template-columns:1fr}header h1{font-size:15px}}
@media (prefers-reduced-motion:no-preference){section.match[aria-hidden="false"]{animation:in .15s ease-out}@keyframes in{from{opacity:0}to{opacity:1}}}
</style>
</head>
<body>
<header>
  <h1>Analyse du jour · ${esc(date)}<small>${matches.length} matchs · ${Object.keys(byLeague).length} championnats · ${args.seasons} saisons</small></h1>
  <div class="meta">cotes ${esc(matches.find(m => m.market)?.market.bookmaker ?? '—')} · généré ${esc(generatedAt.slice(11, 16))} UTC</div>
</header>
<p class="disclaimer"><b>Lecture.</b> L'edge est l'écart entre la probabilité du modèle et celle implicite dans la cote (marge retirée). Un edge positif signale un désaccord avec le marché, pas un pari gagnant : le modèle ignore les blessures, les transferts de l'été et les compositions tant qu'elles ne sont pas publiées. Le marché, lui, ne les ignore pas.</p>
<main>
<nav aria-label="Matchs" id="nav"></nav>
<div id="panels"></div>
</main>
<script id="data" type="application/json">${json}</script>
<script>
const R = JSON.parse(document.getElementById('data').textContent);
const pct = p => (p==null?'—':(p*100).toFixed(0)+'%');
const esc = s => String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const nav = document.getElementById('nav'), panels = document.getElementById('panels');

const ranked = [...R.matches].sort((a,b)=>b.bestEdge-a.bestEdge);
const groups = {};
for (const m of ranked) (groups[m.league.name] ??= []).push(m);

nav.innerHTML = (R.synthesis ? '<h2>Journée<span>lecture globale</span></h2><button role="tab" data-id="synth"><div class="teams"><span>Synthèse du jour</span></div><div class="sub">paris retenus · à éviter</div></button>' : '')
  + '<h2>Meilleurs écarts<span>modèle vs marché</span></h2>' + ranked.slice(0, 5).map(navItem).join('')
  + Object.entries(groups).map(([lg, ms]) => '<h2>'+esc(lg)+'<span>'+ms.length+' match'+(ms.length>1?'s':'')+'</span></h2>' + ms.sort((a,b)=>a.kickoff.localeCompare(b.kickoff)).map(navItem).join('')).join('');

function pickKey(m){
  // which 1N2 outcome does the written analysis (or, failing that, the model) point to?
  const t = (m.analysis?.mainPick || '').toLowerCase();
  const h = m.home.name.toLowerCase(), a = m.away.name.toLowerCase();
  if (t.includes(' ou nul') || t.includes('double chance')) return null;
  if (t.includes('nul')) return 'Draw';
  if (t.includes(h)) return 'Home';
  if (t.includes(a)) return 'Away';
  return null;
}
function navItem(m){
  const e = m.bestEdge;
  const pill = e>=0.05 ? '<span class="edge-pill">+'+(e*100).toFixed(0)+'</span>' : '';
  const it = m.market?.matchWinner?.items || [];
  const pk = pickKey(m);
  const odd = (label, txt) => { const i = it.find(x=>x.label===label); return i ? '<div class="odd'+(pk===label?' pick':'')+'"><small>'+txt+'</small>'+i.odd.toFixed(2)+'</div>' : '<div class="odd na"><small>'+txt+'</small>—</div>'; };
  return '<button role="tab" data-id="'+m.id+'"><div><div class="teams"><span>'+esc(m.home.name)+'</span><span>'+esc(m.away.name)+'</span></div><div class="sub">'+m.kickoff.slice(11,16)+' UTC · '+esc(m.league.name)+pill+'</div></div><div class="odds">'+odd('Home','1')+odd('Draw','N')+odd('Away','2')+'</div></button>';
}

panels.innerHTML = (R.synthesis ? synthPanel(R.synthesis) : '') + R.matches.map(panel).join('');

function synthPanel(s){
  if (s.error) return '<section class="match" id="msynth" aria-hidden="true"><div class="note">Synthèse indisponible : '+esc(s.error)+'</div></section>';
  return '<section class="match synth" id="msynth" aria-hidden="true"><div class="title"><h2>Synthèse du jour</h2></div>'
    + '<div class="card read"><p>'+esc(s.summary)+'</p></div>'
    + '<div class="grid" style="margin-top:18px"><div class="card"><h3>Paris retenus, par confiance</h3><ol>'+(s.ranked||[]).map(r=>'<li><b>'+esc(r.match)+'</b> — '+esc(r.pick)+' <span class="conf"><b>'+'●'.repeat(r.confidence)+'○'.repeat(5-r.confidence)+'</b></span><br><span class="kick" style="margin:0">'+esc(r.why)+'</span></li>').join('')+'</ol></div>'
    + '<div class="card"><h3>À éviter aujourd\\'hui</h3>'+((s.avoidToday||[]).length?'<ul>'+s.avoidToday.map(a=>'<li>'+esc(a)+'</li>').join('')+'</ul>':'<p class="empty">Rien de particulier.</p>')+'</div></div></section>';
}

function readCard(a){
  if (!a) return '';
  if (a.error) return '<div class="card wide read"><h3>Lecture</h3><p class="empty">Analyse structurée indisponible ('+esc(a.error)+')'+(a.raw?' — texte brut ci-dessous :':'')+'</p>'+(a.raw?'<p style="margin:8px 0 0">'+esc(a.raw)+'</p>':'')+'</div>';
  return '<div class="card wide read"><h3>Lecture</h3><p class="verdict">'+esc(a.verdict)+'</p>'
    + '<div class="conf">confiance <b>'+'●'.repeat(a.confidence)+'○'.repeat(5-a.confidence)+'</b> '+a.confidence+'/5</div>'
    + '<div class="picks"><div class="main"><small>Pari principal</small>'+esc(a.mainPick)+'</div><div><small>Alternative</small>'+(a.altPick?esc(a.altPick):'<span class="empty">aucune</span>')+'</div><div><small>À éviter</small>'+(a.avoid?esc(a.avoid):'<span class="empty">—</span>')+'</div></div>'
    + '<p style="margin:0">'+esc(a.reasoning)+'</p>'
    + ((a.checks||[]).length ? '<div class="note" style="margin:10px 0 0">Contrôle automatique : '+a.checks.map(esc).join(' ')+'</div>' : '')
    + '</div>';
}

function form(s){ return '<span class="form">'+[...(s||'')].map(c=>c==='W'?'<b>W</b>':c==='L'?'<i>L</i>':'<u>D</u>').join('')+'</span>'; }

function panel(m){
  const md = m.model, mk = m.market;
  const bar = md ? '<div class="bar"><span class="h" style="flex:'+md.probs.home+'">'+pct(md.probs.home)+'</span><span class="d" style="flex:'+md.probs.draw+'">'+pct(md.probs.draw)+'</span><span class="a" style="flex:'+md.probs.away+'">'+pct(md.probs.away)+'</span></div>'
    + (mk?.matchWinner ? '<div class="ticks">'+(function(){const it=mk.matchWinner.items;const h=it.find(i=>i.label==='Home').p,d=it.find(i=>i.label==='Draw').p;return '<i style="left:'+(h*100)+'%"></i><i style="left:'+((h+d)*100)+'%"></i>'})()+'</div>' : '')
    + '<div class="legend"><span><b style="background:var(--model)"></b>modèle : '+esc(m.home.name)+' / nul / '+esc(m.away.name)+'</span><span><b style="background:var(--market)"></b>repères du marché'+(mk?' ('+esc(mk.bookmaker)+', marge '+(mk.matchWinner.margin*100).toFixed(1)+'%)':'')+'</span></div>'
    : '<p class="empty">Modèle non ajusté.</p>';

  const edgeRows = m.edges.length ? '<table><tr><th>Pari</th><th>Modèle</th><th>Marché</th><th>Cote</th><th>Edge</th><th>EV</th></tr>'+m.edges.map(r=>'<tr class="'+(r.edge>=0.05?'flag':'')+'"><td class="txt">'+esc(r.label)+'</td><td>'+pct(r.model)+'</td><td>'+pct(r.market)+'</td><td>'+r.odd.toFixed(2)+'</td><td class="'+(r.edge>0?'pos':'neg')+'">'+(r.edge>=0?'+':'')+(r.edge*100).toFixed(1)+'</td><td class="'+(r.ev>0?'pos':'neg')+'">'+(r.ev>=0?'+':'')+(r.ev*100).toFixed(1)+'%</td></tr>').join('')+'</table>' : '<p class="empty">Pas de cotes disponibles pour ce match.</p>';

  const scores = md ? '<div class="scores">'+md.topScores.map(s=>'<div>'+s.h+'–'+s.a+'<small>'+pct(s.p)+'</small></div>').join('')+'</div><p class="kick">buts attendus : '+md.lambdaHome.toFixed(2)+' – '+md.lambdaAway.toFixed(2)+' · +2,5 buts '+pct(md.probs.over25)+' · BTTS '+pct(md.probs.btts)+'</p>' : '';

  const seasonTbl = side => '<table><tr><th>Saison</th><th>J</th><th>V-N-D</th><th>Buts</th><th>Dom</th><th>Ext</th><th>CS</th><th>Forme</th></tr>'+m.seasons[side].map(s=>s.played?'<tr><td>'+s.season+'-'+String(s.season+1).slice(2)+'</td><td>'+s.played+'</td><td>'+s.w+'-'+s.d+'-'+s.l+'</td><td>'+s.gf+':'+s.ga+'</td><td>'+s.homeRecord+'</td><td>'+s.awayRecord+'</td><td>'+(s.cleanSheets??'—')+'</td><td>'+form(s.form)+'</td></tr>':'<tr><td>'+s.season+'</td><td colspan="7" class="empty">pas dans cette division</td></tr>').join('')+'</table>';

  const h = m.h2h;
  const h2h = h.matches.length ? '<p class="kick" style="margin:0 0 8px">'+h.matches.length+' matchs · '+esc(m.home.name)+' '+h.homeTeamWins+' · nuls '+h.draws+' · '+esc(m.away.name)+' '+h.awayTeamWins+' · '+h.avgGoals.toFixed(1)+' buts/match</p><table>'+h.matches.map(x=>'<tr><td>'+x.date+'</td><td class="txt">'+esc(x.comp)+'</td><td class="txt">'+esc(x.home)+' – '+esc(x.away)+'</td><td>'+x.score+'</td></tr>').join('')+'</table>' : '<p class="empty">Aucune confrontation récente.</p>';

  const inj = m.injuries.length ? '<table>'+m.injuries.map(i=>'<tr><td class="txt">'+esc(i.team)+'</td><td class="txt">'+esc(i.player)+'</td><td class="txt">'+esc(i.type)+' — '+esc(i.reason)+'</td></tr>').join('')+'</table>' : '<p class="empty">Aucune absence signalée.</p>';

  const lu = m.lineups.length ? m.lineups.map(l=>'<p><b>'+esc(l.team)+'</b> '+esc(l.formation||'')+(l.coach?' · '+esc(l.coach):'')+'<br><span class="kick" style="margin:0">'+l.xi.map(esc).join(', ')+'</span></p>').join('') : '<p class="empty">Compositions non publiées (généralement ~1h avant le coup d\\'envoi — relancez le script avec --refresh).</p>';

  const ap = m.apiPrediction ? '<p>'+esc(m.apiPrediction.advice)+'<br><span class="kick" style="margin:4px 0 0">'+esc(m.apiPrediction.percent.home)+' / '+esc(m.apiPrediction.percent.draw)+' / '+esc(m.apiPrediction.percent.away)+(m.apiComparison?' · comparatif total '+esc(m.apiComparison.total.home)+' – '+esc(m.apiComparison.total.away):'')+'</span></p>' : '<p class="empty">Indisponible.</p>';

  return '<section class="match" role="tabpanel" id="m'+m.id+'" aria-hidden="true">'
    + '<div class="title"><img src="'+m.home.logo+'" alt=""><h2>'+esc(m.home.name)+'</h2><span class="vs">vs</span><h2>'+esc(m.away.name)+'</h2><img src="'+m.away.logo+'" alt=""></div>'
    + '<p class="kick">'+esc(m.league.name)+' · '+esc(m.league.round)+' · '+m.kickoff.replace('T',' ').slice(0,16)+' UTC'+(m.venue?' · '+esc(m.venue):'')+'</p>'
    + m.notes.map(n=>'<div class="note">'+esc(n)+'</div>').join('')
    + '<div class="grid">'
    + readCard(m.analysis)
    + '<div class="card wide"><h3>Modèle contre marché — 1N2</h3>'+bar+'</div>'
    + '<div class="card"><h3>Écarts par pari</h3>'+edgeRows+'</div>'
    + '<div class="card"><h3>Scores probables</h3>'+scores+'</div>'
    + '<div class="card"><h3>'+esc(m.home.name)+' — historique</h3>'+seasonTbl('home')+'</div>'
    + '<div class="card"><h3>'+esc(m.away.name)+' — historique</h3>'+seasonTbl('away')+'</div>'
    + '<div class="card"><h3>Confrontations directes</h3>'+h2h+'</div>'
    + '<div class="card wide"><h3>Contexte actuel</h3>'+contextCard(m)+'</div>'
    + '<div class="card"><h3>Absences</h3>'+inj+'</div>'
    + '<div class="card"><h3>Compositions</h3>'+lu+'</div>'
    + '<div class="card"><h3>Avis API-Football</h3>'+ap+'</div>'
    + '</div></section>';
}

function contextCard(m){
  if (!m.context || (!m.context.home && !m.context.away)) return '<p class="empty">Non collecté.</p>';
  const side = (label, c) => {
    if (!c) return '<div><b>'+esc(label)+'</b><p class="empty">indisponible</p></div>';
    const st = c.standing ? esc(c.standing.rank)+'ᵉ · '+c.standing.points+' pts en '+c.standing.played+' matchs'+(c.standing.form?' · '+form(c.standing.form):'') : '<span class="empty">classement indisponible</span>';
    const r = c.recent;
    const rec = r && r.matches ? form(r.form)+' · '+r.pointsPerGame+' pt/match · buts '+r.goalsFor+' / '+r.goalsAgainst+(r.xgFor!==null?' · xG '+r.xgFor+' / '+r.xgAgainst:'') : '<span class="empty">pas de matchs récents</span>';
    const rows = r ? r.rows.map(x=>'<tr><td>'+x.date+'</td><td>'+x.venue+'</td><td class="txt">'+esc(x.opponent)+'</td><td>'+x.score+'</td><td>'+(x.xg||'—')+'</td></tr>').join('') : '';
    const tr = c.transfers ? c.transfers.arrivals+' arrivées ('+c.transfers.permanentArrivals+' définitives'+(c.transfers.turnover!==null?', '+Math.round(c.transfers.turnover*100)+'% de l\\'effectif':'')+') · '+c.transfers.departures+' départs' : '';
    const co = c.coach ? esc(c.coach.name)+(c.coach.appointedThisSummer?' · nommé cet été':(c.coach.daysInCharge!==null?' · en poste depuis '+c.coach.daysInCharge+' j':''))+(c.coach.isNew?' <span class="edge-pill">nouveau</span>':'') : '<span class="empty">inconnu</span>';
    const kp = c.keyPlayers ? (c.keyPlayers.absentKeyPlayers.length ? '<span class="pos">Absent : '+c.keyPlayers.absentKeyPlayers.map(p=>esc(p.name)+' ('+p.goals+' buts)').join(', ')+'</span>' : 'Meilleurs buteurs '+(c.keyPlayers.topScorers.map(p=>esc(p.name)+' '+p.goals).join(', ')||'—')+' — tous disponibles') : '';
    return '<div><b>'+esc(label)+'</b><p class="kick" style="margin:4px 0">'+st+'</p><p class="kick" style="margin:4px 0">6 derniers : '+rec+'</p><table>'+rows+'</table><p class="kick" style="margin:6px 0 0">Mercato : '+tr+'<br>Coach : '+co+'<br>'+kp+'</p></div>';
  };
  return '<div class="grid" style="gap:14px">'+side(m.home.name, m.context.home)+side(m.away.name, m.context.away)+'</div>';
}

function select(id){
  document.querySelectorAll('nav button').forEach(b=>b.setAttribute('aria-selected', b.dataset.id==id));
  document.querySelectorAll('section.match').forEach(s=>s.setAttribute('aria-hidden', s.id!=='m'+id));
  history.replaceState(null,'','#m'+id);
}
nav.addEventListener('click', e=>{ const b=e.target.closest('button'); if(b) select(b.dataset.id); });
select((location.hash||'').slice(2) || (R.synthesis ? 'synth' : ranked[0]?.id));
</script>
</body>
</html>`
}

// --------------------------------------------------------------------- main

export async function run (args) {
  if (!KEY) throw new Error('API_FOOTBALL_KEY is not set')
  console.error(`Matchday ${args.date} — leagues ${args.leagues.join(',')} — ${args.seasons} seasons`)

  const fixtures = []
  for (const league of args.leagues) {
    const season = currentSeason(new Date(args.date))
    const list = await api('/fixtures', { league, season, date: args.date }, { ttlMs: 6 * HOUR, refresh: args.refresh })
    console.error(`  ${LEAGUES[league]?.name ?? league}: ${list.length} fixtures`)
    fixtures.push(...list)
  }
  if (!fixtures.length) { console.error('No fixtures found for that date.'); return null }

  const matches = []
  for (const fx of fixtures) {
    process.stderr.write(`  → ${fx.teams.home.name} – ${fx.teams.away.name} … `)
    const data = await collectFixture(fx, args)
    matches.push(analyse(data))
    console.error('ok')
  }

  let synthesis = null
  if (args.llm && LLM_KEY) {
    console.error(`\nWriting analyses with ${ANALYSIS_MODEL}…`)
    synthesis = await narrate(matches)
  } else if (args.llm) {
    console.error('\nNo LLM key set (ANTHROPIC_API_KEY or DEEPSEEK_API_KEY) — numbers only, no written analysis (--no-llm silences this).')
  }

  const report = { date: args.date, generatedAt: new Date().toISOString(), args, matches, synthesis }
  await mkdir(args.out, { recursive: true })
  const htmlPath = path.join(args.out, `matchday-${args.date}.html`)
  const jsonPath = path.join(args.out, `matchday-${args.date}.json`)
  await writeFile(htmlPath, renderHtml(report))
  await writeFile(jsonPath, JSON.stringify(report, null, 2))
  console.error(`\nReport: ${htmlPath}\nData:   ${jsonPath}`)

  const top = [...matches].sort((a, b) => b.bestEdge - a.bestEdge).slice(0, 5)
  console.error('\nLargest model/market gaps:')
  for (const m of top) {
    const e = m.edges[0]
    console.error(`  ${m.home.name} – ${m.away.name}: ${e ? `${e.label} model ${pct(e.model)} vs market ${pct(e.market)} (edge ${(e.edge * 100).toFixed(1)})` : 'no odds'}`)
  }
  return report
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(parseArgs(process.argv.slice(2))).catch(err => { console.error(err.message); process.exit(1) })
}
