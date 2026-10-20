<img src="public/logo.svg" alt="CryptStats-Logo" width="56" align="right">

# CryptStats

Projekte als Krypto-Aktien: Meilensteine treiben den Kurs. Marktübersicht, Detailseiten mit
Kursverlauf und ein Admin-Bereich mit Rollen (Root, Admin, Lesend).

Aktuelle Version: **1.5.0** – Änderungen stehen in [CHANGELOG.md](CHANGELOG.md).

Ein Codebase, zwei Betriebsarten:

| | Docker / privater Server | Cloudflare Workers |
| --- | --- | --- |
| Datenbank | SQLite-Datei im Volume | D1 |
| Statische Dateien | aus `public/` | ASSETS-Binding |
| Fällige Meilensteine | Intervall alle 15 s | Cron jede Minute + bei API-Aufruf |
| Laufzeit | Node 24 (HTTP + SQLite eingebaut) | workerd |

Beide Wege nutzen denselben `fetch`-Handler in [src/app.js](src/app.js). Der SQLite-Adapter
[src/sqlite-d1.js](src/sqlite-d1.js) bildet die D1-API nach, damit `store.js`, `users.js`
und `auth.js` unverändert laufen.

## Docker (privater Server)

```bash
docker compose up -d --build
```

Danach `http://<server>:3000/#/admin` öffnen und das Root-Konto anlegen.
Die SQLite-Datei liegt im Volume `cryptstats-data` (`/data/cryptstats.db`) und übersteht
Updates und Neustarts.

Ohne Compose:

```bash
docker build -t cryptstats:1.5.0 .
docker run -d --name cryptstats --restart unless-stopped \
  -p 3000:3000 -v cryptstats-data:/data cryptstats:1.5.0
```

**HTTPS:** Läuft die Seite hinter Caddy, nginx oder Traefik, `COOKIE_SECURE=true` setzen
(Compose-Datei oder `-e COOKIE_SECURE=true`). Ohne TLS muss der Wert `false` bleiben,
sonst nimmt der Browser das Session-Cookie nicht an.

**Speicherplatz:** Das Image basiert auf `node:24-alpine` (59,6 MiB komprimiert) und enthält
**keine** Laufzeit-Abhängigkeiten – kein `npm install` im Container. Der Anwendungscode
selbst ist unter 100 KiB. Dazu kommt nur die SQLite-Datei im Volume, inklusive WAL-Dateien
typischerweise wenige hundert KiB bis einige MiB.

**Backup:** Container kurz stoppen und `/data` kopieren, oder online:

```bash
docker exec cryptstats node -e "const {DatabaseSync}=require('node:sqlite');new DatabaseSync('/data/cryptstats.db').exec(\"VACUUM INTO '/data/backup.db'\")"
docker cp cryptstats:/data/backup.db ./cryptstats-backup.db
```

**Zurücksetzen:** Volume löschen (`docker compose down -v`); beim nächsten Start werden die
Tabellen aus `migrations/` neu angelegt.

## Versionen & Updates

Die laufende Version steht im Footer jeder Seite (verlinkt auf die Releases), im Header
`X-CryptStats-Version` und unter `GET /api/version`:

```bash
curl -s https://stats.xSyna.de/api/version   # {"version":"1.5.0"}
```

CSS, JavaScript und Logo werden mit `?v=<Version>` eingebunden, `index.html` selbst wird nicht
gecacht. Nach einem Update ändern sich diese URLs, damit Browser und Cloudflare nicht die alte
Datei ausliefern. Erscheint im Footer noch die alte Nummer, läuft auf dem Server noch der alte
Stand:

```bash
git pull && docker compose up -d --build   # Docker
git pull && npx wrangler deploy            # Cloudflare
```

Beim Erhöhen der Version müssen `package.json`, [src/version.js](src/version.js) und die
`?v=`-Angaben in [public/index.html](public/index.html) zusammenpassen; `npm test` prüft das.

## Cloudflare Workers

```bash
npx wrangler login
npx wrangler d1 create cryptstats   # database_id in wrangler.toml eintragen
npm run db:migrate
npm run deploy
```

Im Dashboard unter **Workers & Pages → cryptstats → Settings → Domains & Routes** die
Custom Domain `stats.xSyna.de` hinzufügen. Der bisherige Hello-World-Worker muss gelöscht
werden oder die Domain abgeben, sonst bedient er weiter die Route.

Sofort nach dem Deploy `https://stats.xSyna.de/#/admin` öffnen und das Root-Konto anlegen:
Solange kein Konto existiert, ist die Ersteinrichtung offen und der erste Aufruf gewinnt.

> **CPU-Limit:** Der Workers-Free-Plan erlaubt 10 ms CPU pro Anfrage. PBKDF2 mit 100.000
> Runden braucht mehr, daher funktionieren Login und Ersteinrichtung zuverlässig nur mit
> **Workers Paid** (30 s CPU). Die Docker-Variante hat dieses Limit nicht.

### Warum „Hello World“?

Der Standard-Worker von Cloudflare antwortet auf jede Route mit `Hello world`. Zeigt
`stats.xSyna.de` das an, läuft dort noch die leere Vorlage. Die frühere Node-Fassung
(v1.0.0) konnte auf Workers gar nicht starten: `node:http`, `node:sqlite` und das
Dateisystem gibt es dort nicht.

## Lokal starten

