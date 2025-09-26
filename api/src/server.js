// @ts-check
import Fastify from 'fastify'
import pkg from 'pg'
import Redis from 'ioredis'
import crypto from 'crypto'
import fs from 'fs'

const { Pool } = pkg
const app = Fastify({ logger: true })

// ---------- helpers
function readMaybeFile(pathOrValue) {
  if (!pathOrValue) return ''
  try {
    // Als het een bestaand pad is: lees het (voor secrets)
    if (fs.existsSync(pathOrValue)) {
      return fs.readFileSync(pathOrValue, 'utf8')
    }
  } catch {}
  return String(pathOrValue)
}

function trimIfString(v) {
  return typeof v === 'string' ? v.trim() : v
}

function normalizeAnswer(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ')
}

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

function maskValue(v, keep = 2) {
  if (!v) return ''
  const s = String(v)
  if (s.length <= keep) return '*'.repeat(s.length)
  return s.slice(0, keep) + '*'.repeat(Math.max(0, s.length - keep))
}

function maskDbConfig(c) {
  return {
    host: c.host,
    port: c.port,
    database: c.database,
    user: c.user ? maskValue(c.user) : '',
    password: c.password ? `${'*'.repeat(Math.min(12, String(c.password).length))} (len=${String(c.password).length})` : '<none>',
    ssl: !!c.ssl,
  }
}

// ---------- DB config (URL of losse env of *_FILE)
function getDbConfigFromEnv() {
  // 1) DATABASE_URL of DATABASE_URL_FILE
  let dbUrl = trimIfString(process.env.DATABASE_URL)
  const dbUrlFile = trimIfString(process.env.DATABASE_URL_FILE)
  if (!dbUrl && dbUrlFile) dbUrl = trimIfString(readMaybeFile(dbUrlFile))

  // 2) Losse PG* env (met *_FILE support)
  const PGHOST = trimIfString(process.env.PGHOST) || undefined
  const PGPORT = process.env.PGPORT ? Number(process.env.PGPORT) : undefined
  const PGDATABASE = trimIfString(process.env.PGDATABASE) || undefined
  const PGUSER = trimIfString(process.env.PGUSER) || undefined
  let PGPASSWORD = trimIfString(process.env.PGPASSWORD) || undefined
  const PGPASSWORD_FILE = trimIfString(process.env.PGPASSWORD_FILE)
  if (!PGPASSWORD && PGPASSWORD_FILE) {
    PGPASSWORD = trimIfString(readMaybeFile(PGPASSWORD_FILE))
  }

  // SSL toggles
  const sslToggle = (process.env.PGSSL || process.env.DATABASE_SSL || '').toLowerCase()
  const wantSsl = sslToggle === 'require' || sslToggle === 'true'
  let ssl = wantSsl ? { rejectUnauthorized: false } : undefined

  if (dbUrl) {
    try {
      const u = new URL(dbUrl)
      if (!/^postgres(ql)?:$/.test(u.protocol)) {
        throw new Error(`Protocol moet postgres:// of postgresql:// zijn (nu: ${u.protocol})`)
      }
      // Wachtwoord kan in authority óf als search param staan
      let password = u.password
      const qpPassword = u.searchParams.get('password')
      if (!password && qpPassword) password = qpPassword

      const port = u.port ? Number(u.port) : 5432
      const sslmode = (u.searchParams.get('sslmode') || '').toLowerCase()
      if (sslmode === 'require' || sslmode === 'prefer' || sslmode === 'verify-full') {
        ssl = { rejectUnauthorized: false }
      }

      return {
        host: u.hostname,
        port,
        database: u.pathname.replace(/^\//, '') || undefined,
        user: decodeURIComponent(u.username || ''),
        password: typeof password === 'string' ? decodeURIComponent(password) : password,
        ssl,
      }
    } catch (e) {
      app.log.error({ msg: 'Ongeldige DATABASE_URL', detail: String(e) })
      process.exit(1)
    }
  }

  // Val terug op losse PG* variabelen
  return {
    host: PGHOST,
    port: PGPORT || 5432,
    database: PGDATABASE,
    user: PGUSER,
    password: PGPASSWORD,
    ssl,
  }
}

const dbConfig = getDbConfigFromEnv()

// Validatie: alles moet aanwezig zijn en password moet string zijn
if (!dbConfig.host || !dbConfig.database || !dbConfig.user) {
  app.log.error({ msg: 'DB configuratie onvolledig', config: maskDbConfig(dbConfig) })
  process.exit(1)
}
if (typeof dbConfig.password !== 'string' || dbConfig.password === '') {
  app.log.error({ msg: 'DB wachtwoord ontbreekt of is geen string', config: maskDbConfig(dbConfig) })
  process.exit(1)
}

const pool = new Pool(dbConfig)

// Redis optioneel
let redis = null
const REDIS_URL = process.env.REDIS_URL || ''
if (REDIS_URL) {
  redis = new Redis(REDIS_URL)
  redis.on('error', (err) => app.log.warn({ msg: 'Redis error', err: String(err) }))
} else {
  app.log.warn('REDIS_URL niet gezet — rate limiting is uit.')
}

// ---------- error handler
app.setErrorHandler((err, req, reply) => {
  req.log.error(err)
  const showDetail = (process.env.NODE_ENV || 'production') !== 'production'
  reply.code(500).send({ error: 'Internal Server Error', ...(showDetail ? { detail: err.message } : {}) })
})

// ---------- routes
app.get('/api/health', async () => ({ ok: true }))

app.get('/api/_dbcheck', async () => {
  const r = await pool.query('SELECT 1 AS ok')
  return { db: r.rows[0].ok === 1 }
})

app.post('/api/teams', async (req) => {
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

const port = Number(process.env.PORT || 3000)

async function start() {
  try {
    const r = await pool.query('SELECT 1 AS ok')
    if (r.rows[0]?.ok !== 1) app.log.warn('Onverwacht DB check-resultaat, maar connectie lijkt oké.')
    app.log.info({ msg: 'DB config OK', config: maskDbConfig(dbConfig) })
  } catch (e) {
    app.log.error({ msg: 'Kan niet verbinden met database', detail: String(e), config: maskDbConfig(dbConfig) })
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

process.on('SIGTERM', async () => {
  app.log.info('SIGTERM ontvangen, afsluiten...')
  try { await app.close() } catch {}
  try { await pool.end() } catch {}
  try { if (redis) await redis.quit() } catch {}
  process.exit(0)
})
