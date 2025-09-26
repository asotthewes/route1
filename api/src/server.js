// @ts-check
import Fastify from 'fastify'
import pkg from 'pg'
import Redis from 'ioredis'
import crypto from 'crypto'

const { Pool } = pkg

const app = Fastify({ logger: true })
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const redis = new Redis(process.env.REDIS_URL)

function normalizeAnswer(s){
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ')
}

// simple scrypt verify for 'scrypt:<salt>:<hexhash>' format; else plain:
async function verifyAnswer(stored, input){
  if(!stored) return false
  if(stored.startsWith('plain:')){
    return stored.slice(6) === normalizeAnswer(input)
  }
  if(stored.startsWith('scrypt:')){
    const [,salt,hex] = stored.split(':')
    const key = await new Promise((res,rej)=>{
      crypto.scrypt(normalizeAnswer(input), salt, 32, (err,dk)=> err?rej(err):res(dk))
    })
    return Buffer.from(hex, 'hex').equals(key)
  }
  // fallback equal
  return stored === normalizeAnswer(input)
}

app.get('/api/health', async ()=> ({ ok:true }))

app.post('/api/teams', async (req, reply)=>{
  const body = req.body || {}
  const name = (body.name || 'Team').toString().slice(0,80)
  const join_code = Math.random().toString(36).slice(2,8).toUpperCase()
  const { rows } = await pool.query(
    'INSERT INTO teams (name, join_code) VALUES ($1,$2) RETURNING id, name, join_code, created_at',
    [name, join_code]
  )
  return rows[0]
})

app.post('/api/runs/start', async (req, reply)=>{
  const { teamId, routeId } = req.body || {}
  // allow alias 'demo-route'
  const r = await pool.query('SELECT id FROM routes WHERE id=$1 OR title=$1 OR city=$1', [routeId])
  if(!r.rows[0]) return reply.code(404).send({ error: 'Route not found'})
  const route_id = r.rows[0].id
  const ins = await pool.query(
    'INSERT INTO runs (route_id, team_id) VALUES ($1,$2) RETURNING id, started_at',
    [route_id, teamId]
  )
  return ins.rows[0]
})

app.get('/api/routes/:id', async (req, reply)=>{
  const id = req.params.id
  const r = await pool.query('SELECT * FROM routes WHERE id=$1 OR title=$1 OR city=$1', [id])
  if(!r.rows[0]) return reply.code(404).send({ error: 'Route not found'})
  const route = r.rows[0]
  const stops = await pool.query(
    'SELECT id, title, lat, lon, radius_m, order_index, qr_code FROM stops WHERE route_id=$1 ORDER BY order_index ASC',
    [route.id]
  )
  return { id: route.id, title: route.title, city: route.city, stops: stops.rows }
})

app.post('/api/stops/answer', async (req, reply)=>{
  const { runId, stopId, answer } = req.body || {}
  if(!runId || !stopId) return reply.code(400).send({ error:'runId/stopId required' })

  // rate-limit
  const key = `rl:${runId}:${stopId}`
  const tries = await redis.incr(key)
  if(tries === 1) await redis.expire(key, 30)
  if(tries > 25) return reply.code(429).send({ error: 'Too many attempts' })

  const st = await pool.query('SELECT answer_hash FROM stops WHERE id=$1', [stopId])
  if(!st.rows[0]) return reply.code(404).send({ error:'Stop not found' })

  const ok = await verifyAnswer(st.rows[0].answer_hash, answer)
  if(!ok) return reply.code(200).send({ correct:false })

  await pool.query(
    `INSERT INTO progress(team_id, stop_id, solved_at)
     SELECT team_id, $1, now() FROM runs WHERE id=$2
     ON CONFLICT (team_id, stop_id) DO UPDATE SET solved_at=excluded.solved_at`,
     [stopId, runId]
  )
  return { correct:true }
})

app.post('/api/stops/hint', async (req, reply)=>{
  const { runId, stopId } = req.body || {}
  const st = await pool.query('SELECT hint_markdown, hint_penalty FROM stops WHERE id=$1', [stopId])
  if(!st.rows[0]) return reply.code(404).send({ error:'Stop not found' })
  await pool.query(
    `INSERT INTO progress(team_id, stop_id, used_hint)
     SELECT team_id, $1, true FROM runs WHERE id=$2
     ON CONFLICT (team_id, stop_id) DO UPDATE SET used_hint=true`,
     [stopId, runId]
  )
  return { hint: st.rows[0].hint_markdown, penalty: st.rows[0].hint_penalty }
})

app.post('/api/runs/finish', async (req, reply)=>{
  const { runId } = req.body || {}
  const up = await pool.query('UPDATE runs SET finished_at=now() WHERE id=$1 RETURNING id, finished_at', [runId])
  return up.rows[0] || { }
})

const port = 3000
app.listen({ port, host: '0.0.0.0' }).catch(err => {
  app.log.error(err)
  process.exit(1)
})
