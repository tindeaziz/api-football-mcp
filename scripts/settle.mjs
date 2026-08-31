#!/usr/bin/env node
/**
 * Settle past matchday reports and measure the recommendations.
 *
 * Usage:
 *   node --env-file=.env scripts/settle.mjs            # settle every reports/matchday-*.json
 *   node --env-file=.env scripts/settle.mjs --since 2026-08-01 --stake 1
 *
 * For each report, every written recommendation (main pick, and the alternative as a separate
 * "alt" line) is turned into a concrete market, its real odds are taken from the report's edge
 * table, the final score is fetched from API-Football, and the bet is settled at a flat stake.
 * Results accumulate in reports/ledger.json and a summary is printed and written to
 * reports/ledger.html: hit rate and ROI overall, by confidence level, by bet type, by league,
 * plus the running P&L curve. Re-running is idempotent — already settled bets are kept, pending
 * ones are retried.
 */

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

const BASE = process.env.API_BASE_URL ?? 'https://v3.football.api-sports.io'
const KEY = process.env.API_FOOTBALL_KEY
const REPORTS = 'reports'
const LEDGER = path.join(REPORTS, 'ledger.json')

// -------------------------------------------------------------------- args
const args = { since: '2000-01-01', stake: 1 }
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--since') args.since = process.argv[++i]
  if (process.argv[i] === '--stake') args.stake = Number(process.argv[++i])
}

// ------------------------------------------------------------ pick parsing
const NO_BET = /^pas de pari/i

/**
 * Map a written pick to one of the report's edge rows (which carry the real odds).
 * Returns { label, odd, edge, model, market } or null when unresolvable.
 */
export function resolvePick (match, text) {
  if (!text || NO_BET.test(text)) return null
  const t = text.toLowerCase()
  const home = match.home.name.toLowerCase(); const away = match.away.name.toLowerCase()
  const has = (name) => t.includes(name) || t.includes(name.slice(0, 6))
  const isNo = /\bnon\b|\bno\b|ne marquent pas|not both/.test(t)
  const rules = [
    ['Over 2.5', /plus de 2[,.]5|over 2[,.]5|\+2[,.]5/],
    ['Under 2.5', /moins de 2[,.]5|under 2[,.]5|-2[,.]5/],
    ['Not both score', /(btts|deux équipes|both teams)/, () => isNo],
    ['Both teams score', /(btts|deux équipes|both teams)/, () => !isNo],
    ['Home or draw (1X)', /\b1x\b|home\/draw|home or draw/, () => true],
    ['Draw or away (X2)', /\bx2\b|draw\/away|draw or away/, () => true],
    ['Home or away (12)', /\b12\b|home\/away|sans (le )?nul|pas de nul/, () => true],
    ['Home or draw (1X)', /ou nul|or draw/, () => has(home) && !has(away)],
    ['Draw or away (X2)', /nul ou|draw or/, () => has(away) && !has(home)],
    ['Draw', /^(match )?nul\b|^draw\b/],
    ['Home win', /./, () => has(home) && !has(away) && !/ou nul|1x|nul ou/.test(t)],
    ['Away win', /./, () => has(away) && !has(home) && !/nul ou|x2|ou nul/.test(t)]
  ]
  let label = null
  for (const [lab, re, extra] of rules) {
    if (re.test(t) && (!extra || extra())) { label = lab; break }
  }
  if (!label) return null
  const row = match.edges.find(e => e.label === label)
  if (row) return { label, odd: row.odd, edge: row.edge, model: row.model, market: row.market }
  // Line not in the edge table (e.g. handicap): fall back to the odd quoted in the text
  const m = t.match(/@\s*~?\s*(\d+[.,]\d+)/)
  return m ? { label, odd: Number(m[1].replace(',', '.')), edge: null, model: null, market: null } : null
}

