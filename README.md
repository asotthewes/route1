# Mystery Stadswandeling/Kroegentocht — Starter

Een kant-en-klare starter met:
- **Frontend**: React + Vite + Leaflet (PWA)
- **API**: Fastify (Node.js) + Postgres + Redis
- **Docker Compose**: alles in één stack te draaien
- **Seed data**: voorbeeldroute in Deventer (6 stops)

## Snel starten (lokaal / Portainer)

1. Maak een `.env` op root-niveau met:
   ```env
   POSTGRES_PASSWORD=eensterkwachtwoord
   ```

2. Start de stack:
   ```bash
   docker compose up -d --build
   ```

3. Open de app: http://localhost:8080  
   (In jouw omgeving zet je er een reverse proxy voor met eigen domein/HTTPS.)

### Portainer
- *Stacks* → *Add Stack* → upload deze repo of plak `docker-compose.yml` en voeg een **Env var** `POSTGRES_PASSWORD`.
- Deployen.

## Seed
- De Postgres container draait automatisch `api/sql/migrate.sql` en `api/sql/seed.sql` bij eerste start.
- Seed bevat 1 route met 6 stops in Deventer. Antwoorden staan als `plain:<antwoord>` (simpel voor MVP).

## Frontend
- PWA met offline caching (vite-plugin-pwa).
- Kaart met stops, join-code voor team, simpele flow voor scannen (QR-URL invullen) en antwoorden.

## API
- Endpoints onder `/api/*`. Zie `api/src/server.js`.
- Anti-cheat MVP: eenvoudige rate-limit per run/stop, normalisatie van antwoorden, geofence-check aanwezig als opt-in (in seed staat radius 40m).

## Productie notities
- Zet een reverse proxy met TLS (bijv. Nginx/Traefik/Caddy). In deze starter proxiet de **web-nginx** al `/api` door naar de **api** service.
- Vervang `SESSION_SECRET` in `docker-compose.yml` door iets sterks.
- In productie vervang je `plain:` seeded antwoorden door gehashte varianten (scrypt/argon2).

Veel plezier!
