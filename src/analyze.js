import { Chess } from 'chess.js'
import { mean } from './util.js'

export const winPct = cp => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1)
// Calibrated against chess.com's own accuracy on 32 of your reviewed games: the Lichess curve with a steeper slope lands within about 4 points per game.
export const moveAcc = loss => Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.115 * loss) - 3.1669))
// chess.com's move classes, as win-chance points lost: inaccuracy 5, mistake 10, blunder 20.
export const T = { ia: 5, ms: 10, bl: 20 }
export const uciOf = m => m.from + m.to + (m.promotion || '')

function phaseOf(fen, ply) {
  const board = fen.split(' ')[0]
  const pieces = (board.match(/[nbrqNBRQ]/g) || []).length
  return ply < 16 ? 0 : pieces <= 6 ? 2 : 1
}

export function parseGame(g) {
  try {
    const c = new Chess()
    c.loadPgn(g.pgn)
    const hist = c.history({ verbose: true })
    const fens = [hist.length ? hist[0].before : new Chess().fen(), ...hist.map(m => m.after)]
    const clk = [...g.pgn.matchAll(/\[%clk (\d+):(\d+):(\d+(?:\.\d+)?)\]/g)].map(m => +m[1] * 3600 + +m[2] * 60 + +m[3])
    return { fens, sans: hist.map(m => m.san), ucis: hist.map(uciOf), clk: clk.length === hist.length ? clk : [], ph: fens.slice(0, -1).map((f, i) => phaseOf(f, i)).join('') }
  } catch { return null }
}

function terminalEval(fen) {
  const c = new Chess(fen)
  if (c.isCheckmate()) return c.turn() === 'w' ? -10000 : 10000
  if (c.isStalemate() || c.isInsufficientMaterial()) return 0
  return null
}

// Evaluates every position of one game. Returns the raw record that gets stored.
export async function analyzeGame(g, pool, depth, tick, skip) {
  const p = parseGame(g)
  if (!p) return null
  const ev = new Array(p.fens.length), ev2 = new Array(p.fens.length).fill(null), best = new Array(p.fens.length).fill('')
  await Promise.all(p.fens.map(async (fen, i) => {
    const t = terminalEval(fen)
    if (t !== null) { ev[i] = t; return }
    const sk = skip ? skip(fen, i) : null
    if (sk != null) { ev[i] = sk; return }
    const r = await pool.eval(fen, depth, 2)
    if (!r) throw new Error('stopped')
    const l = r.lines.find(x => x.mpv === 1) || r.lines[0]
    ev[i] = l ? l.cp : 0
    const l2 = r.lines.find(x => x.mpv === 2); ev2[i] = l2 ? l2.cp : null
    best[i] = l ? l.pv[0] : ''
    tick && tick(i, ev[i], p.fens.length)
  }))
  return { v: 2, d: depth, ev, ev2, best, sans: p.sans.join(' '), ucis: p.ucis.join(' '), ph: p.ph, clk: p.clk }
}

export const CLASS = [['blunder', T.bl], ['mistake', T.ms], ['inaccuracy', T.ia]]

const bal = fen => { let s = 0; for (const ch of fen.split(' ')[0]) { const v = VAL[ch.toLowerCase()]; if (v) s += ch === ch.toLowerCase() ? -v : v } return s }

// Per-move judgement of one analysed game. Index i = ply i (0 = White's first move). Pass the game's fens to detect sacrifices.
// Classes: brilliant (a sound sacrifice), great (the only move that holds the position), best, excellent, good, then inaccuracy / mistake / blunder.
export function judge(a, fens) {
  const ucis = a.ucis.split(' '), out = []
  for (let i = 0; i < ucis.length; i++) {
    const s = i % 2 === 0 ? 1 : -1
    const before = winPct(s * a.ev[i]), after = winPct(s * a.ev[i + 1])
    const loss = Math.max(0, before - after), isBest = ucis[i] === a.best[i]
    const second = a.ev2 && a.ev2[i] != null ? winPct(s * a.ev2[i]) : null
    // how much win% the best move beat the runner-up by: a big gap is a critical, high-leverage spot
    // (missing it swings the game a lot); a small or negative gap means several moves looked about as
    // good, so finding the true best one among them is harder and more telling than the flat average
    const gap = second != null ? Math.max(0, before - second) : null
    let cls = (CLASS.find(([, t]) => loss >= t) || [''])[0]
    if (!cls) {
      const sac = fens && fens[i + 2] ? s * (bal(fens[i + 2]) - bal(fens[i])) <= -2 : false
      cls = loss < 2 && sac && before < 78 && after >= 42 ? 'brilliant'
        : isBest && second != null && before - second >= 14 && after >= 30 ? 'great'
        : isBest || loss < 0.6 ? 'best' : loss < 2.5 ? 'excellent' : 'good'
    }
    out.push({ i, loss, before, after, cls, acc: moveAcc(loss), ph: +a.ph[i], gap })
  }
  return out
}