export function settle (label, hg, ag) {
  const total = hg + ag
  switch (label) {
    case 'Home win': return hg > ag
    case 'Draw': return hg === ag
    case 'Away win': return ag > hg
    case 'Home or draw (1X)': return hg >= ag
    case 'Draw or away (X2)': return ag >= hg
    case 'Home or away (12)': return hg !== ag
    case 'Over 2.5': return total >= 3
    case 'Under 2.5': return total <= 2
    case 'Both teams score': return hg > 0 && ag > 0
    case 'Not both score': return hg === 0 || ag === 0
    default: return null
  }
}

// ------------------------------------------------------------------ API
async function fetchScores (ids) {
  const out = {}
  for (let i = 0; i < ids.length; i += 20) {
    const chunk = ids.slice(i, i + 20)
    const url = new URL(BASE + '/fixtures'); url.searchParams.set('ids', chunk.join('-'))
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(url, { headers: { 'x-apisports-key': KEY } })
        const json = await res.json()
        for (const f of json.response ?? []) {
          out[f.fixture.id] = { status: f.fixture.status.short, hg: f.goals.home, ag: f.goals.away }
        }
        break
      } catch (err) {
        const cause = err.cause?.code ?? err.message
        if (attempt === 3) throw new Error(`network error fetching scores (${cause}) — check DNS/VPN, then retry; nothing was written`)
        console.error(`  retry ${attempt}/2 after network error (${cause})…`)
        await new Promise(r => setTimeout(r, 1500 * attempt))
      }
    }
    await new Promise(r => setTimeout(r, 300))
  }
  return out
}

// ----------------------------------------------------------------- ledger
async function loadLedger () {
  if (!existsSync(LEDGER)) return { bets: [] }
  return JSON.parse(await readFile(LEDGER, 'utf8'))
}

function betId (date, fixtureId, kind) { return `${date}:${fixtureId}:${kind}` }

