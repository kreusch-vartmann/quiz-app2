'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const multer = require('multer');
const csv = require('csv-parser');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Readable } = require('stream');

const { initializeDatabase, closeDatabase, dbAll, dbGet, dbRun } = require('./database');

// ── Konfiguration ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const MAX_PLAYERS = 10;
const QUESTION_TIME_SECONDS = 20;

// ── Express & HTTP-Server ────────────────────────────────────────────────────
const app = express();
const httpServer = http.createServer(app);

// ── Socket.io (CORS für Coolify-Reverse-Proxy offen) ────────────────────────
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false, // Auf true setzen, wenn hinter HTTPS-Proxy
    httpOnly: true,
    maxAge: 8 * 60 * 60 * 1000, // 8 Stunden
  },
});
app.use(sessionMiddleware);

// Multer: Datei-Upload in Memory (kein Disk-Schreiben nötig)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // Max. 5 MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Nur CSV-Dateien erlaubt.'));
    }
  },
});

// ── Auth-Middleware ──────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) {
    return next();
  }
  return res.status(401).json({ error: 'Nicht autorisiert. Bitte einloggen.' });
}

// ─────────────────────────────────────────────────────────────────────────────
// REST-API-ROUTEN
// ─────────────────────────────────────────────────────────────────────────────

// ── Health-Check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Admin: Login / Logout ─────────────────────────────────────────────────────
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (!password) {
    return res.status(400).json({ error: 'Passwort fehlt.' });
  }
  if (password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    req.session.save(() => {
      res.json({ success: true });
    });
  } else {
    res.status(401).json({ error: 'Falsches Passwort.' });
  }
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

app.get('/api/admin/check', (req, res) => {
  res.json({ isAdmin: !!(req.session && req.session.isAdmin) });
});

