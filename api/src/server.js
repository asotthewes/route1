// @ts-check
import Fastify from 'fastify'
import pkg from 'pg'
import Redis from 'ioredis'
import crypto from 'crypto'

const { Pool } = pkg

// ----- Helpers
const app = Fastify({ logger: true })

function maskDbUrl(url) {
  try {
    const u = new URL(url)
    if (u.username) u.username = '***'
    if (u.password) u.password = '***'
    return u.toString()
  } catch {
    return '<invalid>'
  }
}

function normalizeAnswer(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ')
}

// simple scrypt verify for 'plain:<answer>' or 'scrypt:<salt>:<hexhash>'
async function verifyAnswer(stored, input) {
  if (!stored) return false
  if (stored.startsWith('plain:')) {
    return stored.slice(6) === normalizeAnswer(input)
  }
  if (stored.startsWith('scrypt:')) {
    const [, salt, hex] = stored.split(':')
    const key = await new Promise((res, rej) => {
      crypto.scrypt(normalizeAnswer(input), salt, 32, (err, dk) => (err ? rej(err) : res(dk)))
    })
    return Buffer.from(hex, 'hex').equals(key)
  }
  return stored === normalizeAnswer(input)
}

// ----- Environment & clients
const DB_URL = process.env.DATABASE_URL || ''
const REDIS_URL = process.env.REDIS_URL || ''

// Validate DATABASE_URL early with friendly logs
(function validateDbUrl() {
  if (!DB_URL) {
    app.log.error('DATABASE_URL ontbreekt.')
    process.exit(1)
  }
  let u
  try {
    u = new URL(DB_URL)
  } catch (e) {
    app.log.error({ msg: 'Ongeldige DATABASE_URL', detail: String(e) })
    process.exit(1)
  }
  if (!/^postgres(ql)?:$/.test(u.protocol)) {
    app.log.error(`DATABASE_URL protocol moet postgres:// of postgresql:// zijn (nu: ${u.protocol})`)
    process.exit(1)
  }
  // Als wachtwoord niet aanwezig is, geeft URL.password een lege string => falsy
  if (!u.password) {
    app.log.error(
      `DATABASE_URL mist het wachtwoord-gedeelte (user:password@...). Huidige (gemaskeerd): ${maskDbUrl(DB_URL)}`
    )
    process.exit(1)
  }
})()

// Optioneel SSL naar Postgres via env toggle (voor bv. managed PG)
const pgUseSsl =
  (process.env.PGSSL || process.env.DATABASE_SSL || '').toLowerCase() === 'require'

const pool = new Pool({
  connectionString: DB_URL,
  ...(pgUseSsl ? { ssl: { rejectUnauthorized: false } } : {}),
})

// Redis is optioneel; rate limiting schakelt dan uit
let redis = null
if (REDIS_URL) {
  redis = new Redis(REDIS_URL)
  redis.on('error', (err) => app.log.warn({ msg: 'Redis error', err: String(err) }))
} else {
  app.log.warn('REDIS_URL niet gezet — rate limiting voor /api/stops/answer is uitgeschakeld.')
}

// ----- Globale error handler (mooie 500’s met ID)
app.setErrorHandler((err, req, reply) => {
  req.log.error(err)
  const showDetail = (process.env.NODE_ENV || 'production') !== 'production'
  reply.code(500).send({
    error: 'Internal Server Error',
    ...(showDetail ? { detail: err.message } : {}),
  })
})

// ----- Routes
app.get('/api/health', async () => ({ ok: true }))

// Kleine startup-check endpoint (handig om DB-connect te testen)
app.get('/api/_dbcheck', async (req, reply) => {
  const r = await pool.query('SELECT 1 as ok')
  return { db: r.rows[0].ok === 1 }
})

app.post('/api/teams', async (req, reply) => {
  const body = req.body || {}
  const name = (body.name || 'Team').toString().slice(0, 80)
  const join_code = Math.random().toString(36).slice(2, 8).toUpperCase()
  const { rows } = await pool.query(
    'INSERT INTO teams (name, join_code) VALUES ($1,$2) RETURNING id, name, join_code, created_at',
    [name, join_code]
  )
  return rows[0]
})

app.post('/api/runs/start', async (req, reply) => {
  const { teamId, routeId } = req.body || {}
  if (!teamId || !routeId) return reply.code(400).send({ error: 'teamId en routeId zijn verplicht' })

  const r = await pool.query('SELECT id FROM routes WHERE id=$1 OR title=$1 OR city=$1', [routeId])
  if (!r.rows[0]) return reply.code(404).send({ error: 'Route niet gevonden' })

  const ins = await pool.query(
    'INSERT INTO runs (route_id, team_id) VALUES ($1,$2) RETURNING id, started_at',
    [r.rows[0].id, teamId]
  )
  return ins.rows[0]
})

