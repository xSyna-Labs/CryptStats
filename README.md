# CryptStats

CryptStats macht den Fortschritt von Projekten als Krypto-Aktie sichtbar. Jedes Projekt bekommt einen Namen und ein Kürzel (z. B. `MPJ`). Ein Administrator trägt Meilensteine mit einem positiven oder negativen Wert ein: Ein Erfolg lässt den Kurs steigen, ein Rückschlag mit `−` fällt. Ereignisse lassen sich auch für die Zukunft planen und werden dann automatisch angewendet.

Je Aktie zeigt die Seite:

- aktuellen Kurs mit Veränderung in den letzten 24 Stunden (absolut und in Prozent)
- einen interaktiven Kursverlauf mit den Zeiträumen 1T, 1W, 1M, 1J und MAX; Meilensteine sind im Chart markiert
- Kennzahlen: Performance seit IPO, Allzeithoch und -tief, Startkurs, Anzahl der Meilensteine
- Meilensteine (angewendet) und geplante Ereignisse
- Unterprojekte, die als eigene Aktien mit Verweis zum Elternprojekt angelegt werden
- einen Kursticker oben sowie eine Marktübersicht mit Sortierung, Suche und Minicharts der letzten 7 Tage

Die Startseite ist öffentlich. Für das Bearbeiten ist ein Konto nötig.

## Voraussetzungen

- **Node.js 22.13 oder neuer** (verwendet das eingebaute `node:sqlite`; es müssen keine nativen Pakete kompiliert werden)

## Installation

```bash
git clone <repository-url> cryptstats
cd cryptstats
npm install     # nur Entwicklungswerkzeuge (TypeScript); zur Laufzeit gibt es keine Abhängigkeiten
npm start
```

Dann im Browser <http://localhost:3000/#/admin> öffnen. Beim ersten Aufruf erscheint die **Ersteinrichtung**: Benutzername und Passwort (mindestens 12 Zeichen) für das Root-Konto festlegen. Danach ist die Einrichtung abgeschlossen, und die Anmeldung erfolgt mit diesem Konto.

Optional: `.env.example` nach `.env` kopieren, um Port, Adresse oder Datenbankpfad anzupassen. Für die Entwicklung mit automatischem Neustart: `npm run dev`.

## Konten und Rollen

Konten verwaltet das Root-Konto unter **Admin → Benutzer**, wie bei Uptime Kuma.

| Rolle | Darf |
| --- | --- |
| **Root** | alles, inklusive Konten anlegen, Rollen ändern, Passwörter zurücksetzen und Konten löschen |
| **Admin** | Aktien anlegen, bearbeiten und löschen; Ereignisse eintragen, ändern, löschen und sofort anwenden |
| **Lesend** | den Admin-Bereich einsehen, aber nichts ändern |

Regeln:

- Es gibt immer mindestens ein Root-Konto. Das letzte Root-Konto lässt sich weder löschen noch herabstufen.
- Ein Konto kann sich nicht selbst löschen.
- Rollenänderungen wirken sofort, auch für bereits angemeldete Nutzer.
- Ein zurückgesetztes Passwort beendet alle Sitzungen des Kontos. Jeder Nutzer kann sein eigenes Passwort über **Mein Passwort ändern** wechseln.
- Benutzernamen sind nicht case-sensitiv (`Anna` und `anna` sind dasselbe Konto).

## Aktien, Meilensteine und Zeitplan

1. **Aktien**: Name, Kürzel (2–8 Buchstaben oder Ziffern), Startkurs (Standard 100), Notierungsdatum, optionales übergeordnetes Projekt, Link und Beschreibung. Startkurs und Notierungsdatum sind nach dem Anlegen festgelegt.
2. **Meilensteine und Ereignisse**: Titel, Wert (positiv = steigt, negativ = fällt), Zeitpunkt und Beschreibung.
   - Zeitpunkt jetzt oder in der Vergangenheit: das Ereignis wird sofort angewendet. Rückdatierungen sind erlaubt, aber nicht vor dem Notierungsdatum.
   - Zeitpunkt in der Zukunft: das Ereignis wird geplant und zum angegebenen Zeitpunkt automatisch angewendet. Der Server prüft dies alle 15 Sekunden und bei jedem Seitenaufruf.
3. **Ereignisse verwalten**: bearbeiten, löschen oder geplante Ereignisse mit „Jetzt anwenden“ sofort anwenden (der Zeitpunkt wird auf „jetzt“ gesetzt).

Nach jeder Änderung werden die Kurse aus Startkurs und allen angewendeten Ereignissen in zeitlicher Reihenfolge neu berechnet. Der Kurs fällt nie unter `0,01`.

Weitere Regeln:

- Ein Projekt mit Unterprojekten lässt sich erst löschen, wenn die Unterprojekte entfernt oder umgehängt wurden.
- Ein Projekt kann nicht unter sich selbst oder einem seiner Unterprojekte hängen.
- Das Kürzel ist eindeutig.

## Konfiguration

Alle Einstellungen sind Umgebungsvariablen (oder stehen in `.env`):

