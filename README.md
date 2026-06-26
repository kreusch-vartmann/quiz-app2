# Quiz-App – Echtzeit-Quiz-Plattform (Kahoot-Style)

Ein vollständig selbst gehosteter, Echtzeit-Quiz-Monolith – entwickelt mit Node.js, Socket.io und SQLite. Kein externer Datenbankserver notwendig.

---

## Architektur: Self-Contained Monolith

```
┌─────────────────────────────────────────────────────┐
│                  Docker Container                    │
│                                                     │
│  ┌──────────────┐    ┌──────────────────────────┐  │
│  │  Express.js  │    │       Socket.io           │  │
│  │  (REST API)  │◄──►│  (Echtzeit WebSockets)   │  │
│  └──────┬───────┘    └──────────────────────────┘  │
│         │                                           │
│  ┌──────▼───────────────────────────────────────┐  │
│  │          SQLite (WAL-Modus)                  │  │
│  │          /app/data/quiz.db                   │  │
│  └──────────────────────────────────────────────┘  │
│                                                     │
│  ┌───────────────────────────────────────────────┐  │
│  │  public/index.html (Vanilla JS + Tailwind)   │  │
│  │  Dynamisch: Admin | Host | Spieler:in        │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
         │
    Volume Mount
         │
┌────────▼────────────┐
│  /app/data/quiz.db  │  ← Persistente SQLite-Daten
└─────────────────────┘
```

Alle Komponenten laufen in **einem einzigen Docker-Container**. Es wird kein externer Datenbankserver, kein Redis und kein separater Message-Broker benötigt.

---

## Umgebungsvariablen

| Variable         | Beschreibung                                    | Standard              |
|------------------|-------------------------------------------------|-----------------------|
| `PORT`           | Server-Port (wird von Coolify automatisch gesetzt) | `3000`             |
| `ADMIN_PASSWORD` | Passwort für den Admin-Bereich                  | `admin123` (unsicher!) |
| `SESSION_SECRET` | Geheimnis für die Session-Verschlüsselung       | Zufälliger Fallback   |

> ⚠️ **Wichtig:** Ändere `ADMIN_PASSWORD` und `SESSION_SECRET` vor dem produktiven Einsatz!

---

## Schnellstart (Lokal)

```bash
# 1. Abhängigkeiten installieren
npm install

# 2. Umgebungsvariablen kopieren und anpassen
cp .env.example .env
# nano .env  ← Passwort setzen

# 3. Server starten
npm start
# → http://localhost:3000
```

---

## Docker-Deployment via Coolify

### 1. Volume für persistente Daten konfigurieren

In Coolify muss ein **Volume-Mount** eingerichtet werden, damit die SQLite-Datenbank bei Container-Neustarts erhalten bleibt:

| Einstellung      | Wert             |
|------------------|------------------|
| Container-Pfad   | `/app/data`      |
| Host-Pfad        | *(Coolify wählt automatisch)* |

**Coolify UI:**  
`Service → Volumes → Add Volume`  
- Volume Name: `quiz-data`  
- Mount Path: `/app/data`

### 2. Umgebungsvariablen in Coolify setzen

`Service → Environment Variables → Add Variable`

```
ADMIN_PASSWORD=DeinSicheresPasswort
SESSION_SECRET=EinLangesZufälligesGeheimnis
PORT=3000
```

### 3. Manueller Docker-Start (ohne Coolify)

```bash
# Image bauen
docker build -t quiz-app .

# Container starten mit persistentem Volume
docker run -d \
  --name quiz-app \
  -p 3000:3000 \
  -v quiz-data:/app/data \
  -e ADMIN_PASSWORD=DeinPasswort \
  -e SESSION_SECRET=DeinGeheimnis \
  quiz-app
```

---

## Funktionen

### Admin-Bereich (`/`)
- Login mit `ADMIN_PASSWORD`
- Quiz-Kategorien und Fragen verwalten (CRUD)
- Fragetypen: Single-Choice (4 Optionen) und Wahr/Falsch
- Optionales Erklärungsfeld pro Frage
- CSV-Import und CSV-Vorlagen-Download
- Spielhistorie einsehen

### Live-Quiz (Host)
- Zufälligen 4-stelligen Raumcode generieren
- Spieler:innen-Beitritt verfolgen (max. 10)
- Fragen steuern, Timer überwachen
- Rangliste nach jeder Frage anzeigen

### Spieler:innen-Ansicht (Mobil-optimiert)
- Raum per Code beitreten
- Nickname wählen
- Antwort-Buttons (Kahoot-Style: Rot, Blau, Gelb, Grün)
- Sofortiges Feedback nach Antwort

---

## CSV-Import-Format

```csv
frage,typ,option_a,option_b,option_c,option_d,korrekt,erklaerung
"Was ist die Hauptstadt von Deutschland?",single,"Berlin","München","Hamburg","Frankfurt","a","Berlin ist seit 1990 wieder die Hauptstadt."
"Die Erde ist flach.",truefalse,"Ja","Nein","","","b","Die Erde ist eine Kugel (genauer: ein Geoid)."
```

**Feldwerte für `typ`:** `single` oder `truefalse`  
**Feldwerte für `korrekt`:** `a`, `b`, `c`, `d` (Single-Choice) oder `a`/`b` (Wahr/Falsch)

---

## Datenbank-Schema

```sql
-- Quiz-Spiele (Gruppen von Fragen)
CREATE TABLE games (id, title, category, created_at);

-- Fragen
CREATE TABLE questions (id, game_id, question_text, type, 
                        option_a, option_b, option_c, option_d, 
                        correct_answer, explanation, order_index);

-- Spielhistorie
CREATE TABLE game_history (id, game_id, played_at, player_count, 
                           winner_nickname, winner_score, results_json);
```

---

## Technologie-Stack

| Schicht        | Technologie                        |
|----------------|------------------------------------|
| Backend        | Node.js 18+ / Express 4            |
| WebSockets     | Socket.io 4                        |
| Datenbank      | SQLite3 (WAL-Modus)                |
| Frontend       | HTML5 / Vanilla JS / Tailwind CSS  |
| Container      | Docker (node:18-alpine)            |
| Deployment     | Coolify (Self-Hosted PaaS)         |