app.get('/api/routes/:id', async (req, reply) => {
  const id = req.params.id
  const r = await pool.query('SELECT * FROM routes WHERE id=$1 OR title=$1 OR city=$1', [id])
  if (!r.rows[0]) return reply.code(404).send({ error: 'Route niet gevonden' })
  const route = r.rows[0]
  const stops = await pool.query(
    'SELECT id, title, lat, lon, radius_m, order_index, qr_code FROM stops WHERE route_id=$1 ORDER BY order_index ASC',
    [route.id]
  )
  return { id: route.id, title: route.title, city: route.city, stops: stops.rows }
})

app.post('/api/stops/answer', async (req, reply) => {
  const { runId, stopId, answer } = req.body || {}
  if (!runId || !stopId) return reply.code(400).send({ error: 'runId/stopId verplicht' })

  // Rate-limit met Redis; als Redis ontbreekt of faalt, slaan we RL over
  if (redis) {
    try {
      const key = `rl:${runId}:${stopId}`
      const tries = await redis.incr(key)
      if (tries === 1) await redis.expire(key, 30)
      if (tries > 25) return reply.code(429).send({ error: 'Te veel pogingen' })
    } catch (e) {
      req.log.warn({ msg: 'Rate-limit skip (Redis issue)', err: String(e) })
    }
  }

  const st = await pool.query('SELECT answer_hash FROM stops WHERE id=$1', [stopId])
  if (!st.rows[0]) return reply.code(404).send({ error: 'Stop niet gevonden' })

  const ok = await verifyAnswer(st.rows[0].answer_hash, answer)
  if (!ok) return reply.code(200).send({ correct: false })

  await pool.query(
    `INSERT INTO progress(team_id, stop_id, solved_at)
     SELECT team_id, $1, now() FROM runs WHERE id=$2
     ON CONFLICT (team_id, stop_id) DO UPDATE SET solved_at=excluded.solved_at`,
    [stopId, runId]
  )
  return { correct: true }
})

app.post('/api/stops/hint', async (req, reply) => {
  const { runId, stopId } = req.body || {}
  if (!runId || !stopId) return reply.code(400).send({ error: 'runId/stopId verplicht' })

  const st = await pool.query('SELECT hint_markdown, hint_penalty FROM stops WHERE id=$1', [stopId])
  if (!st.rows[0]) return reply.code(404).send({ error: 'Stop niet gevonden' })

  await pool.query(
    `INSERT INTO progress(team_id, stop_id, used_hint)
     SELECT team_id, $1, true FROM runs WHERE id=$2
     ON CONFLICT (team_id, stop_id) DO UPDATE SET used_hint=true`,
    [stopId, runId]
  )
  return { hint: st.rows[0].hint_markdown, penalty: st.rows[0].hint_penalty }
})

app.post('/api/runs/finish', async (req, reply) => {
  const { runId } = req.body || {}
  if (!runId) return reply.code(400).send({ error: 'runId verplicht' })
  const up = await pool.query('UPDATE runs SET finished_at=now() WHERE id=$1 RETURNING id, finished_at', [runId])
  return up.rows[0] || {}
})

// ----- Startup
const port = Number(process.env.PORT || 3000)

async function start() {
  // Proactieve DB check (geeft meteen heldere fout als creds niet kloppen)
  try {
    const r = await pool.query('SELECT 1')
    if (r.rows[0]?.['?column?'] !== 1 && r.rows[0]?.ok !== 1) {
      app.log.warn('Onverwacht DB check-resultaat, maar connectie lijkt oké.')
    }
    app.log.info(`Database connectie OK (${maskDbUrl(DB_URL)})`)
  } catch (e) {
    app.log.error({ msg: 'Kan niet verbinden met database', detail: String(e) })
    process.exit(1)
  }

  try {
    await app.listen({ port, host: '0.0.0.0' })
    app.log.info(`Server luistert op http://0.0.0.0:${port}`)
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

start()

// Graceful shutdown
process.on('SIGTERM', async () => {
  app.log.info('SIGTERM ontvangen, afsluiten...')
  try { await app.close() } catch {}
  try { await pool.end() } catch {}
  try { if (redis) await redis.quit() } catch {}
  process.exit(0)
})