**Docker braucht auf dem Host kein Node.** `docker compose up -d --build` im geklonten
Verzeichnis genügt. Ist das Verzeichnis schon vorhanden, nicht erneut klonen, sondern
aktualisieren:

```bash
cd cryptstats
git pull
```

Nur für die **native** Variante (Entwicklung, Tests) wird **Node 22.13 oder neuer**
gebraucht: `node:sqlite` existiert erst ab Node 22.5. Mit Node 18/20 bricht der Start mit
`No such built-in module: node:sqlite` ab – der Server prüft das beim Start und nennt die
nötige Version. `npm install` installiert nur TypeScript und wrangler, also reine
Entwicklungswerkzeuge:

```bash
git clone https://github.com/xsyna-labs/cryptstats cryptstats
cd cryptstats
npm install
npm start            # http://localhost:3000, DB in data/cryptstats.db
npm run dev:node     # mit Auto-Reload

# Workers-Variante
npm run db:migrate:local
npm run dev          # http://localhost:8787
```

## Konfiguration

| Variable | Standard (Docker) | Standard (Workers) | Bedeutung |
| --- | --- | --- | --- |
| `PORT` | `3000` | – | HTTP-Port |
| `HOST` | `0.0.0.0` | – | Bind-Adresse |
| `DB_PATH` | `data/cryptstats.db` | – | Pfad zur SQLite-Datei |
| `COOKIE_SECURE` | `false` | `true` | Session-Cookie nur über HTTPS |

Passwörter werden mit **PBKDF2-SHA256** (100.000 Runden, 16-Byte-Salt) gehasht. Die
Rundenzahl steht im Hash, spätere Erhöhungen machen alte Passwörter nicht ungültig.

## Rollen

| Rolle | Rechte |
| --- | --- |
| `root` | alles, inklusive Konten anlegen, Rollen ändern, Passwörter zurücksetzen, Konten löschen |
| `admin` | Aktien und Meilensteine verwalten |
| `viewer` | alles lesen, nichts ändern |

Es bleibt immer mindestens ein Root-Konto. Rollenänderungen wirken sofort, weil die Rolle
bei jeder Anfrage aus der Datenbank gelesen wird. Markt und Detailseiten sind ohne
Anmeldung lesbar; nur der Admin-Bereich verlangt ein Konto.

## API

| Methode | Pfad | Zugriff |
| --- | --- | --- |
| `GET` | `/api/version` | öffentlich |
| `GET` | `/api/market` | öffentlich |
| `GET` | `/api/stocks/:slug` | öffentlich |
| `GET` | `/api/auth/status` | öffentlich |
| `POST` | `/api/auth/setup` | nur solange kein Konto existiert |
| `POST` | `/api/auth/login` | öffentlich |
| `POST` | `/api/auth/logout` | angemeldet |
| `POST` | `/api/auth/password` | angemeldet |
| `GET` | `/api/admin/users` | root |
| `POST` | `/api/admin/users` | root |
| `PUT`/`DELETE` | `/api/admin/users/:id` | root |
| `POST` | `/api/admin/stocks` | root/admin |
| `PUT`/`DELETE` | `/api/admin/stocks/:id` | root/admin |
| `POST` | `/api/admin/events` | root/admin |
| `PUT`/`DELETE` | `/api/admin/events/:id` | root/admin |
| `POST` | `/api/admin/events/:id/apply` | root/admin |

Alle schreibenden Anfragen brauchen `Content-Type: application/json`. Ein fremder
`Origin`-Header wird mit `403` abgewiesen.

## Sicherheit

- Session-Cookie: `HttpOnly`, `SameSite=Strict`, `Secure` bei HTTPS, 12 Stunden Laufzeit.
- Login-Sperre nach 5 Fehlversuchen in 15 Minuten. Der Zähler liegt im Prozess bzw.
  Worker-Isolate und ist damit nicht global über mehrere Instanzen.
- Sicherheits-Header (CSP, `X-Frame-Options`, `nosniff`) für API und statische Dateien.
- Fremdschlüssel und `CHECK`-Constraints; Aktienkurse und Startkurse können positiv, null oder negativ sein.
- Kursneuberechnung läuft als Batch und gilt damit gemeinsam.

## Entwicklung

```bash
npm run typecheck   # tsc --noEmit
npm test            # node:test, 45 Tests
```

Die Tests laufen gegen den produktiven SQLite-Adapter (`src/sqlite-d1.js`) und rufen den
`fetch`-Handler direkt auf. Zusätzlich deckt `wrangler dev` die echte Workers-Runtime mit
lokaler D1-Emulation ab.

## Struktur

```
src/worker.js     Workers-Einstieg: fetch + scheduled (Cron)
src/server.js     Node-Einstieg für Docker: HTTP, Assets, Scheduler
src/app.js        Routing, Auth-Routen, Admin-Routen, Assets
src/store.js      Aktien, Meilensteine, Kursberechnung
src/users.js      Konten und Rollen
src/auth.js       PBKDF2, Sessions, Login-Sperre
src/db.js         D1-Helfer
src/sqlite-d1.js  SQLite-Adapter mit D1-API (Docker)
src/assets.js     Datei-Auslieferung für Docker
src/pricing.js    Kurslogik
src/validate.js   Eingabeprüfung
src/version.js    Versionsnummer (Footer, /api/version, Cache-Busting)
migrations/       Schema für D1 und SQLite
public/           Frontend ohne Build-Schritt
tests/            Tests
```
