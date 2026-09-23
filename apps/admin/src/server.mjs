import {mailView,saveCustomer,saveTemplate,previewEmail,queueEmail,cancelEmail,saveRule} from './customer-mail.mjs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { base32, decrypt, digest, encrypt, equal, publicKey, randomToken, verifySignature, verifyTotp } from './crypto.mjs';
import { identityVerifier } from './identity.mjs';
import {accountingView,saveSubscription,createInvoice,changeInvoice,createExpense,voidExpense,recordUsage} from './accounting.mjs';

const fail = (status = 401, code = 'AUTHENTICATION_FAILED') => { throw Object.assign(new Error(code), { status, code }); };
const emailValue = value => {
  if (typeof value !== 'string' || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) fail(400, 'INVALID_EMAIL');
  return value.toLowerCase();
};
const field = (value, max = 120) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f]/.test(value)) fail(400, 'INVALID_FIELD');
  return value.trim();
};
function cookies(request) {
  const result = {};
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const index = part.indexOf('='); if (index > 0) result[part.slice(0, index).trim()] = part.slice(index + 1);
  }
  return result;
}
async function body(request) {
  if (request.headers['content-type'] !== 'application/json') fail(415, 'JSON_REQUIRED');
  let length = 0, parts = [];
  for await (const part of request) {
    length += part.length; if (length > 24_000) fail(413, 'REQUEST_TOO_LARGE'); parts.push(part);
  }
  try {
    const value = JSON.parse(Buffer.concat(parts).toString());
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
    return value;
  } catch { fail(400, 'INVALID_JSON'); }
}