// ── Games (Quiz-Sammlungen) ───────────────────────────────────────────────────
app.get('/api/games', requireAdmin, async (_req, res) => {
  try {
    const games = await dbAll(`
      SELECT g.*, COUNT(q.id) AS question_count
      FROM games g
      LEFT JOIN questions q ON q.game_id = g.id
      GROUP BY g.id
      ORDER BY g.created_at DESC
    `);
    res.json(games);
  } catch (err) {
    console.error('[API] GET /api/games:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/games/:id', requireAdmin, async (req, res) => {
  try {
    const game = await dbGet('SELECT * FROM games WHERE id = ?', [req.params.id]);
    if (!game) return res.status(404).json({ error: 'Quiz nicht gefunden.' });
    const questions = await dbAll(
      'SELECT * FROM questions WHERE game_id = ? ORDER BY order_index, id',
      [req.params.id]
    );
    res.json({ ...game, questions });
  } catch (err) {
    console.error('[API] GET /api/games/:id:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/games', requireAdmin, async (req, res) => {
  const { title, category } = req.body;
  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'Titel ist ein Pflichtfeld.' });
  }
  try {
    const result = await dbRun(
      'INSERT INTO games (title, category) VALUES (?, ?)',
      [title.trim(), (category || 'Allgemein').trim()]
    );
    const game = await dbGet('SELECT * FROM games WHERE id = ?', [result.lastID]);
    res.status(201).json(game);
  } catch (err) {
    console.error('[API] POST /api/games:', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/games/:id', requireAdmin, async (req, res) => {
  const { title, category } = req.body;
  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'Titel ist ein Pflichtfeld.' });
  }
  try {
    const result = await dbRun(
      'UPDATE games SET title = ?, category = ? WHERE id = ?',
      [title.trim(), (category || 'Allgemein').trim(), req.params.id]
    );
    if (result.changes === 0) return res.status(404).json({ error: 'Quiz nicht gefunden.' });
    const game = await dbGet('SELECT * FROM games WHERE id = ?', [req.params.id]);
    res.json(game);
  } catch (err) {
    console.error('[API] PUT /api/games/:id:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/games/:id', requireAdmin, async (req, res) => {
  try {
    const result = await dbRun('DELETE FROM games WHERE id = ?', [req.params.id]);
    if (result.changes === 0) return res.status(404).json({ error: 'Quiz nicht gefunden.' });
    res.json({ success: true });
  } catch (err) {
    console.error('[API] DELETE /api/games/:id:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Questions ─────────────────────────────────────────────────────────────────
app.post('/api/games/:gameId/questions', requireAdmin, async (req, res) => {
  const { gameId } = req.params;
  const { question_text, type, option_a, option_b, option_c, option_d, correct_answer, explanation, order_index } = req.body;

  if (!question_text || !type || !option_a || !option_b || !correct_answer) {
    return res.status(400).json({ error: 'Pflichtfelder: Frage, Typ, Option A, Option B, korrekte Antwort.' });
  }
  if (!['single', 'truefalse'].includes(type)) {
    return res.status(400).json({ error: 'Typ muss "single" oder "truefalse" sein.' });
  }
  if (!['a', 'b', 'c', 'd'].includes(correct_answer)) {
    return res.status(400).json({ error: 'Korrekte Antwort muss a, b, c oder d sein.' });
  }
  const game = await dbGet('SELECT id FROM games WHERE id = ?', [gameId]);
  if (!game) return res.status(404).json({ error: 'Quiz nicht gefunden.' });

  try {
    const result = await dbRun(
      `INSERT INTO questions (game_id, question_text, type, option_a, option_b, option_c, option_d, correct_answer, explanation, order_index)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [gameId, question_text.trim(), type, option_a.trim(), option_b.trim(),
       option_c ? option_c.trim() : null, option_d ? option_d.trim() : null,
       correct_answer, explanation ? explanation.trim() : null, order_index || 0]
    );
    const question = await dbGet('SELECT * FROM questions WHERE id = ?', [result.lastID]);
    res.status(201).json(question);
  } catch (err) {
    console.error('[API] POST questions:', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/questions/:id', requireAdmin, async (req, res) => {
  const { question_text, type, option_a, option_b, option_c, option_d, correct_answer, explanation, order_index } = req.body;
  if (!question_text || !type || !option_a || !option_b || !correct_answer) {
    return res.status(400).json({ error: 'Pflichtfelder fehlen.' });
  }
  try {
    const result = await dbRun(
      `UPDATE questions SET question_text=?, type=?, option_a=?, option_b=?, option_c=?,
       option_d=?, correct_answer=?, explanation=?, order_index=? WHERE id=?`,
      [question_text.trim(), type, option_a.trim(), option_b.trim(),
       option_c ? option_c.trim() : null, option_d ? option_d.trim() : null,
       correct_answer, explanation ? explanation.trim() : null, order_index || 0, req.params.id]
    );
    if (result.changes === 0) return res.status(404).json({ error: 'Frage nicht gefunden.' });
    const question = await dbGet('SELECT * FROM questions WHERE id = ?', [req.params.id]);
    res.json(question);
  } catch (err) {
    console.error('[API] PUT questions/:id:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/questions/:id', requireAdmin, async (req, res) => {
  try {
    const result = await dbRun('DELETE FROM questions WHERE id = ?', [req.params.id]);
    if (result.changes === 0) return res.status(404).json({ error: 'Frage nicht gefunden.' });
    res.json({ success: true });
  } catch (err) {
    console.error('[API] DELETE questions/:id:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── CSV-Download: Vorlage ─────────────────────────────────────────────────────
app.get('/api/csv/template', requireAdmin, (_req, res) => {
  const header = 'frage,typ,option_a,option_b,option_c,option_d,korrekt,erklaerung\n';
  const row1 = '"Was ist die Hauptstadt von Deutschland?",single,"Berlin","München","Hamburg","Frankfurt","a","Berlin ist seit 1990 wieder die Hauptstadt."\n';
  const row2 = '"Die Erde ist flach.",truefalse,"Ja","Nein","","","b","Die Erde ist ein Geoid, also näherungsweise eine Kugel."\n';
  const content = header + row1 + row2;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="quiz-vorlage.csv"');
  res.send('\uFEFF' + content); // BOM für Excel-Kompatibilität
});

// ── CSV-Upload: Import ────────────────────────────────────────────────────────
app.post('/api/games/:gameId/import-csv', requireAdmin, upload.single('csvfile'), async (req, res) => {
  const { gameId } = req.params;
  if (!req.file) {
    return res.status(400).json({ error: 'Keine Datei hochgeladen.' });
  }
  const game = await dbGet('SELECT id FROM games WHERE id = ?', [gameId]);
  if (!game) return res.status(404).json({ error: 'Quiz nicht gefunden.' });

  const rows = [];
  const errors = [];

  try {
    // CSV aus Buffer parsen
    await new Promise((resolve, reject) => {
      const readable = Readable.from(req.file.buffer.toString('utf-8'));
      readable
        .pipe(csv({
          mapHeaders: ({ header }) => header.trim().toLowerCase().replace(/^\uFEFF/, ''),
        }))
        .on('data', (row) => rows.push(row))
        .on('error', reject)
        .on('end', resolve);
    });

    let imported = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const lineNum = i + 2; // Kopfzeile = 1

      const frage = (row.frage || '').trim();
      const typ = (row.typ || '').trim().toLowerCase();
      const option_a = (row.option_a || '').trim();
      const option_b = (row.option_b || '').trim();
      const option_c = (row.option_c || '').trim() || null;
      const option_d = (row.option_d || '').trim() || null;
      const korrekt = (row.korrekt || '').trim().toLowerCase();
      const erklaerung = (row.erklaerung || '').trim() || null;

      // Validierung
      if (!frage) { errors.push(`Zeile ${lineNum}: Frage fehlt.`); continue; }
      if (!['single', 'truefalse'].includes(typ)) { errors.push(`Zeile ${lineNum}: Ungültiger Typ "${typ}".`); continue; }
      if (!option_a || !option_b) { errors.push(`Zeile ${lineNum}: Option A und B sind Pflicht.`); continue; }
      if (!['a', 'b', 'c', 'd'].includes(korrekt)) { errors.push(`Zeile ${lineNum}: Ungültige korrekte Antwort "${korrekt}".`); continue; }

      await dbRun(
        `INSERT INTO questions (game_id, question_text, type, option_a, option_b, option_c, option_d, correct_answer, explanation, order_index)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [gameId, frage, typ, option_a, option_b, option_c, option_d, korrekt, erklaerung, i]
      );
      imported++;
    }

    res.json({
      success: true,
      imported,
      errors: errors.length > 0 ? errors : undefined,
      message: `${imported} Frage(n) erfolgreich importiert.${errors.length > 0 ? ` ${errors.length} Zeile(n) übersprungen.` : ''}`,
    });
  } catch (err) {
    console.error('[API] CSV-Import Fehler:', err);
    res.status(500).json({ error: 'Fehler beim Verarbeiten der CSV-Datei: ' + err.message });
  }
});

// ── Spielhistorie ─────────────────────────────────────────────────────────────
app.get('/api/history', requireAdmin, async (_req, res) => {
  try {
    const history = await dbAll('SELECT * FROM game_history ORDER BY played_at DESC LIMIT 50');
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Liste der verfügbaren Quizzes für Host ────────────────────────────────────
// (öffentlich – der Host wählt nach Login im Frontend)
app.get('/api/public/games', requireAdmin, async (_req, res) => {
  try {
    const games = await dbAll(`
      SELECT g.id, g.title, g.category, COUNT(q.id) AS question_count
      FROM games g
      LEFT JOIN questions q ON q.game_id = g.id
      GROUP BY g.id
      HAVING question_count > 0
      ORDER BY g.title
    `);
    res.json(games);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SOCKET.IO – ECHTZEIT-SPIELLOGIK (State Machine)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Raumzustände (State Machine):
 * LOBBY → QUESTION_ASKED → REVEAL → LEADERBOARD → QUESTION_ASKED → ... → GAME_OVER
 */

/**
 * @typedef {Object} Room
 * @property {string}   code           - 4-stelliger Raumcode
 * @property {string}   hostSocketId   - Socket-ID des Hosts
 * @property {'LOBBY'|'QUESTION_ASKED'|'REVEAL'|'LEADERBOARD'|'GAME_OVER'} state
 * @property {number}   gameId         - ID des gewählten Quizzes
 * @property {string}   gameTitle      - Titel des Quizzes
 * @property {Array}    questions      - Alle Fragen des Quizzes
 * @property {number}   currentQuestionIndex
 * @property {Map}      players        - nickname → { socketId, score, answers[] }
 * @property {Map}      answers        - Antworten für aktuelle Frage: nickname → { answer, timeMs }
 * @property {NodeJS.Timeout|null} timer
 * @property {number}   questionStartTime - Unix-Timestamp ms
 */

/** @type {Map<string, Room>} */
const rooms = new Map();

/** @type {Map<string, string>} Zuordnung socketId → Raumcode */
const socketToRoom = new Map();

/** Generiert einen zufälligen 4-stelligen Raumcode (1000–9999) */
function generateRoomCode() {
  let code;
  do {
    code = String(Math.floor(1000 + Math.random() * 9000));
  } while (rooms.has(code));
  return code;
}

/**
 * Berechnet die Punktzahl basierend auf Korrektheit und Antwortgeschwindigkeit.
 * @param {boolean} correct
 * @param {number}  timeMs - Zeit bis zur Antwort in Millisekunden
 * @returns {number}
 */
function calculateScore(correct, timeMs) {
  if (!correct) return 0;
  const maxTime = QUESTION_TIME_SECONDS * 1000;
  const timeBonus = Math.max(0, Math.round((1 - timeMs / maxTime) * 500));
  return 500 + timeBonus; // Basis: 500 + bis zu 500 Zeitbonus = max. 1000
}

/**
 * Gibt die Rangliste als sortiertes Array zurück.
 * @param {Room} room
 * @returns {Array<{nickname: string, score: number, rank: number}>}
 */
function getLeaderboard(room) {
  return Array.from(room.players.entries())
    .map(([nickname, data]) => ({ nickname, score: data.score }))
    .sort((a, b) => b.score - a.score)
    .map((entry, index) => ({ ...entry, rank: index + 1 }));
}

/**
 * Sendet die aktuelle Spieler:innen-Liste an den Host.
 * @param {Room} room
 */
function emitPlayerList(room) {
  const players = Array.from(room.players.entries()).map(([nickname, data]) => ({
    nickname,
    score: data.score,
    connected: !!io.sockets.sockets.get(data.socketId),
  }));
  io.to(room.code).emit('player_list', { players });
}

/**
 * Startet den Countdown-Timer für eine Frage.
 * @param {Room}   room
 * @param {string} roomCode
 */
function startQuestionTimer(room, roomCode) {
  if (room.timer) clearTimeout(room.timer);
  room.timer = setTimeout(() => {
    if (rooms.get(roomCode)?.state === 'QUESTION_ASKED') {
      revealAnswer(room, roomCode, 'timeout');
    }
  }, QUESTION_TIME_SECONDS * 1000);
}

/**
 * Wechselt in den REVEAL-Zustand: korrekte Antwort aufdecken, Punkte vergeben.
 * @param {Room}   room
 * @param {string} roomCode
 * @param {string} reason - 'timeout' | 'all_answered'
 */
function revealAnswer(room, roomCode, reason) {
  if (room.timer) {
    clearTimeout(room.timer);
    room.timer = null;
  }
  room.state = 'REVEAL';

  const question = room.questions[room.currentQuestionIndex];
  const correctAnswer = question.correct_answer;

  // Punkte für alle Spieler:innen berechnen
  const results = {};
  room.players.forEach((playerData, nickname) => {
    const answerData = room.answers.get(nickname);
    const isCorrect = answerData?.answer === correctAnswer;
    const points = calculateScore(isCorrect, answerData?.timeMs ?? QUESTION_TIME_SECONDS * 1000 + 1);
    playerData.score += points;
    results[nickname] = {
      answer: answerData?.answer ?? null,
      correct: isCorrect,
      points,
      totalScore: playerData.score,
    };
  });

  // An alle im Raum senden
  io.to(roomCode).emit('reveal', {
    correctAnswer,
    explanation: question.explanation || null,
    results,
    reason,
  });

  // Individuelles Feedback an jede:n Spieler:in
  room.players.forEach((playerData, nickname) => {
    const socket = io.sockets.sockets.get(playerData.socketId);
    if (socket) {
      const res = results[nickname];
      socket.emit('player_feedback', {
        correct: res.correct,
        points: res.points,
        totalScore: res.totalScore,
        correctAnswer,
      });
    }
  });
}

/**
 * Sendet die nächste Frage an alle Teilnehmer:innen.
 * @param {Room}   room
 * @param {string} roomCode
 */
function sendNextQuestion(room, roomCode) {
  const question = room.questions[room.currentQuestionIndex];
  room.state = 'QUESTION_ASKED';
  room.answers = new Map();
  room.questionStartTime = Date.now();

  const questionData = {
    index: room.currentQuestionIndex,
    total: room.questions.length,
    question_text: question.question_text,
    type: question.type,
    option_a: question.option_a,
    option_b: question.option_b,
    option_c: question.option_c,
    option_d: question.option_d,
    timeSeconds: QUESTION_TIME_SECONDS,
  };

  io.to(roomCode).emit('question', questionData);
  startQuestionTimer(room, roomCode);
}

// ── Socket.io Event-Handler ───────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[Socket] Verbunden: ${socket.id}`);

  // ── HOST: Raum erstellen ────────────────────────────────────────────────────
  socket.on('host_create_room', async ({ gameId }, callback) => {
    try {
      const game = await dbGet('SELECT * FROM games WHERE id = ?', [gameId]);
      if (!game) return callback({ error: 'Quiz nicht gefunden.' });

      const questions = await dbAll(
        'SELECT * FROM questions WHERE game_id = ? ORDER BY order_index, id',
        [gameId]
      );
      if (questions.length === 0) {
        return callback({ error: 'Dieses Quiz hat keine Fragen.' });
      }

      const code = generateRoomCode();
      /** @type {Room} */
      const room = {
        code,
        hostSocketId: socket.id,
        state: 'LOBBY',
        gameId: game.id,
        gameTitle: game.title,
        questions,
        currentQuestionIndex: 0,
        players: new Map(),
        answers: new Map(),
        timer: null,
        questionStartTime: 0,
      };

      rooms.set(code, room);
      socketToRoom.set(socket.id, code);
      socket.join(code);

      console.log(`[Room] Erstellt: ${code} (Quiz: "${game.title}", ${questions.length} Fragen)`);
      callback({ success: true, code, gameTitle: game.title, questionCount: questions.length });
    } catch (err) {
      console.error('[Socket] host_create_room:', err);
      callback({ error: 'Interner Serverfehler.' });
    }
  });

  // ── SPIELER:IN: Raum beitreten ──────────────────────────────────────────────
  socket.on('player_join', ({ code, nickname }, callback) => {
    const room = rooms.get(code);
    if (!room) return callback({ error: `Raum "${code}" nicht gefunden.` });
    if (room.state !== 'LOBBY') return callback({ error: 'Das Spiel läuft bereits. Beitritt nicht mehr möglich.' });
    if (room.players.size >= MAX_PLAYERS) return callback({ error: `Der Raum ist voll (max. ${MAX_PLAYERS} Teilnehmer:innen).` });

    const cleanNick = (nickname || '').trim();
    if (!cleanNick || cleanNick.length < 1 || cleanNick.length > 20) {
      return callback({ error: 'Nickname muss 1–20 Zeichen lang sein.' });
    }
    if (room.players.has(cleanNick)) {
      return callback({ error: `Nickname "${cleanNick}" ist bereits vergeben.` });
    }

    room.players.set(cleanNick, { socketId: socket.id, score: 0, answers: [] });
    socketToRoom.set(socket.id, code);
    socket.join(code);

    console.log(`[Room] ${cleanNick} trat Raum ${code} bei.`);

    // Host benachrichtigen
    emitPlayerList(room);
    io.to(room.hostSocketId).emit('player_joined', { nickname: cleanNick, playerCount: room.players.size });

    callback({ success: true, nickname: cleanNick, gameTitle: room.gameTitle });
  });

  // ── HOST: Quiz starten ──────────────────────────────────────────────────────
  socket.on('host_start_game', (_, callback) => {
    const code = socketToRoom.get(socket.id);
    const room = rooms.get(code);
    if (!room) return callback?.({ error: 'Raum nicht gefunden.' });
    if (room.hostSocketId !== socket.id) return callback?.({ error: 'Nur der Host kann das Spiel starten.' });
    if (room.state !== 'LOBBY') return callback?.({ error: 'Spiel läuft bereits.' });
    if (room.players.size === 0) return callback?.({ error: 'Mindestens eine Spieler:in muss beigetreten sein.' });

    console.log(`[Room] Spiel ${code} startet.`);
    room.currentQuestionIndex = 0;
    sendNextQuestion(room, code);
    callback?.({ success: true });
  });

  // ── HOST: Nächste Frage / Leaderboard weiter ───────────────────────────────
  socket.on('host_next', (_, callback) => {
    const code = socketToRoom.get(socket.id);
    const room = rooms.get(code);
    if (!room) return callback?.({ error: 'Raum nicht gefunden.' });
    if (room.hostSocketId !== socket.id) return callback?.({ error: 'Nur der Host.' });

    if (room.state === 'REVEAL') {
      // → Leaderboard anzeigen
      room.state = 'LEADERBOARD';
      const leaderboard = getLeaderboard(room);
      io.to(code).emit('leaderboard', { leaderboard, isFinal: false });
      callback?.({ success: true });

    } else if (room.state === 'LEADERBOARD') {
      // → Nächste Frage oder Game Over
      room.currentQuestionIndex++;
      if (room.currentQuestionIndex >= room.questions.length) {
        // ── GAME OVER ──────────────────────────────────────────────────────
        room.state = 'GAME_OVER';
        const finalLeaderboard = getLeaderboard(room);
        io.to(code).emit('game_over', { leaderboard: finalLeaderboard });

        // Ergebnis in Datenbank speichern
        const winner = finalLeaderboard[0] ?? null;
        dbRun(
          `INSERT INTO game_history (game_id, game_title, player_count, winner_nickname, winner_score, results_json)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            room.gameId,
            room.gameTitle,
            room.players.size,
            winner?.nickname ?? null,
            winner?.score ?? 0,
            JSON.stringify(finalLeaderboard),
          ]
        ).catch((err) => console.error('[DB] Fehler beim Speichern der Historie:', err));

        callback?.({ success: true, state: 'GAME_OVER' });
      } else {
        sendNextQuestion(room, code);
        callback?.({ success: true, state: 'QUESTION_ASKED' });
      }
    } else {
      callback?.({ error: `Aktion im Zustand "${room.state}" nicht erlaubt.` });
    }
  });

  // ── SPIELER:IN: Antwort abgeben ─────────────────────────────────────────────
  socket.on('player_answer', ({ answer }, callback) => {
    const code = socketToRoom.get(socket.id);
    const room = rooms.get(code);
    if (!room) return callback?.({ error: 'Raum nicht gefunden.' });
    if (room.state !== 'QUESTION_ASKED') return callback?.({ error: 'Annahme von Antworten gerade nicht möglich.' });
    if (!['a', 'b', 'c', 'd'].includes(answer)) return callback?.({ error: 'Ungültige Antwort.' });

    // Spieler:in anhand socketId finden
    let playerNickname = null;
    room.players.forEach((data, nick) => {
      if (data.socketId === socket.id) playerNickname = nick;
    });
    if (!playerNickname) return callback?.({ error: 'Nicht als Spieler:in registriert.' });
    if (room.answers.has(playerNickname)) return callback?.({ error: 'Bereits geantwortet.' });

    const timeMs = Date.now() - room.questionStartTime;
    room.answers.set(playerNickname, { answer, timeMs });

    console.log(`[Room] ${playerNickname} antwortete "${answer}" nach ${timeMs}ms`);
    callback?.({ success: true, received: true });

    // Host informieren, wie viele geantwortet haben
    io.to(room.hostSocketId).emit('answer_count', {
      answered: room.answers.size,
      total: room.players.size,
    });

    // Automatisch aufdecken, wenn alle geantwortet haben
    if (room.answers.size >= room.players.size) {
      revealAnswer(room, code, 'all_answered');
    }
  });

  // ── HOST: Frage manuell aufdecken (vorzeitig) ──────────────────────────────
  socket.on('host_reveal_now', (_, callback) => {
    const code = socketToRoom.get(socket.id);
    const room = rooms.get(code);
    if (!room) return callback?.({ error: 'Raum nicht gefunden.' });
    if (room.hostSocketId !== socket.id) return callback?.({ error: 'Nur der Host.' });
    if (room.state !== 'QUESTION_ASKED') return callback?.({ error: 'Keine laufende Frage.' });
    revealAnswer(room, code, 'host_forced');
    callback?.({ success: true });
  });

  // ── HOST: Spiel abbrechen ───────────────────────────────────────────────────
  socket.on('host_end_game', (_, callback) => {
    const code = socketToRoom.get(socket.id);
    const room = rooms.get(code);
    if (!room) return callback?.({ error: 'Raum nicht gefunden.' });
    if (room.hostSocketId !== socket.id) return callback?.({ error: 'Nur der Host.' });

    if (room.timer) clearTimeout(room.timer);
    io.to(code).emit('game_aborted', { message: 'Das Spiel wurde vom Host beendet.' });
    cleanupRoom(code);
    callback?.({ success: true });
  });

  // ── Verbindungstrennung ────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`[Socket] Getrennt: ${socket.id}`);
    const code = socketToRoom.get(socket.id);
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    socketToRoom.delete(socket.id);

    if (room.hostSocketId === socket.id) {
      // Host trennt → Spiel abbrechen
      console.log(`[Room] Host von ${code} getrennt. Raum wird aufgelöst.`);
      if (room.timer) clearTimeout(room.timer);
      io.to(code).emit('game_aborted', { message: 'Die Verbindung zum Host wurde getrennt. Das Spiel wurde beendet.' });
      cleanupRoom(code);
    } else {
      // Spieler:in trennt → Aus Liste entfernen, weiterspielen
      let disconnectedNick = null;
      room.players.forEach((data, nick) => {
        if (data.socketId === socket.id) disconnectedNick = nick;
      });
      if (disconnectedNick) {
        room.players.delete(disconnectedNick);
        console.log(`[Room] ${disconnectedNick} hat Raum ${code} verlassen.`);
        emitPlayerList(room);
        io.to(room.hostSocketId).emit('player_left', { nickname: disconnectedNick });

        // Prüfen, ob alle übrigen Spieler:innen nun geantwortet haben
        if (room.state === 'QUESTION_ASKED' && room.answers.size >= room.players.size && room.players.size > 0) {
          revealAnswer(room, code, 'all_answered');
        }
      }
    }
  });
});

/**
 * Räumt einen Raum auf: Timer löschen, Map-Einträge entfernen.
 * @param {string} code
 */
function cleanupRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  if (room.timer) clearTimeout(room.timer);
  room.players.forEach((data) => socketToRoom.delete(data.socketId));
  socketToRoom.delete(room.hostSocketId);
  rooms.delete(code);
  console.log(`[Room] Raum ${code} aufgelöst.`);
}

// ─────────────────────────────────────────────────────────────────────────────
// SERVER START
// ─────────────────────────────────────────────────────────────────────────────

async function startServer() {
  try {
    await initializeDatabase();

    httpServer.listen(PORT, () => {
      console.log(`[Server] Quiz-App läuft auf Port ${PORT}`);
      console.log(`[Server] Admin-Passwort: ${ADMIN_PASSWORD === 'admin123' ? '⚠️  Standard-Passwort! Bitte ändern!' : '✓ Konfiguriert'}`);
    });
  } catch (err) {
    console.error('[Server] Startfehler:', err);
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GRACEFUL SHUTDOWN
// ─────────────────────────────────────────────────────────────────────────────

async function gracefulShutdown(signal) {
  console.log(`\n[Server] ${signal} empfangen. Fahre herunter...`);

  // Alle Räume benachrichtigen
  rooms.forEach((room, code) => {
    if (room.timer) clearTimeout(room.timer);
    io.to(code).emit('game_aborted', { message: 'Server wird neu gestartet. Bitte erneut verbinden.' });
  });

  // HTTP-Server schließen (keine neuen Verbindungen)
  httpServer.close(async () => {
    console.log('[Server] HTTP-Server geschlossen.');
    try {
      await closeDatabase();
      console.log('[Server] Datenbank geschlossen. Auf Wiedersehen!');
      process.exit(0);
    } catch (err) {
      console.error('[Server] Fehler beim Schließen der DB:', err);
      process.exit(1);
    }
  });

  // Fallback: Erzwinge Exit nach 10s
  setTimeout(() => {
    console.error('[Server] Erzwungener Exit nach Timeout.');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Uncaught Exceptions loggen (nicht abstürzen lassen)
process.on('uncaughtException', (err) => {
  console.error('[Server] Unbehandelter Fehler:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Server] Unbehandelte Promise-Ablehnung:', reason);
});

startServer();