| Variable | Standard | Beschreibung |
| --- | --- | --- |
| `PORT` | `3000` | Port des HTTP-Servers |
| `HOST` | `0.0.0.0` | Adresse, auf die der Server lauscht |
| `DB_PATH` | `data/cryptstats.db` | Speicherort der SQLite-Datenbank |
| `COOKIE_SECURE` | `false` | Auf `true` setzen, sobald die Seite über HTTPS läuft (Session-Cookie nur über HTTPS) |

Die Einheit „Coins“ ist die Konstante `UNIT` in `public/app.js`.

Sicherheit: Sessions laufen nach 12 Stunden ab. Nach 5 Fehlversuchen innerhalb von 15 Minuten wird der Login pro IP-Adresse gesperrt.

## API

Öffentlich (JSON):

| Methode | Pfad | Beschreibung |
| --- | --- | --- |
| `GET` | `/api/market` | Alle Aktien mit Kurs, 24-h-Veränderung und Verlauf |
| `GET` | `/api/stocks/:slug` | Detail einer Aktie mit Verlauf, Ereignissen, geplanten Ereignissen, Eltern- und Unterprojekten |
| `GET` | `/api/auth/status` | `setupRequired` und das angemeldete Konto (oder `null`) |
| `POST` | `/api/auth/setup` | Ersteinrichtung, legt das Root-Konto an (nur solange noch kein Konto existiert) |
| `POST` | `/api/auth/login` | Anmeldung mit `{ "username", "password" }` |
| `POST` | `/api/auth/logout` | Sitzung beenden |
| `POST` | `/api/auth/password` | Eigenes Passwort ändern: `{ "currentPassword", "newPassword" }` |

Mit Sitzung (Cookie aus dem Login). Lesende Konten dürfen nur die Leseroute `GET` nutzen, alle Schreibrouten sind Admin und Root vorbehalten:

| Methode | Pfad | Rolle |
| --- | --- | --- |
| `POST` | `/api/admin/stocks` | Admin, Root |
| `PUT` / `DELETE` | `/api/admin/stocks/:id` | Admin, Root |
| `POST` | `/api/admin/events` | Admin, Root |
| `PUT` / `DELETE` | `/api/admin/events/:id` | Admin, Root |
| `POST` | `/api/admin/events/:id/apply` | Admin, Root |
| `GET` / `POST` | `/api/admin/users` | nur Root |
| `PUT` / `DELETE` | `/api/admin/users/:id` | nur Root |

Schreibzugriffe erwarten `Content-Type: application/json`. Ein Beispiel für einen Meilenstein per API:

```bash
curl -c cookies.txt -H 'Content-Type: application/json' \
  -d '{"username":"root","password":"<passwort>"}' http://localhost:3000/api/auth/login
curl -b cookies.txt -H 'Content-Type: application/json' \
  -d '{"stockId": 1, "title": "Version 1.0 veröffentlicht", "delta": 25}' \
  http://localhost:3000/api/admin/events
```

## Deployment

### Docker

```bash
docker build -t cryptstats .
docker run -d --name cryptstats -p 3000:3000 -v cryptstats-data:/data cryptstats
```

Oder mit Docker Compose:

```bash
docker compose up -d
```

Danach wie oben im Browser die Ersteinrichtung abschließen. Die Datenbank liegt im Volume `/data` und bleibt bei Updates erhalten.

### Hinter einem Reverse-Proxy

- Den Proxy per HTTPS betreiben und `COOKIE_SECURE=true` setzen.
- Der Login-Schutz verwendet die Verbindungs-IP des Servers. Hinter einem Proxy teilen sich alle Clients dieselbe Sperre. Dafür muss der Proxy die echte Client-IP weitergeben oder die Sperre in `src/auth.js` angepasst werden.

### Backup

Die Datenbank ist eine einzelne SQLite-Datei (`DB_PATH`, WAL-Modus). Sicherung zur Laufzeit etwa mit `sqlite3 data/cryptstats.db ".backup backup.db"`; bei gestopptem Server genügt das Kopieren der Datei.

## Entwicklung

```bash
npm test          # Tests (node:test)
npm run typecheck # TypeScript-Prüfung der JavaScript-Quellen (checkJs)
```

```
src/
  server.js    Einstiegspunkt, Scheduler für fällige Ereignisse
  app.js       HTTP-Routen, Anmeldung, Rollen, Same-Origin-Prüfung, statische Auslieferung
  store.js     Datenbankzugriff für Aktien und Ereignisse, Kursberechnung, Ansichten
  users.js     Konten, Ersteinrichtung, Rollen, Passwörter
  auth.js      scrypt-Passwort-Hashing, Sessions, Cookies, Login-Limit
  pricing.js   Reine Funktionen: Kursverlauf, Veränderung, Statistik
  validate.js  Eingabeprüfung
  db.js        SQLite-Verbindung und Schema
  config.js    Umgebungsvariablen
public/        Frontend (HTML, CSS, JavaScript ohne Build-Schritt)
tests/         Tests
```

## Lizenz

MIT, siehe [LICENSE.md](LICENSE.md).