// Time left before move i is played by its mover, plus the base clock.
export function baseTime(tc) {
  const m = /^(\d+)(?:\+(\d+))?$/.exec(tc || '')
  return m ? { base: +m[1], inc: +(m[2] || 0) } : null
}

// Facts about my play in one analysed game.
export function myGame(g, a) {
  const J = judge(a), mine = J.filter(m => m.i % 2 === (g.me === 'w' ? 0 : 1))
  const bt = baseTime(g.tc), pressure = []
  mine.forEach(m => {
    const prev = a.clk[m.i - 2] ?? (bt ? bt.base : null)
    m.pressure = !!(bt && prev != null && a.clk.length && (prev < Math.max(20, bt.base * 0.1)))
    m.spent = a.clk.length && prev != null ? Math.max(0, prev + (bt?.inc || 0) - a.clk[m.i]) : null
    pressure.push(m.pressure)
  })
  const sign = g.me === 'w' ? 1 : -1
  const post = a.ev.slice(16).map(v => winPct(sign * v))
  return {
    J, mine, acc: mean(mine.map(m => m.acc)),
    maxWin: post.length ? Math.max(...post) : 50, minWin: post.length ? Math.min(...post) : 50,
    errors: mine.filter(m => m.loss >= T.ms),
  }
}

// Rebuilds the positions of an analysed game from its stored moves (no PGN needed).
export function fromAnalysis(a) {
  const c = new Chess(), fens = [c.fen()], sans = a.sans.split(' ')
  for (const m of sans) { c.move(m); fens.push(c.fen()) }
  return { fens, sans, ucis: a.ucis.split(' '), clk: a.clk || [], ph: a.ph }
}

const PIECE = 'PNBRQK'
const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 }

// Which tactic was on the board: flags f free piece, x fork, k mate, p promotion, m missed capture.
export function bestMotifs(fen, bestUci) {
  let out = ''
  try {
    const c = new Chess(fen), me = c.turn(), opp = me === 'w' ? 'b' : 'w'
    const bm = c.moves({ verbose: true }).find(k => uci(k) === bestUci)
    if (!bm) return out
    if (bm.captured && (VAL[bm.captured] >= 3 && (c.attackers(bm.to, opp).length === 0 || VAL[bm.captured] > VAL[bm.piece]))) out += 'f'
    else if (bm.captured) out += 'm'
    if (bm.promotion) out += 'p'
    c.move(bm)
    if (c.isCheckmate()) out += 'k'
    else {
      let n = 0
      for (const row of c.board()) for (const q of row) {
        if (!q || q.color !== opp || (VAL[q.type] < 3 && q.type !== 'k')) continue
        if (c.attackers(q.square, me).includes(bm.to) && (q.type === 'k' || VAL[q.type] > VAL[bm.piece] || c.attackers(q.square, opp).length === 0)) n++
      }
      if (n >= 2) out += 'x'
    }
  } catch {}
  return out
}
const sanPiece = san => (san[0] === 'O' ? 'K' : /[NBRQK]/.test(san[0]) ? san[0] : 'P')
const uci = m => m.from + m.to + (m.promotion || '')

// A few hundred bytes per game that every statistic can be built from, so the full records are only
// fetched when you open a game or train on it. v2 adds the opponent's side, the kind of position each
// of your errors happened in, and the first move where an opening went wrong.
// Positions where one move clearly beat the alternatives (needs the second engine line), and how often a side found it.
// An engine used only now and then shows up here even when the average looks normal.
export function sharpStats(Jx, a, ucis) {
  let n = 0, hit = 0
  for (const x of Jx) {
    if (x.i < 20 || x.before <= 15 || x.before >= 85 || !a.ev2 || a.ev2[x.i] == null) continue
    if (x.before - winPct((x.i % 2 === 0 ? 1 : -1) * a.ev2[x.i]) < 10) continue
    n++; if (ucis[x.i] === a.best[x.i]) hit++
  }
  return [n, hit]
}

