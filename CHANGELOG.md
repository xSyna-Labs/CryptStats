# Changelog

Alle nennenswerten Änderungen an CryptStats. Die Version steht im Footer der Seite, unter
`GET /api/version` und im HTTP-Header `X-CryptStats-Version`.

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
