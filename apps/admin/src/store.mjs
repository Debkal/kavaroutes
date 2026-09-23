import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { initCustomerMail } from './customer-mail.mjs';
import { initAccounting } from './accounting.mjs';

export function openStore(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  if (path !== ':memory:') chmodSync(path, 0o600);
  db.exec('PRAGMA synchronous=FULL');
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS admins (
      email TEXT PRIMARY KEY, role TEXT NOT NULL CHECK(role IN ('OWNER','SUPPORT')),
      state TEXT NOT NULL CHECK(state IN ('INVITED','ACTIVE','REVOKED')),
      invite_hash TEXT, invite_expiry INTEGER, subject TEXT,
      public_key TEXT, totp_secret TEXT, last_totp INTEGER NOT NULL DEFAULT -1,
      generation INTEGER NOT NULL DEFAULT 1
    );
    -- Multiple full administrators are provisioned by the offline operator.
    -- Public dashboard invitations remain SUPPORT-only.
    DROP INDEX IF EXISTS one_owner;
    CREATE TABLE IF NOT EXISTS challenges (
      id TEXT PRIMARY KEY, email TEXT NOT NULL REFERENCES admins(email),
      browser_hash TEXT NOT NULL, purpose TEXT NOT NULL,
      text TEXT NOT NULL, expires INTEGER NOT NULL, generation INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS enrollments (
      token_hash TEXT PRIMARY KEY, email TEXT NOT NULL REFERENCES admins(email),
      browser_hash TEXT NOT NULL, public_key TEXT NOT NULL, secret TEXT NOT NULL,
      subject TEXT NOT NULL, expires INTEGER NOT NULL, generation INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, email TEXT NOT NULL REFERENCES admins(email),
      csrf_hash TEXT NOT NULL, expires INTEGER NOT NULL, generation INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS businesses (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, contact TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('TRIAL','ACTIVE','SUSPENDED')),
      plan TEXT NOT NULL CHECK(plan IN ('STARTER','GROWTH','ENTERPRISE')),
      version INTEGER NOT NULL DEFAULT 1, created INTEGER NOT NULL, updated INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY, at INTEGER NOT NULL, actor TEXT NOT NULL,
      action TEXT NOT NULL, target TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
  `);
  const store = {
    db,
    get: (sql, ...args) => db.prepare(sql).get(...args),
    all: (sql, ...args) => db.prepare(sql).all(...args),
    run: (sql, ...args) => db.prepare(sql).run(...args),
    transaction(fn) {
      db.exec('BEGIN IMMEDIATE');
      try { const value = fn(); db.exec('COMMIT'); return value; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    audit(actor, action, target) { db.prepare('INSERT INTO audit(at,actor,action,target) VALUES(?,?,?,?)').run(Date.now(), actor, action, target); },
    close: () => db.close(),
  };
  initAccounting(store);
  initCustomerMail(store);
  return store;
}
