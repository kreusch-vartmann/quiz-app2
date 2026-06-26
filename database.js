'use strict';

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

// Sicherstellen, dass das Datenverzeichnis existiert
const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const DB_PATH = path.join(dataDir, 'quiz.db');

let db;

/**
 * Öffnet die SQLite-Verbindung, aktiviert WAL-Modus und erstellt alle Tabellen.
 * @returns {Promise<sqlite3.Database>}
 */
function initializeDatabase() {
  return new Promise((resolve, reject) => {
    db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) {
        console.error('[DB] Fehler beim Öffnen der Datenbank:', err.message);
        return reject(err);
      }
      console.log(`[DB] Verbunden mit SQLite: ${DB_PATH}`);
    });

    // Serialisierte Ausführung: WAL-Modus zuerst, dann Tabellen erstellen
    db.serialize(() => {
      // WAL-Modus aktivieren: bessere Concurrent-Read-Performance
      db.run('PRAGMA journal_mode=WAL;', (err) => {
        if (err) {
          console.error('[DB] Fehler beim Aktivieren des WAL-Modus:', err.message);
        } else {
          console.log('[DB] WAL-Modus aktiviert.');
        }
      });

      // Foreign Keys aktivieren
      db.run('PRAGMA foreign_keys = ON;');

      // ── Tabelle: games ──────────────────────────────────────────────────────
      // Repräsentiert ein Quiz (Sammlung von Fragen)
      db.run(`
        CREATE TABLE IF NOT EXISTS games (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          title       TEXT    NOT NULL,
          category    TEXT    NOT NULL DEFAULT 'Allgemein',
          created_at  DATETIME DEFAULT (datetime('now', 'localtime'))
        )
      `);

      // ── Tabelle: questions ──────────────────────────────────────────────────
      // Fragen, die einem Spiel zugeordnet sind
      db.run(`
        CREATE TABLE IF NOT EXISTS questions (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          game_id        INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
          question_text  TEXT    NOT NULL,
          type           TEXT    NOT NULL CHECK(type IN ('single', 'truefalse')),
          option_a       TEXT    NOT NULL,
          option_b       TEXT    NOT NULL,
          option_c       TEXT,
          option_d       TEXT,
          correct_answer TEXT    NOT NULL CHECK(correct_answer IN ('a','b','c','d')),
          explanation    TEXT,
          order_index    INTEGER DEFAULT 0
        )
      `);

      // ── Tabelle: game_history ───────────────────────────────────────────────
      // Gespeicherte Ergebnisse vergangener Live-Runden
      db.run(`
        CREATE TABLE IF NOT EXISTS game_history (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          game_id          INTEGER REFERENCES games(id) ON DELETE SET NULL,
          game_title       TEXT,
          played_at        DATETIME DEFAULT (datetime('now', 'localtime')),
          player_count     INTEGER  DEFAULT 0,
          winner_nickname  TEXT,
          winner_score     INTEGER  DEFAULT 0,
          results_json     TEXT
        )
      `);

      // ── Tabelle: sessions ───────────────────────────────────────────────────
      // express-session Speicher-Tabelle (connect-sqlite3 Alternative als raw SQL)
      db.run(`
        CREATE TABLE IF NOT EXISTS sessions (
          sid    TEXT    PRIMARY KEY,
          sess   TEXT    NOT NULL,
          expire DATETIME NOT NULL
        )
      `, (err) => {
        if (err) {
          console.error('[DB] Fehler beim Erstellen der Tabellen:', err.message);
          return reject(err);
        }
        console.log('[DB] Alle Tabellen initialisiert.');
        resolve(db);
      });
    });
  });
}

/**
 * Gibt die aktive DB-Instanz zurück.
 * Wirft einen Fehler, wenn initializeDatabase() noch nicht aufgerufen wurde.
 * @returns {sqlite3.Database}
 */
function getDb() {
  if (!db) {
    throw new Error('[DB] Datenbank nicht initialisiert. Bitte zuerst initializeDatabase() aufrufen.');
  }
  return db;
}

/**
 * Schließt die Datenbankverbindung sauber (für Graceful Shutdown).
 * @returns {Promise<void>}
 */
function closeDatabase() {
  return new Promise((resolve, reject) => {
    if (!db) return resolve();
    db.close((err) => {
      if (err) {
        console.error('[DB] Fehler beim Schließen der Datenbank:', err.message);
        return reject(err);
      }
      console.log('[DB] Datenbankverbindung sauber geschlossen.');
      db = null;
      resolve();
    });
  });
}

// ── Hilfs-Wrapper für Promise-basierte DB-Aufrufe ───────────────────────────

/**
 * Führt ein SELECT aus und gibt alle Zeilen zurück.
 * @param {string} sql
 * @param {Array} params
 * @returns {Promise<Array>}
 */
function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    getDb().all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

/**
 * Führt ein SELECT aus und gibt die erste Zeile zurück.
 * @param {string} sql
 * @param {Array} params
 * @returns {Promise<Object|undefined>}
 */
function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    getDb().get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

/**
 * Führt INSERT/UPDATE/DELETE aus und gibt { lastID, changes } zurück.
 * @param {string} sql
 * @param {Array} params
 * @returns {Promise<{lastID: number, changes: number}>}
 */
function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    getDb().run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

module.exports = {
  initializeDatabase,
  closeDatabase,
  getDb,
  dbAll,
  dbGet,
  dbRun,
};
