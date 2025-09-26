import React, { useEffect, useMemo, useState } from 'react'
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet'

const API = import.meta.env.VITE_API_BASE || '/api'

type Stop = {
  id: string; title: string; lat: number; lon: number; radius_m: number; order_index: number; qr_code: string;
}
type RouteData = { id: string; title: string; city?: string; stops: Stop[] }

function useRoute(routeId: string) {
  const [route, setRoute] = useState<RouteData | null>(null)
  useEffect(() => {
    fetch(`${API}/routes/${routeId}`).then(r => r.json()).then(setRoute).catch(console.error)
  }, [routeId])
  return route
}

function getDistanceMeters(a:{lat:number,lon:number}, b:{lat:number,lon:number}){
  const toRad = (x:number)=>x*Math.PI/180;
  const R=6371000;
  const dLat=toRad(b.lat-a.lat);
  const dLon=toRad(b.lon-a.lon);
  const s1=Math.sin(dLat/2)**2 + Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(s1));
}

export default function App(){
  const [teamName, setTeamName] = useState<string>('Team A')
  const [joinCode, setJoinCode] = useState<string>('')
  const [teamId, setTeamId] = useState<string>('')
  const [routeId, setRouteId] = useState<string>('demo-route') // is alias in API die de echte UUID mappt
  const [runId, setRunId] = useState<string>('')
  const [answer, setAnswer] = useState<string>('')
  const [selectedStop, setSelectedStop] = useState<Stop | null>(null)
  const [hintMsg, setHintMsg] = useState<string>('')

  const route = useRoute(routeId)

  async function createTeam(){
    const r = await fetch(`${API}/teams`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name: teamName }) })
    const data = await r.json()
    setJoinCode(data.join_code)
    setTeamId(data.id)
  }

  async function startRun(){
    if(!teamId || !routeId) return
    const r = await fetch(`${API}/runs/start`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ teamId, routeId }) })
    const data = await r.json()
    setRunId(data.id)
  }

  async function submitAnswer(stop: Stop){
    if(!runId) return alert('Start eerst de run.')
    const r = await fetch(`${API}/stops/answer`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ runId, stopId: stop.id, answer }) })
    const data = await r.json()
    if(data.correct){ alert('Goed!'); setAnswer('') } else { alert('Helaas, probeer opnieuw.') }
  }

  async function askHint(stop: Stop){
    if(!runId) return alert('Start eerst de run.')
    const r = await fetch(`${API}/stops/hint`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ runId, stopId: stop.id }) })
    const data = await r.json()
    setHintMsg(data.hint || 'Geen hint beschikbaar.')
  }

  const center = useMemo(()=>{
    if(route?.stops?.length) return [route.stops[0].lat, route.stops[0].lon] as [number, number]
    return [52.2559, 6.1636] as [number, number] // Deventer
  }, [route])

  return (
    <div className="container">
      <h1>Mystery Walk</h1>
      <div className="card">
        <h2>Team & route</h2>
        <div className="row">
          <input className="input" placeholder="Teamnaam" value={teamName} onChange={e=>setTeamName(e.target.value)} />
          <button className="btn" onClick={createTeam}>Maak team</button>
        </div>
        {joinCode && <p>Join-code: <b>{joinCode}</b></p>}
        <div className="row" style={{marginTop:8}}>
          <input className="input" placeholder="Route ID of alias" value={routeId} onChange={e=>setRouteId(e.target.value)} />
          <button className="btn" onClick={startRun} disabled={!teamId}>Start run</button>
        </div>
      </div>

      <div className="card">
        <h2>Kaart</h2>
        <div style={{height:'55vh'}}>
          <MapContainer center={center} zoom={15} style={{height:'100%'}}>
            <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
            {route?.stops?.map(s => (
              <Marker key={s.id} position={[s.lat, s.lon]} eventHandlers={{ click:()=>setSelectedStop(s) }}>
                <Popup>
                  <b>{s.title}</b><br/>
                  Radius: {s.radius_m}m
                </Popup>
              </Marker>
            ))}
          </MapContainer>
        </div>
      </div>

      {selectedStop && (
        <div className="card">
          <h2>Stop: {selectedStop.title}</h2>
          <div className="row">
            <input className="input" placeholder="Antwoord" value={answer} onChange={e=>setAnswer(e.target.value)} />
            <button className="btn" onClick={()=>submitAnswer(selectedStop!)}>Controleer</button>
            <button className="btn" onClick={()=>askHint(selectedStop!)}>Hint</button>
          </div>
          {hintMsg && <p style={{marginTop:8}}><b>Hint:</b> {hintMsg}</p>}
        </div>
      )}
    </div>
  )
}
