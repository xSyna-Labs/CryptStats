# Changelog

Alle nennenswerten Änderungen an CryptStats. Die Version steht im Footer der Seite, unter
`GET /api/version` und im HTTP-Header `X-CryptStats-Version`.

## 1.4.0 – 2026-10-20

### Neu

- **RoadMap**-Abschnitt (`#/roadmap`) mit Status Erledigt, In Arbeit und Geplant; die Einträge stehen in `ROADMAP` in `public/app.js`.
- **PWA**: Web-App-Manifest mit App-Icons (192 px, 512 px, SVG), installierbar auf dem Startbildschirm; Service Worker (`/sw.js`) startet die Oberfläche auch offline. API-Antworten werden nie zwischengespeichert.

### Geändert

- Mobil: Eingabefelder mit 16 px Schrift (kein automatisches Zoomen in iOS), größere Touch-Ziele, Abstand zur Gerätekante (Safe-Area).
- Admin: Schnellaktion **+ Ereignis** pro Aktie stellt das Ereignisformular und die Ereignisliste direkt auf diese Aktie.
- Aktien-Detailseite: Kursverlauf als Candlestick-Chart (Eröffnung, Hoch, Tief, Schluss je Zeitintervall); der Tooltip zeigt die Werte der Kerze.
- Darstellung: Tooltip im Theme-Farbton, ungenutzte Linien-Styles entfernt.

## 1.3.0 – 2026-10-20

### Geändert

- Aktien-Startkurse und berechnete Kurse dürfen negativ oder null sein.
- Negative Kurse werden in Markt- und Detailansichten rot markiert; Diagramme skalieren unter null.

## 1.2.0 – 2026-10-19

### Hinzugefügt

- Versionierung: sichtbare Version im Footer (verlinkt auf die Releases), `GET /api/version`
  und `X-CryptStats-Version` in jeder Antwort.
- Cache-Busting: CSS, JS, Logo und Touch-Icon werden mit `?v=<Version>` geladen; HTML selbst
  wird nicht gecacht.
- Dieses Changelog.

### Geändert

- Die Einheit heißt überall **Punkte** statt „Coins“ (Chart-Tooltip, Kurs, Kindprojekte,
  Ereignisliste).
- Docker-Image und Compose-Datei auf `1.2.0` gezogen.

## 1.1.0 – 2026-10-19

### Hinzugefügt

- Docker- und Compose-Betrieb neben Cloudflare Workers, inklusive SQLite-Volume.
- Startprüfung auf Node 22.13+ mit klarer Meldung statt `node:sqlite`-Fehler.
- Mobiles Kartenlayout, Logo samt Favicon und Touch-Icon, Kurschart mit diagonalen Segmenten
  und Endkurs-Marker, Standard-Sortierung nach Kurs.

### Behoben

- `package.json` fehlte im Container-Image, dadurch war das ESM-Verhalten nicht gesichert.

## 1.0.0 – 2026-10-18

- Erste Fassung: Markt, Detailseiten mit Kursverlauf, Meilensteine, Rollen (Root, Admin,
  Lesend), D1 und SQLite.