export async function run () {
  if (!KEY) throw new Error('API_FOOTBALL_KEY is not set')
  const files = (await readdir(REPORTS)).filter(f => /^matchday-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort()
  const ledger = await loadLedger()
  const byId = new Map(ledger.bets.map(b => [b.id, b]))

  // 1. Collect candidate bets from every report
  for (const file of files) {
    const date = file.slice(9, 19)
    if (date < args.since) continue
    const report = JSON.parse(await readFile(path.join(REPORTS, file), 'utf8'))
    for (const m of report.matches) {
      const a = m.analysis
      if (!a || a.error) continue
      for (const kind of ['main', 'alt']) {
        const text = kind === 'main' ? a.mainPick : a.altPick
        const pick = resolvePick(m, text)
        const id = betId(date, m.id, kind)
        if (!pick) {
          if (text && !NO_BET.test(text) && !byId.has(id)) console.error(`  ? unresolved ${kind} pick for ${m.home.name} – ${m.away.name}: "${text}"`)
          continue
        }
        if (byId.has(id)) continue
        const bet = {
          id, date, fixtureId: m.id, kind, league: m.league.name,
          match: `${m.home.name} – ${m.away.name}`, pickText: text, label: pick.label,
          odd: pick.odd, edge: pick.edge, modelP: pick.model, marketP: pick.market,
          confidence: a.confidence ?? null, flagged: (a.checks ?? []).length > 0,
          status: 'pending', result: null, pnl: null, score: null
        }
        ledger.bets.push(bet); byId.set(id, bet)
      }
    }
  }

  // 2. Settle pending bets
  const pending = ledger.bets.filter(b => b.status === 'pending')
  const ids = [...new Set(pending.map(b => b.fixtureId))]
  if (ids.length) {
    console.error(`Fetching ${ids.length} final scores…`)
    const scores = await fetchScores(ids)
    for (const b of pending) {
      const sc = scores[b.fixtureId]
      if (!sc || !['FT', 'AET', 'PEN'].includes(sc.status)) continue
      const won = settle(b.label, sc.hg, sc.ag)
      if (won === null) continue
      b.status = 'settled'; b.result = won ? 'won' : 'lost'; b.score = `${sc.hg}-${sc.ag}`
      b.pnl = won ? +(args.stake * (b.odd - 1)).toFixed(3) : -args.stake
    }
  }

  ledger.updatedAt = new Date().toISOString()
  ledger.stake = args.stake
  await mkdir(REPORTS, { recursive: true })
  await writeFile(LEDGER, JSON.stringify(ledger, null, 2))

  // 3. Summaries
  const settled = ledger.bets.filter(b => b.status === 'settled')
  const summary = {
    overall: agg(settled),
    main: agg(settled.filter(b => b.kind === 'main')),
    alt: agg(settled.filter(b => b.kind === 'alt')),
    byConfidence: group(settled.filter(b => b.kind === 'main'), b => `confiance ${b.confidence ?? '?'}`),
    byLabel: group(settled, b => b.label),
    byLeague: group(settled, b => b.league),
    byEdgeBand: group(settled.filter(b => b.edge !== null), b => b.edge >= 0.10 ? 'edge ≥ 10' : b.edge >= 0.06 ? 'edge 6–10' : b.edge >= 0.04 ? 'edge 4–6' : 'edge < 4'),
    pending: ledger.bets.filter(b => b.status === 'pending').length
  }
  printSummary(summary, settled)
  await writeFile(path.join(REPORTS, 'ledger.html'), renderLedger(ledger, summary))
  console.error(`\nLedger: ${LEDGER}\nPage:   ${path.join(REPORTS, 'ledger.html')}`)
  return summary
}

function agg (bets) {
  const n = bets.length
  const won = bets.filter(b => b.result === 'won').length
  const staked = n * args.stake
  const pnl = bets.reduce((s, b) => s + (b.pnl ?? 0), 0)
  const avgOdd = n ? bets.reduce((s, b) => s + b.odd, 0) / n : null
  // Expected hit rate if the bookmaker's (margin-free) probabilities were right
  const expHit = bets.filter(b => b.marketP !== null).length ? bets.filter(b => b.marketP !== null).reduce((s, b) => s + b.marketP, 0) / bets.filter(b => b.marketP !== null).length : null
  return { n, won, hitRate: n ? won / n : null, expectedHitRate: expHit, avgOdd, pnl: +pnl.toFixed(2), roi: staked ? pnl / staked : null }
}

function group (bets, keyFn) {
  const g = {}
  for (const b of bets) (g[keyFn(b)] ??= []).push(b)
  return Object.fromEntries(Object.entries(g).sort().map(([k, v]) => [k, agg(v)]))
}

const pct = (x) => (x === null || x === undefined ? '   —' : `${(x * 100).toFixed(0).padStart(3)}%`)
const line = (name, a) => `${name.padEnd(22)} ${String(a.n).padStart(3)}  ${String(a.won).padStart(3)}  ${pct(a.hitRate)}  ${pct(a.expectedHitRate)}  ${a.avgOdd ? a.avgOdd.toFixed(2) : '  —'}  ${(a.pnl >= 0 ? '+' : '') + a.pnl.toFixed(2).padStart(6)}  ${a.roi === null ? '   —' : (a.roi >= 0 ? '+' : '') + (a.roi * 100).toFixed(1) + '%'}`

function printSummary (s, settled) {
  console.error(`\n${'Segment'.padEnd(22)}   n  won   hit  exp.  odds     P&L     ROI`)
  console.error(line('Toutes recommandations', s.overall))
  console.error(line('  paris principaux', s.main))
  console.error(line('  alternatives', s.alt))
  for (const [k, v] of Object.entries(s.byConfidence)) console.error(line('  ' + k, v))
  for (const [k, v] of Object.entries(s.byEdgeBand)) console.error(line('  ' + k, v))
  for (const [k, v] of Object.entries(s.byLabel)) console.error(line('  ' + k, v))
  for (const [k, v] of Object.entries(s.byLeague)) console.error(line('  ' + k, v))
  console.error(`\n${settled.length} paris réglés, ${s.pending} en attente. "exp." = taux de réussite attendu si le marché avait raison ; battre durablement cette colonne est le vrai test.`)
  if (settled.length < 50) console.error('Moins de 50 paris réglés : aucune conclusion possible, ni positive ni négative.')
}

// ------------------------------------------------------------------- html
const esc = (x) => String(x ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

function renderLedger (ledger, s) {
  const settled = ledger.bets.filter(b => b.status === 'settled').sort((a, b) => a.date.localeCompare(b.date))
  let run = 0; const curve = settled.map(b => { run += b.pnl; return { d: b.date, v: +run.toFixed(2) } })
  const W = 820; const H = 200
  const minV = Math.min(0, ...curve.map(c => c.v)); const maxV = Math.max(0, ...curve.map(c => c.v)); const span = (maxV - minV) || 1
  const pts = curve.map((c, i) => `${(i / Math.max(1, curve.length - 1)) * W},${H - ((c.v - minV) / span) * H}`).join(' ')
  const zero = H - ((0 - minV) / span) * H
  const row = (name, a) => `<tr><td class="txt">${esc(name)}</td><td>${a.n}</td><td>${a.won}</td><td>${pct(a.hitRate)}</td><td>${pct(a.expectedHitRate)}</td><td>${a.avgOdd ? a.avgOdd.toFixed(2) : '—'}</td><td class="${a.pnl >= 0 ? 'pos' : 'neg'}">${a.pnl >= 0 ? '+' : ''}${a.pnl.toFixed(2)}</td><td class="${a.roi >= 0 ? 'pos' : 'neg'}">${a.roi === null ? '—' : (a.roi >= 0 ? '+' : '') + (a.roi * 100).toFixed(1) + '%'}</td></tr>`
  const table = (title, obj) => `<div class="card"><h3>${esc(title)}</h3><table><tr><th>Segment</th><th>n</th><th>gagnés</th><th>réussite</th><th>attendu</th><th>cote moy.</th><th>P&amp;L</th><th>ROI</th></tr>${Object.entries(obj).map(([k, v]) => row(k, v)).join('')}</table></div>`
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Suivi des recommandations</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&family=Roboto+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
:root{--red:#E4002B;--black:#111;--grey-1:#F5F5F7;--grey-2:#E8E8EC;--text:#1B1B1F;--text-2:#5C5C66;--pos:#00A86B;--neg:#E4002B;--body:'Inter',system-ui,sans-serif;--mono:'Roboto Mono',monospace}
*{box-sizing:border-box}body{margin:0;background:var(--grey-1);color:var(--text);font-family:var(--body);font-size:14px}
header{background:var(--red);color:#fff;padding:0 24px;height:56px;display:flex;align-items:center;justify-content:space-between}
header h1{font-size:18px;font-weight:800;margin:0}header .meta{font-family:var(--mono);font-size:11px;opacity:.9}
main{max-width:1100px;margin:0 auto;padding:22px 24px 60px}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px}
.kpi{background:#fff;border:1px solid var(--grey-2);border-radius:8px;padding:14px 16px}.kpi small{display:block;font-size:10px;letter-spacing:.6px;text-transform:uppercase;color:var(--text-2);font-weight:700}
.kpi b{font-family:var(--mono);font-size:26px;font-weight:700;line-height:1.2}.pos{color:var(--pos)}.neg{color:var(--neg)}
.card{background:#fff;border:1px solid var(--grey-2);border-radius:8px;padding:14px 16px;margin-bottom:14px;overflow-x:auto}
.card h3{font-size:11px;letter-spacing:.6px;text-transform:uppercase;margin:0 0 10px;color:var(--text-2);font-weight:700}
table{width:100%;border-collapse:collapse;font-size:13px}th{font-size:10px;letter-spacing:.5px;text-transform:uppercase;color:var(--text-2);text-align:left;padding:5px 6px;border-bottom:1px solid var(--grey-2)}
td{padding:6px;border-bottom:1px solid var(--grey-1);font-family:var(--mono);font-size:12px;white-space:nowrap}td.txt{font-family:var(--body);font-size:13px;white-space:normal}
svg{width:100%;height:220px;display:block}
.warn{background:#FFF8E0;border-left:3px solid #FFE600;padding:8px 12px;font-size:13px;margin-bottom:14px}
@media(max-width:800px){.kpis{grid-template-columns:1fr 1fr}}
</style></head><body>
<header><h1>Suivi des recommandations</h1><div class="meta">${settled.length} paris réglés · ${s.pending} en attente · mise ${ledger.stake} · ${esc(ledger.updatedAt?.slice(0, 16))}</div></header>
<main>
${settled.length < 50 ? '<div class="warn">Moins de 50 paris réglés : ces chiffres ne permettent encore aucune conclusion. La variance domine.</div>' : ''}
<div class="kpis">
<div class="kpi"><small>P&amp;L cumulé</small><b class="${s.overall.pnl >= 0 ? 'pos' : 'neg'}">${s.overall.pnl >= 0 ? '+' : ''}${s.overall.pnl.toFixed(2)}</b></div>
<div class="kpi"><small>ROI</small><b class="${(s.overall.roi ?? 0) >= 0 ? 'pos' : 'neg'}">${s.overall.roi === null ? '—' : (s.overall.roi >= 0 ? '+' : '') + (s.overall.roi * 100).toFixed(1) + '%'}</b></div>
<div class="kpi"><small>Réussite réelle</small><b>${pct(s.overall.hitRate)}</b></div>
<div class="kpi"><small>Réussite attendue (marché)</small><b>${pct(s.overall.expectedHitRate)}</b></div>
</div>
<div class="card"><h3>Courbe de P&amp;L (mise fixe)</h3><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><line x1="0" y1="${zero}" x2="${W}" y2="${zero}" stroke="#ccc" stroke-dasharray="4 4"/><polyline fill="none" stroke="var(--black)" stroke-width="2" points="${pts}"/></svg></div>
${table('Par type de recommandation', { 'Paris principaux': s.main, Alternatives: s.alt })}
${table('Par niveau de confiance (paris principaux)', s.byConfidence)}
${table('Par bande d\'edge', s.byEdgeBand)}
${table('Par type de pari', s.byLabel)}
${table('Par championnat', s.byLeague)}
<div class="card"><h3>Détail</h3><table><tr><th>Date</th><th>Match</th><th>Type</th><th>Pari</th><th>Cote</th><th>Edge</th><th>Conf.</th><th>Score</th><th>Résultat</th><th>P&amp;L</th></tr>
${[...ledger.bets].sort((a, b) => b.date.localeCompare(a.date)).map(b => `<tr><td>${b.date}</td><td class="txt">${esc(b.match)}<br><span style="color:var(--text-2);font-size:11px">${esc(b.league)}</span></td><td>${b.kind}</td><td class="txt">${esc(b.label)}</td><td>${b.odd.toFixed(2)}</td><td>${b.edge === null ? '—' : (b.edge * 100).toFixed(1)}</td><td>${b.confidence ?? '—'}</td><td>${b.score ?? '—'}</td><td class="${b.result === 'won' ? 'pos' : b.result === 'lost' ? 'neg' : ''}">${b.result ?? 'en attente'}</td><td class="${(b.pnl ?? 0) >= 0 ? 'pos' : 'neg'}">${b.pnl === null ? '—' : (b.pnl >= 0 ? '+' : '') + b.pnl.toFixed(2)}</td></tr>`).join('')}
</table></div>
</main></body></html>`
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith('settle.mjs')) {
  run().catch(err => { console.error(err.message); process.exit(1) })
}
