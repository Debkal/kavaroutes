import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync} from 'node:fs';
import {dirname} from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
const hash=value=>createHash('sha256').update(value).digest('hex');
export function openStore(path) {
  if(path!==':memory:')mkdirSync(dirname(path),{recursive:true,mode:0o700});
  const db=new DatabaseSync(path);
  if(path!==':memory:')chmodSync(path,0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS business_accounts (
      subject TEXT PRIMARY KEY, business_name TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','DISABLED')),
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS site_sessions (
      token_hash TEXT PRIMARY KEY, subject TEXT NOT NULL REFERENCES business_accounts(subject),
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );`);
  return {
    get:subject=>db.prepare('SELECT business_name AS businessName,state FROM business_accounts WHERE subject=?').get(subject),
    enroll(subject,businessName){db.prepare('INSERT INTO business_accounts(subject,business_name,created_at) VALUES(?,?,?) ON CONFLICT(subject) DO NOTHING').run(subject,businessName,Date.now());},
    issue(subject){
      db.prepare('DELETE FROM site_sessions WHERE expires_at<=?').run(Date.now());
      const token=randomBytes(32).toString('base64url');
      db.prepare('INSERT INTO site_sessions VALUES(?,?,?,?)').run(hash(token),subject,Date.now(),Date.now()+3600_000);
      return token;
    },
    session:token=>db.prepare('SELECT subject,created_at AS createdAt FROM site_sessions WHERE token_hash=? AND expires_at>?').get(hash(token),Date.now()),
    revoke:token=>db.prepare('DELETE FROM site_sessions WHERE token_hash=?').run(hash(token)),
    close:()=>db.close(),
  };
}
