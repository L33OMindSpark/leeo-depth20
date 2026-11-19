// Collects labelled chess.com players (closed for fair play vs. ordinary), analyses recent games with Stockfish, stores numbers only.
// Resumable: data/seen.txt holds hashes of players already looked at, data/results-*.json the finished ones. Run it again to continue.
import fs from 'node:fs'
import crypto from 'node:crypto'
import { execSync } from 'node:child_process'
import { analyzeGame, summarize } from './src/analyze.js'
import { makePool } from './lib/uci.mjs'
import { normGame } from './lib/games.js'

const API = 'https://api.chess.com/pub', UA = { 'User-Agent': 'leeo-collect-research (open source fair-play study; contact via GitHub)' }
const env = (k, d) => +process.env[k] || d
const CMD = process.env.STOCKFISH_CMD || 'stockfish', THREADS = env('THREADS', 4), DEPTH = env('DEPTH', 12), DEPTH2 = env('DEPTH2', 0), GAMES = env('GAMES', 100), MONTHS = env('MONTHS', 24)
const T_BANNED = env('TARGET_BANNED', 600), T_CLEAN = env('TARGET_CLEAN', 1500), DISC_MIN = env('DISCOVERY_MINUTES', 40), TOTAL_MIN = env('MAX_MINUTES', 330)
const DIR = process.env.DATA_DIR || 'data', RUN = process.env.RUN_ID || String(Date.now()), START = Date.now(), left = () => TOTAL_MIN * 60000 - (Date.now() - START)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const hash = u => crypto.createHash('sha1').update(u).digest('hex').slice(0, 10)
const idOf = u => String(u).replace(/[?#].*$/, '').replace(/\/+$/, '').split('/').pop()
const YOUTH = /(^|[^a-z])(u\d{1,2}|junior|youth|kids?|school|schul|gyerek)([^a-z]|$)/i
fs.mkdirSync(DIR, { recursive: true })

// ---- earlier progress ----
const seenFile = DIR + '/seen.txt', seen = new Set(fs.existsSync(seenFile) ? fs.readFileSync(seenFile, 'utf8').split('\n').filter(Boolean) : [])
const prior = fs.readdirSync(DIR).filter(f => /^results-.*\.json$/.test(f)).flatMap(f => JSON.parse(fs.readFileSync(DIR + '/' + f, 'utf8')))
const count = l => prior.filter(r => r.label === l).length + results.filter(r => r.label === l).length
const banRatings = prior.filter(r => r.label === 'banned').map(r => r.rating)
const results = [], newSeen = []
const mark = u => { const h = hash(u); if (seen.has(h)) return false; seen.add(h); newSeen.push(h); return true }
const PUSH = process.env.PUSH_BRANCH, statusFile = DIR + '/status.json', start0 = fs.existsSync(statusFile) ? JSON.parse(fs.readFileSync(statusFile, 'utf8')) : {}
let lastPush = Date.now()
// progress for the live page: written on every save, pushed to the data branch every 15 minutes
const writeStatus = extra => fs.writeFileSync(statusFile, JSON.stringify({ done: false, banned: count('banned'), clean: count('clean'), targets: [T_BANNED, T_CLEAN], depths: DEPTH2 ? [DEPTH, DEPTH2] : [DEPTH], games: GAMES, emptyRuns: start0.emptyRuns || 0, runStarted: new Date(START).toISOString(), updated: new Date().toISOString(), ...extra }))
const save = () => { fs.writeFileSync(`${DIR}/results-${RUN}.json`, JSON.stringify(results)); if (newSeen.length) { fs.appendFileSync(seenFile, newSeen.join('\n') + '\n'); newSeen.length = 0 }
  writeStatus({ running: true })
  if (PUSH && Date.now() - lastPush > 15 * 60000) { lastPush = Date.now(); try { execSync(`git -C ${DIR} add -A && git -C ${DIR} -c user.name=collect-bot -c user.email=collect-bot@users.noreply.github.com commit -q -m progress && git -C ${DIR} push -q origin HEAD:${PUSH}`, { stdio: 'ignore' }) } catch {} } }

async function j(u, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(u, { headers: UA })
      if (r.ok) return r.json()
      if (r.status === 404 || r.status === 410) return null
      await sleep(20000 * (i + 1))
    } catch { await sleep(5000) }
  }
  return null
}

async function recent(u, n) {
  const a = await j(`${API}/player/${u}/games/archives`); if (!a) return []
  const out = []
  for (const url of a.archives.slice().reverse().slice(0, MONTHS)) {
    const m = await j(url); await sleep(70)
    for (const g of (m?.games || []).slice().reverse()) { if (g.rules !== 'chess' || !g.pgn || g.time_class === 'daily' || !g.rated) continue; const x = normGame(g.pgn, u, 'chesscom'); if (x) out.push(x); if (out.length >= n) return out }
  }
  return out
}
const side = f => ({ n: f[0], acc: f[1], match: f[2], perfect: !!f[3], sh: { n: f[7] || 0, hit: f[8] || 0 }, td: f.slice(9, 15).length === 6 ? f.slice(9, 15) : [0, 0, 0, 0, 0, 0], tm: { c: f[4], s: f[5], q: f[6] }, clutch: f[15] ?? null, diffAcc: f[16] ?? null, run: f[17] ?? null })
const med = a => { const s = a.filter(Boolean).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null }
const pct = (a, p) => { const x = [...a].sort((m, n) => m - n); return x[Math.min(x.length - 1, Math.floor(p * x.length))] }