export function createAdminServer({ config, store, verifyIdentity = identityVerifier(config) }) {
  const local = config.mode === 'local';
  const prefix = local ? 'kr_admin_' : '__Host-kr_admin_';
  const cookie = (name, value, age) => `${prefix}${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${local ? '' : '; Secure'}`;
  const key = config.encryptionKey;
  const assets = new Map([['/', ['index.html','text/html']], ['/app.js',['app.js','text/javascript']], ['/style.css',['style.css','text/css']]]);
  for(const file of ['finance.js','csv.js','cost-model.js','customers.js'])assets.set(`/${file}`,[file,'text/javascript']);
  function limit(name, max, duration) {
    const now = Date.now();
    store.run('DELETE FROM limits WHERE expires<=?', now);
    store.run(`INSERT INTO limits(key,count,expires) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1`, name, now + duration);
    if (store.get('SELECT count FROM limits WHERE key=?', name).count > max) fail(429, 'TOO_MANY_ATTEMPTS');
  }
  function cleanup() {
    for (const table of ['challenges','enrollments','sessions']) store.run(`DELETE FROM ${table} WHERE expires<=?`, Date.now());
  }
  async function identity(request, email) {
    let found;
    try { found = await verifyIdentity(request, email); } catch { fail(); }
    if (found.email !== email) fail();
    return found;
  }
  async function account(request, email) {
    const who = await identity(request, email);
    const admin = store.get('SELECT * FROM admins WHERE email=?', email);
    if (!admin || admin.state === 'REVOKED' || (admin.subject && admin.subject !== who.subject)) fail();
    return { admin, who };
  }
  async function session(request, csrf = true) {
    const token = cookies(request)[`${prefix}session`]; if (!token) fail();
    const saved = store.get('SELECT * FROM sessions WHERE token_hash=? AND expires>?', digest(token), Date.now());
    if (!saved) fail();
    const { admin } = await account(request, saved.email);
    if (admin.state !== 'ACTIVE' || admin.generation !== saved.generation) fail();
    if (csrf && !equal(digest(String(request.headers['x-admin-csrf'] ?? '')), saved.csrf_hash)) fail(403, 'CSRF_REQUIRED');
    return { admin, saved, token };
  }
  function owner(admin) { if (admin.role !== 'OWNER') fail(403, 'OWNER_REQUIRED'); }
  function issue(reply, admin) {
    const token = randomToken(), csrf = randomToken(), expires = Date.now() + 30 * 60_000;
    store.run('INSERT INTO sessions VALUES(?,?,?,?,?)', digest(token), admin.email, digest(csrf), expires, admin.generation);
    reply.setHeader('Set-Cookie', [cookie('session', token, 1800), cookie('browser','',0)]);
    return { csrf, expires, email: admin.email, role: admin.role };
  }
  return createServer(async (request, reply) => {
    reply.setHeader('Cache-Control','no-store');
    reply.setHeader('X-Content-Type-Options','nosniff');
    reply.setHeader('Referrer-Policy','no-referrer');
    reply.setHeader('X-Frame-Options','DENY');
    reply.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const send = (value, status = 200) => { reply.writeHead(status, {'Content-Type':'application/json; charset=utf-8'}); reply.end(JSON.stringify(value)); };
    try {
      if (request.headers.host !== new URL(config.origin).host) fail(403, 'HOST_NOT_ALLOWED');
      const path = request.url;
      if (request.method === 'GET' && path === '/signer.mjs') {
        reply.writeHead(200, {'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="signer.mjs"'});
        return reply.end(await readFile(new URL('../bin/signer.mjs',import.meta.url)));
      }
      if (request.method === 'GET' && assets.has(path)) {
        const [file, type] = assets.get(path);
        reply.writeHead(200, {'Content-Type':`${type}; charset=utf-8`});
        return reply.end(await readFile(new URL(`../public/${file}`, import.meta.url)));
      }
      if (request.method === 'GET' && path === '/health/ready') return send({status:'READY', mode:config.mode, integration:'TEST_REGISTRY'});
      if (request.method !== 'POST' || !path?.startsWith('/api/')) fail(404, 'NOT_FOUND');
      if (request.headers.origin !== config.origin || request.headers['sec-fetch-site'] === 'cross-site') fail(403, 'ORIGIN_NOT_ALLOWED');
      limit('global', 180, 60_000); cleanup();
      const data = await body(request);
      if (path === '/api/config') return send({mode:config.mode, origin:config.origin, integration:'TEST_REGISTRY', algorithm:'ML-DSA-65'});
      if (path === '/api/challenge') {
        const email = emailValue(data.email);
        limit(`auth:${digest(email)}`, 12, 5 * 60_000);
        const { admin } = await account(request, email);
        const purpose = admin.state === 'INVITED' ? 'enroll' : 'login';
        if (purpose === 'enroll' && (!admin.invite_hash || admin.invite_expiry <= Date.now() || !equal(admin.invite_hash, digest(String(data.invite ?? ''))))) fail();
        const browser = randomToken(), id = randomUUID(), expires = Date.now() + 10 * 60_000;
        const text = JSON.stringify({ protocol:'KavaRoutes admin authentication v1', algorithm:'ML-DSA-65', origin:config.origin, email, purpose, id, nonce:randomToken(), expires });
        store.run('INSERT INTO challenges VALUES(?,?,?,?,?,?,?)', id, email, digest(browser), purpose, text, expires, admin.generation);
        reply.setHeader('Set-Cookie', cookie('browser',browser,900));
        return send({challenge:text, purpose});
      }
      if (path === '/api/prove') {
        const signed = data.response;
        if (!signed || typeof signed !== 'object' || typeof signed.challenge !== 'string' || signed.challenge.length > 2000) fail();
        let parsed; try { parsed = JSON.parse(signed.challenge); } catch { fail(); }
        if (typeof parsed.id !== 'string') fail();
        const saved = store.get('SELECT * FROM challenges WHERE id=?', parsed.id);
        const browser = cookies(request)[`${prefix}browser`];
        if (!saved || !browser || !equal(saved.browser_hash,digest(browser)) || saved.expires <= Date.now() || saved.text !== signed.challenge) fail();
        const { admin, who } = await account(request, saved.email);
        limit(`proof:${digest(admin.email)}`, 12, 5 * 60_000);
        // Consume before checking proof: every challenge admits exactly one attempt.
        if (!store.run('DELETE FROM challenges WHERE id=?', parsed.id).changes || admin.generation !== saved.generation) fail();
        let pem; try { pem = saved.purpose === 'enroll' ? publicKey(signed.publicKey) : admin.public_key; } catch { fail(); }
        if (!pem || !verifySignature(pem, saved.text, signed.signature)) { store.audit(admin.email,'AUTH_FAILED',admin.email); fail(); }
        if (saved.purpose === 'enroll') {
          if (admin.state !== 'INVITED' || admin.invite_expiry <= Date.now()) fail();
          const secret = randomBytes(20), token = randomToken();
          const uri = `otpauth://totp/${encodeURIComponent(`KavaRoutes Admin:${admin.email}`)}?secret=${base32(secret)}&issuer=KavaRoutes%20Admin&algorithm=SHA1&digits=6&period=30`;
          const qr = await QRCode.toDataURL(uri, {errorCorrectionLevel:'M',margin:2,width:280});
          store.run('INSERT INTO enrollments VALUES(?,?,?,?,?,?,?,?)', digest(token), admin.email, digest(browser), pem, encrypt(secret,key,admin.email), who.subject, Date.now()+5*60_000, admin.generation);
          secret.fill(0);
          return send({ enrollment:token, qr });
        }
        if (admin.state !== 'ACTIVE') fail();
        const step = verifyTotp(decrypt(admin.totp_secret,key,admin.email), data.code, admin.last_totp);
        if (step === null) { store.audit(admin.email,'AUTH_FAILED',admin.email); fail(); }
        const result = store.transaction(() => {
          if (!store.run('UPDATE admins SET last_totp=? WHERE email=? AND last_totp<? AND generation=? AND state=\'ACTIVE\'', step, admin.email, step, admin.generation).changes) fail();
          store.audit(admin.email,'SIGNED_IN',admin.email);
          return issue(reply,admin);
        });
        return send(result);
      }
      if (path === '/api/enroll') {
        if (typeof data.enrollment !== 'string') fail();
        const pending = store.get('SELECT * FROM enrollments WHERE token_hash=?', digest(data.enrollment));
        const browser = cookies(request)[`${prefix}browser`];
        if (!pending || pending.expires<=Date.now() || !browser || !equal(pending.browser_hash,digest(browser))) fail();
        const { admin, who } = await account(request,pending.email);
        limit(`enroll:${digest(admin.email)}`, 8, 5*60_000);
        if (admin.state!=='INVITED' || admin.generation!==pending.generation || who.subject!==pending.subject || admin.invite_expiry<=Date.now()) fail();
        const step = verifyTotp(decrypt(pending.secret,key,admin.email),data.code);
        if (step === null) fail();
        return send(store.transaction(() => {
          store.run(`UPDATE admins SET state='ACTIVE',public_key=?,totp_secret=?,subject=?,last_totp=?,invite_hash=NULL,invite_expiry=NULL,generation=generation+1 WHERE email=?`,pending.public_key,pending.secret,pending.subject,step,admin.email);
          store.run('DELETE FROM enrollments WHERE email=?',admin.email);
          store.run('DELETE FROM challenges WHERE email=?',admin.email);
          store.audit(admin.email,'ENROLLED',admin.email);
          return issue(reply,store.get('SELECT * FROM admins WHERE email=?',admin.email));
        }));
      }
      if (path === '/api/session') {
        // Same-origin POST restores CSRF after a reload without extending the session.
        const { admin, saved } = await session(request,false);
        const csrf = randomToken();
        store.run('UPDATE sessions SET csrf_hash=? WHERE token_hash=?',digest(csrf),saved.token_hash);
        return send({csrf,email:admin.email,role:admin.role,expires:saved.expires});
      }
      const { admin, saved } = await session(request);
      if(path==='/api/customer-mail')return send(mailView(store,config));
      if(path==='/api/accounting')return send(accountingView(store,data.month));
      if (path === '/api/logout') {
        store.run('DELETE FROM sessions WHERE token_hash=?',saved.token_hash);
        reply.setHeader('Set-Cookie',cookie('session','',0)); return send({ok:true});
      }
      if (path === '/api/dashboard') return send({
        businesses:store.all('SELECT * FROM businesses ORDER BY updated DESC LIMIT 500'),
        admins:store.all('SELECT email,role,state FROM admins ORDER BY role,email'),
        audit:store.all('SELECT * FROM audit ORDER BY id DESC LIMIT 100'),
        integration:'TEST_REGISTRY',
      });
      owner(admin);
      const mailCommands={'/api/customer-contact':saveCustomer,'/api/email-template':saveTemplate,'/api/email-preview':previewEmail,'/api/email-queue':queueEmail,'/api/email-cancel':cancelEmail,'/api/email-rule':saveRule};
      if(mailCommands[path])return send(mailCommands[path](store,admin.email,data));
      const financialCommands={'/api/subscription':saveSubscription,'/api/invoice':createInvoice,'/api/invoice-status':changeInvoice,'/api/expense':createExpense,'/api/expense-void':voidExpense,'/api/usage':recordUsage};
      if(financialCommands[path])return send(financialCommands[path](store,admin.email,data));
      if (path === '/api/business') {
        const name = field(data.name), contact = emailValue(data.contact);
        if (!['TRIAL','ACTIVE','SUSPENDED'].includes(data.status) || !['STARTER','GROWTH','ENTERPRISE'].includes(data.plan)) fail(400,'INVALID_BUSINESS');
        const id = data.id ? field(data.id,36) : randomUUID();
        store.transaction(() => {
          if (data.id) {
            if (!Number.isSafeInteger(data.version) || !store.run('UPDATE businesses SET name=?,contact=?,status=?,plan=?,version=version+1,updated=? WHERE id=? AND version=?',name,contact,data.status,data.plan,Date.now(),id,data.version).changes) fail(409,'BUSINESS_CHANGED_RELOAD');
          } else store.run('INSERT INTO businesses VALUES(?,?,?,?,?,1,?,?)',id,name,contact,data.status,data.plan,Date.now(),Date.now());
          store.audit(admin.email,data.id?'TEST_BUSINESS_UPDATED':'TEST_BUSINESS_CREATED',id);
        });
        return send({id});
      }
      if (path === '/api/invite') {
        const email = emailValue(data.email), token = randomToken();
        const existing = store.get('SELECT * FROM admins WHERE email=?',email);
        if (existing && existing.state !== 'REVOKED') fail(409,'ACCOUNT_EXISTS');
        store.transaction(() => {
          store.run(`INSERT INTO admins(email,role,state,invite_hash,invite_expiry) VALUES(?,'SUPPORT','INVITED',?,?)
            ON CONFLICT(email) DO UPDATE SET state='INVITED',invite_hash=excluded.invite_hash,invite_expiry=excluded.invite_expiry,subject=NULL,public_key=NULL,totp_secret=NULL,last_totp=-1,generation=generation+1`,email,digest(token),Date.now()+24*60*60_000);
          store.audit(admin.email,'SUPPORT_INVITED',email);
        });
        return send({email,invite:token,expires:Date.now()+24*60*60_000});
      }
      if (path === '/api/revoke') {
        const email = emailValue(data.email);
        store.transaction(() => {
          if (!store.run("UPDATE admins SET state='REVOKED',generation=generation+1,invite_hash=NULL,public_key=NULL,totp_secret=NULL WHERE email=? AND role='SUPPORT'",email).changes) fail(400,'SUPPORT_ACCOUNT_REQUIRED');
          for (const table of ['sessions','challenges','enrollments']) store.run(`DELETE FROM ${table} WHERE email=?`,email);
          store.audit(admin.email,'SUPPORT_REVOKED',email);
        }); return send({ok:true});
      }
      fail(404,'NOT_FOUND');
    } catch (error) {
      if (reply.headersSent) return reply.end();
      if (error.status === 429) reply.setHeader('Retry-After','300');
      send({error:error.code && error.status ? error.code : 'REQUEST_FAILED'},error.status ?? 500);
    }
  });
}