// Does the time spent follow how sharp the position is? Sums for a Pearson correlation between difficulty (how far the best move beat the
// second best, in win chance) and seconds spent. Honest players think longer when the position is sharper; a flat or reversed link is unusual.
export function timeDiffStats(Jx, a, ucis) {
  let n = 0, sx = 0, sy = 0, sxy = 0, sxx = 0, syy = 0
  if (!a.ev2 || !a.clk || a.clk.length !== ucis.length) return [0, 0, 0, 0, 0, 0]
  for (const x of Jx) {
    if (x.i < 10 || a.ev2[x.i] == null) continue
    const pv = a.clk[x.i - 2]; if (pv == null) continue
    const d = Math.min(50, Math.max(0, x.before - winPct((x.i % 2 === 0 ? 1 : -1) * a.ev2[x.i]))), t = Math.min(60, Math.max(0, pv - a.clk[x.i]))
    n++; sx += d; sy += t; sxy += d * t; sxx += d * d; syy += t * t
  }
  return [n, +sx.toFixed(1), +sy.toFixed(1), +sxy.toFixed(1), +sxx.toFixed(1), +syy.toFixed(1)]
}

// Endgame family at the first endgame position: pawn, minor pieces, rook, rook and minor pieces, queen, queen and pieces.
export function etype(fen) {
  const b = fen.split(' ')[0], c = ch => (b.match(new RegExp(ch, 'gi')) || []).length, R = c('r'), Q = c('q'), M = c('b') + c('n')
  return Q + R + M === 0 ? 'Pawn' : !Q && !R ? 'Minor pieces' : !Q && !M ? 'Rook' : !Q ? 'Rook and minor pieces' : !R && !M ? 'Queen' : 'Queen and pieces'
}