// ---- discovery: walk tournament participants, label them by the site's own account status ----
const banned = [], cleanCand = [], tq = [], seenT = new Set()
const pushTours = async u => { const t = await j(`${API}/player/${u}/tournaments`); for (const x of (t?.finished || []).slice(-8)) { const id = idOf(x.url || x['@id']); if (id && !seenT.has(id) && !YOUTH.test(id)) { seenT.add(id); tq.push(id) } } }
async function discover() {
  const lb = await j(`${API}/leaderboards`) || {}
  // a different random slice of each leaderboard every run, so chained runs reach new players
  for (const cat of ['live_rapid', 'live_blitz', 'live_bullet']) for (const p of (lb[cat] || []).sort(() => Math.random() - 0.5).slice(0, 25)) { await pushTours(p.username.toLowerCase()); await sleep(80) }
  tq.sort(() => Math.random() - 0.5)
  console.log('seed tournaments', tq.length)
  while (tq.length && Date.now() - START < DISC_MIN * 60000 && banned.length < 250 && cleanCand.length < 800) {
    const t = await j(`${API}/tournament/${tq.shift()}`); if (!t || YOUTH.test(t.name || '')) continue
    for (const pl of t.players || []) {
      const u = String(pl.username).toLowerCase(); if (!mark(u)) continue
      const p = await j(`${API}/player/${u}`); await sleep(70); if (!p) continue
      const st = p.status || '', bad = st.startsWith('closed:fair_play')
      if (bad) banned.push(u); else if (!st.startsWith('closed')) cleanCand.push(u)
      if (tq.length < 300 && (bad || Math.random() < 0.12)) await pushTours(u)
    }
    save()
  }
  console.log(`discovery done: ${banned.length} banned, ${cleanCand.length} clean candidates`)
}

const pool = makePool(THREADS, CMD)
async function one(u, label) {
  const games = await recent(u, GAMES); if (games.length < 20) return
  const rate = med(games.map(g => g.my))
  // clean players must match the banned ones' rating range, so rating differences cannot fake a signal
  if (label === 'clean' && banRatings.length >= 5 && (rate < pct(banRatings, 0.1) - 150 || rate > pct(banRatings, 0.9) + 150)) return
  let lastProg = 0
  // DEPTH2 (experiment): the same games analysed again at a second depth, stored as G2 for comparison
  const build = async depth => { const rows = []
    for (let i = 0; i < games.length; i++) { const g = games[i]; try { const a = await analyzeGame(g, pool, depth); if (a) rows.push({ g, s: summarize(g, a) }) } catch {}
      if (Date.now() - lastProg > 4000) { lastProg = Date.now(); writeStatus({ running: true, current: { user: hash(u), done: i + 1, total: games.length } }) } }
    return rows.filter(r => r.s.fp && r.s.fp.me[0] >= 14).map(r => ({ g: { t: r.g.t, speed: r.g.speed, my: r.g.my, opp: r.g.opp, score: r.g.score, oppName: '' }, me: side(r.s.fp.me), op: side(r.s.fp.op), dr: r.g.my >= 100 && r.g.opp >= 100 ? r.g.my - r.g.opp : null })) }
  const G = await build(DEPTH); if (G.length < 15) return
  const G2 = DEPTH2 ? await build(DEPTH2) : null
  const rating = med(G.map(x => x.g.my)); if (label === 'banned') banRatings.push(rating)
  results.push({ id: hash(u), label, rating, speed: G[0].g.speed, n: G.length, G, ...(G2 ? { G2, depths: [DEPTH, DEPTH2] } : {}) }); save()
  console.log(`#${results.length} ${label} rating ${rating} games ${G.length}`)
}

if (count('banned') >= T_BANNED && count('clean') >= T_CLEAN) { console.log('targets reached'); writeStatus({ done: true, running: false }); process.exit(0) }
await discover()
// two clean players for every banned one, banned first
const queue = [], cc = cleanCand.sort(() => Math.random() - 0.5)
for (let i = 0, c = 0; i < banned.length || c < cc.length; i++) { if (i < banned.length) queue.push([banned[i], 'banned']); for (let k = 0; k < 2 && c < cc.length; k++) queue.push([cc[c++], 'clean']) }
for (const [u, label] of queue) {
  if (left() < 6 * 60000) break
  if (count('banned') >= T_BANNED && count('clean') >= T_CLEAN) break
  if (count(label) >= (label === 'banned' ? T_BANNED : T_CLEAN)) continue // that group is full
  try { await one(u, label) } catch (e) { console.log('skip', e.message) }
}
save()
const st = { done: count('banned') >= T_BANNED && count('clean') >= T_CLEAN, emptyRuns: results.length ? 0 : (start0.emptyRuns || 0) + 1, running: false }
writeStatus(st); console.log('status', fs.readFileSync(statusFile, 'utf8'))
pool.terminate(); process.exit(0)
