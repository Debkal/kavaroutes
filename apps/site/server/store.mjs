import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync,writeFileSync,renameSync,unlinkSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
const hash=value=>createHash('sha256').update(value).digest('hex');
export function openStore(path,{registrationDirectory=null}={}) {
  if(path!==':memory:')mkdirSync(dirname(path),{recursive:true,mode:0o700});
  const db=new DatabaseSync(path);
  if(path!==':memory:')chmodSync(path,0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS business_accounts (
      subject TEXT PRIMARY KEY, id TEXT UNIQUE NOT NULL, business_name TEXT NOT NULL, owner_email TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','DISABLED')),
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS site_sessions (
      token_hash TEXT PRIMARY KEY, subject TEXT NOT NULL REFERENCES business_accounts(subject),
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );`);
  const columns=db.prepare('PRAGMA table_info(business_accounts)').all().map(row=>row.name);
  if(!columns.includes('id'))db.exec('ALTER TABLE business_accounts ADD COLUMN id TEXT');
  if(!columns.includes('owner_email'))db.exec('ALTER TABLE business_accounts ADD COLUMN owner_email TEXT');
  for(const row of db.prepare('SELECT subject FROM business_accounts WHERE id IS NULL').all())
    db.prepare('UPDATE business_accounts SET id=? WHERE subject=?').run(randomUUID(),row.subject);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS business_accounts_id ON business_accounts(id)');
  const rowFor=subject=>db.prepare('SELECT id AS businessId,subject,business_name AS businessName,owner_email AS ownerEmail,state,created_at AS createdAt FROM business_accounts WHERE subject=?').get(subject);
  const publish=subject=>{
    const row=rowFor(subject);
    if(!row||!registrationDirectory||!row.ownerEmail)return;
    mkdirSync(registrationDirectory,{recursive:true,mode:0o750});
    const target=join(registrationDirectory,`${row.businessId}.json`),temporary=join(registrationDirectory,`.${row.businessId}.${randomUUID()}.tmp`);
    try{
      writeFileSync(temporary,JSON.stringify(row)+'\n',{flag:'wx',mode:0o640});
      chmodSync(temporary,0o640);
      renameSync(temporary,target);
    }finally{try{unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}}
  };
  return {
    get:subject=>rowFor(subject),
    enroll(subject,businessName,email){db.prepare('INSERT INTO business_accounts(subject,id,business_name,owner_email,created_at) VALUES(?,?,?,?,?) ON CONFLICT(subject) DO NOTHING').run(subject,randomUUID(),businessName,email,Date.now());publish(subject);},
    refreshRegistration(subject,email){db.prepare('UPDATE business_accounts SET owner_email=? WHERE subject=?').run(email,subject);publish(subject);},
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