export function summarize(g, a) {
  const m = myGame(g, a), mine = m.mine, ucis = a.ucis.split(' '), sans = a.sans.split(' ')
  const par = g.me === 'w' ? 0 : 1, opp = m.J.filter(x => x.i % 2 !== par)
  const per = k => [0, 1, 2].map(p => mine.filter(x => x.ph === p && x.cls === k).length)
  const timed = mine.filter(x => x.spent != null), sign = g.me === 'w' ? 1 : -1
  const blunders = mine.filter(x => x.loss >= T.bl)
  let fens = null
  try { const c = new Chess(); fens = [c.fen()]; for (const x of sans) { c.move(x); fens.push(c.fen()) } } catch {}
  const speed = x => (x.spent == null ? 'n' : x.pressure ? 'p' : x.spent < 3 ? 'f' : x.spent >= 15 ? 's' : 'n')
  const state = x => (x.before >= 65 ? 'A' : x.before <= 35 ? 'B' : 'E')
  const elig = mine.filter(x => x.before >= 25)
  const count = (arr, f, n) => { const o = new Array(n).fill(0); arr.forEach(x => o[f(x)]++); return o }
  const tag = x => {
    let flags = ''
    if (fens) {
      try {
        const nxt = new Chess(fens[x.i + 1]).moves({ verbose: true }).find(k => uci(k) === a.best[x.i + 1])
        if (nxt?.captured && VAL[nxt.captured] >= 3) flags += 'h'
      } catch {}
      flags += bestMotifs(fens[x.i], a.best[x.i]).replace('m', sans[x.i].includes('x') ? '' : 'm')
    }
    return sanPiece(sans[x.i]) + x.ph + speed(x) + state(x) + flags
  }
  // fair-play inputs per side: [moves, accuracy, first-choice match % outside decided positions or null, near-perfect flag, clock-time count, sum, sum of squares]
  const sideFP = Jx => {
    const acc = mean(Jx.map(x => x.acc)), elig = Jx.filter(x => x.i >= 20 && x.before > 10 && x.before < 90)
    let c = 0, sm = 0, q = 0
    // longest run of near-flawless moves in undecided positions, the same measure fairlib.js's full-record path already used
    let run = 0, runBest = 0; for (const x of Jx) { if (x.i < 14) continue; if (x.before <= 10 || x.before >= 90 || x.loss >= 1.5) run = 0; else runBest = Math.max(runBest, ++run) }
    if (a.clk && a.clk.length === ucis.length) Jx.forEach(x => { if (x.i < 10) return; const pv = a.clk[x.i - 2]; if (pv != null) { const t = Math.max(0, pv - a.clk[x.i]); c++; sm += t; q += t * t } })
    const gapped = elig.filter(x => x.gap != null)
    const clutch = gapped.length >= 6 ? mean([...gapped].sort((x, y) => y.gap - x.gap).slice(0, Math.max(3, Math.ceil(gapped.length / 3))).map(x => x.acc)) : null
    const diffAcc = gapped.length >= 6 ? (() => { const ws = gapped.map(x => 1 / (x.gap + 3)), sw = ws.reduce((t, w) => t + w, 0); return gapped.reduce((t, x, j) => t + x.acc * ws[j], 0) / sw })() : null
    // "near perfect" uses post-opening accuracy: book moves are near-free accuracy and inflate a short,
    // theory-heavy game into looking flawless (the Niemann case: several cited "perfect" games were
    // under 32 total moves, much of that opening theory, not real decision-making)
    const postAcc = elig.length ? mean(elig.map(x => x.acc)) : acc
    // decoy blunders: a deliberate "mistake" meant to look human costs nothing played where the result is
    // already settled; a genuine blunder has no reason to cluster there (same measure as fairlib.js's full-record path)
    const decided = x => x.before <= 10 || x.before >= 90, errs = Jx.filter(x => x.loss >= T.ms)
    const errDecided = errs.length >= 4 ? errs.filter(decided).length / errs.length : null
    const allDecided = Jx.length ? Jx.filter(decided).length / Jx.length : null
    return [Jx.length, +acc.toFixed(1), elig.length >= 8 ? +((elig.filter(x => ucis[x.i] === a.best[x.i]).length / elig.length) * 100).toFixed(1) : null, postAcc >= 96 && Jx.length >= 25 ? 1 : 0, c, +sm.toFixed(1), +q.toFixed(1), ...sharpStats(Jx, a, ucis), ...timeDiffStats(Jx, a, ucis), clutch == null ? null : +clutch.toFixed(1), diffAcc == null ? null : +diffAcc.toFixed(1), runBest, errDecided == null ? null : +errDecided.toFixed(3), allDecided == null ? null : +allDecided.toFixed(3)]
  }
  const first = mine.find(x => x.i < 24 && x.loss >= T.ms && a.best[x.i])
  let fd = null
  if (first && fens) { try { const b = a.best[first.i], bs = new Chess(fens[first.i]).move({ from: b.slice(0, 2), to: b.slice(2, 4), promotion: b[4] }).san; fd = [first.i, Math.round(first.loss), sans[first.i], bs] } catch {} }
  return {
    v: 5, d: a.d, fp: { me: sideFP(mine), op: sideFP(opp) },
    eg: (() => { const i = a.ph.indexOf('2'); return i >= 0 && fens ? [etype(fens[i]), mine.filter(x => x.ph === 2).length, mine.filter(x => x.ph === 2 && x.loss >= T.ms).length] : null })(), acc: +m.acc.toFixed(1),
    mv: [0, 1, 2].map(p => mine.filter(x => x.ph === p).length), ia: per('inaccuracy'), ms: per('mistake'), bl: per('blunder'),
    mx: Math.round(m.maxWin), mn: Math.round(m.minWin),
    ae: mine.filter(x => x.before >= 70 && x.loss >= T.ms).length,
    pm: mine.filter(x => x.pressure).length, pe: mine.filter(x => x.pressure && x.loss >= T.ms).length,
    cm: mine.filter(x => !x.pressure && x.spent != null).length, ce: mine.filter(x => !x.pressure && x.spent != null && x.loss >= T.ms).length,
    ts: Math.round(timed.reduce((t, x) => t + x.spent, 0)), tn: timed.length,
    bt: blunders.filter(x => x.spent != null).length, fb: blunders.filter(x => x.spent != null && x.spent < 3).length,
    e10: a.ev.length > 20 ? Math.round(winPct(sign * a.ev[20])) : null,
    oob: mine.length > 8 && mine[8].before < 40 ? 1 : 0,
    errs: mine.filter(x => x.loss >= T.ms && x.before >= 25 && a.best[x.i] && a.best[x.i] !== ucis[x.i]).map(x => [x.i, Math.round(x.loss), ucis[x.i], a.best[x.i], tag(x), fens ? fens[x.i] : '']),
    // baselines for the pattern finder: how many of my moves fell in each kind of position
    bs: { pc: count(elig, x => PIECE.indexOf(sanPiece(sans[x.i])), 6), ph: count(elig, x => x.ph, 3), st: count(elig, x => 'ABE'.indexOf(state(x)) < 0 ? 2 : { A: 0, E: 1, B: 2 }[state(x)], 3), sp: count(elig, x => 'fpsn'.indexOf(speed(x)), 4) },
    // the opponent in the same games, for the peer comparison
    oa: +mean(opp.map(x => x.acc)).toFixed(1), omv: [0, 1, 2].map(p => opp.filter(x => x.ph === p).length),
    oer: [0, 1, 2].map(p => opp.filter(x => x.ph === p && x.loss >= T.ms).length), obl: opp.filter(x => x.loss >= T.bl).length,
    fd,
  }
}
