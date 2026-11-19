// PGN to game record, copied from STEMMA's lab.js.
export const tags = pgn => { const o = {}; for (const m of pgn.matchAll(/\[(\w+) "([^"]*)"\]/g)) o[m[1]] = m[2]; return o }
const speedOf = tc => { if (!tc || tc === '-') return 'unlimited'; if (tc.includes('/')) return 'daily'; const [b, i = 0] = tc.split('+').map(Number), t = b + i * 40; return t < 180 ? 'bullet' : t < 480 ? 'blitz' : t < 1500 ? 'rapid' : 'classical' }
const nice = s => s.replace(/\.{2,}.*$/, '').replace(/-/g, ' ').replace(/\s\d.*$/, '').trim()

export function normGame(pgn, user, site) {
  const h = tags(pgn)
  if (!h.White || !h.Black || (h.Variant && h.Variant !== 'Standard') || h.Result === '*' || h.SetUp) return null
  const me = h.White.toLowerCase() === user.toLowerCase() ? 'w' : 'b'
  const score = h.Result === '1/2-1/2' ? 0.5 : (h.Result === '1-0') === (me === 'w') ? 1 : 0
  const d = (h.UTCDate || h.Date || '1970.01.01').replace(/\./g, '-'), t = Date.parse(d + 'T' + (h.UTCTime || h.StartTime || '00:00:00') + 'Z')
  const link = h.Link || h.Site || ''
  const op = h.Opening || (h.ECOUrl ? nice(h.ECOUrl.split('/openings/')[1] || '') : '')
  return {
    id: site + ':' + (link.split('/').pop() || t), site, url: link, t, me, pgn,
    white: h.White, black: h.Black, wElo: +h.WhiteElo || 0, bElo: +h.BlackElo || 0, score,
    my: me === 'w' ? +h.WhiteElo || 0 : +h.BlackElo || 0, opp: me === 'w' ? +h.BlackElo || 0 : +h.WhiteElo || 0,
    oppName: me === 'w' ? h.Black : h.White, tc: h.TimeControl || '', speed: speedOf(h.TimeControl), rated: !/casual|unrated/i.test(h.Event || ''), opening: op, end: h.Termination || '',
  }
}

