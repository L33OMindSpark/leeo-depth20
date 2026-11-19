export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
export const $ = (s, r = document) => r.querySelector(s)
export const $$ = (s, r = document) => [...r.querySelectorAll(s)]
export const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0)
export const sd = a => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))) }
export const sleep = ms => new Promise(r => setTimeout(r, ms))
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v))
export const lerp = (a, b, t) => a + (b - a) * t
export const ease = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
export const ls = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d } catch { return d } }
export const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch {} }
export const dateStr = t => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
export const html = s => { const t = document.createElement('template'); t.innerHTML = s.trim(); return t.content.firstElementChild }

// tiny IndexedDB key-value store for cached engine reviews
let dbp
const db = () => dbp || (dbp = new Promise((res, rej) => { const r = indexedDB.open('stemma', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) }))
const tx = async (mode, fn) => { try { const d = await db(); return await new Promise(res => { const t = d.transaction('kv', mode), o = fn(t.objectStore('kv')); t.oncomplete = () => res(o.result); t.onerror = () => res(undefined) }) } catch { return undefined } }
export const kvGet = k => tx('readonly', s => s.get(k))
export const kvSet = (k, v) => tx('readwrite', s => s.put(v, k))

// animate a number into a node
export function countUp(node, to, { dec = 0, ms = 900, suffix = '' } = {}) {
  const t0 = performance.now()
  const f = now => { const p = Math.min(1, (now - t0) / ms); node.textContent = (to * (1 - Math.pow(1 - p, 3))).toFixed(dec) + suffix; if (p < 1) requestAnimationFrame(f) }
  requestAnimationFrame(f)
}

// scroll reveal: fades and lifts blocks in as they enter the screen. instant = show now (live repaints must not replay it)
export function reveal(root, instant) {
  const els = [...root.querySelectorAll('.sub2,.rcard,.stat,.rnote,.ovw,.rgrid>*,.irow')]
  const seen = new Set(); let n = 0
  const io = 'IntersectionObserver' in window && !instant ? new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target) } }), { threshold: 0.06 }) : null
  els.forEach(el => { if (seen.has(el)) return; seen.add(el); el.classList.add('rvl'); el.style.setProperty('--d', (n++ % 5) * 55 + 'ms'); io ? io.observe(el) : el.classList.add('in', 'now') })
  // safety: if the observer never reports anything (hidden pane, odd webview), show everything rather than leave blocks invisible
  if (io) setTimeout(() => { if (!els.some(e => e.classList.contains('in'))) els.forEach(e => e.classList.add('in')) }, 900)
}
// count a percentage up inside an element: <b data-cu="85">
export function countAll(root) {
  root.querySelectorAll('[data-cu]').forEach(el => { const to = +el.dataset.cu, t0 = performance.now(); const f = now => { const p = Math.min(1, (now - t0) / 900); el.textContent = Math.round(to * (1 - Math.pow(1 - p, 3))); if (p < 1) requestAnimationFrame(f) }; requestAnimationFrame(f) })
}
