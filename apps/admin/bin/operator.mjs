#!/usr/bin/env node
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openStore } from '../src/store.mjs';
import { digest, randomToken } from '../src/crypto.mjs';
import { readConfig } from '../src/config.mjs';
import { changeInvitedOwner } from '../src/change-owner.mjs';
import { inviteAdmin } from '../src/invite-admin.mjs';

process.umask(0o077);
const [command,...args]=process.argv.slice(2), options={};
for (let i=0;i<args.length;i+=2) {
  if (!['--directory','--mode','--issuer','--audience','--confirm-reset','--previous-email','--email','--role'].includes(args[i]) || !args[i+1]) throw new Error('INVALID_OPTION');
  options[args[i]]=args[i+1];
}
const directory=resolve(options['--directory'] ?? '.tooling/admin-local');
const configPath=resolve(directory,'config.json');
const owner=command==='reset-owner' ? options['--email'] ?? 'kavasupport@kavaroutes.com' : 'kavasupport@kavaroutes.com';
if (command==='init') {
  if (existsSync(configPath) || existsSync(resolve(directory,'admin.sqlite'))) throw new Error('ALREADY_INITIALIZED');
  const mode=options['--mode'] ?? 'local';
  if (!['local','cloudflare'].includes(mode)) throw new Error('INVALID_MODE');
  if (mode==='cloudflare' && (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(options['--issuer'] ?? '') || !/^[a-f0-9]{64}$/.test(options['--audience'] ?? ''))) throw new Error('ACCESS_CONFIGURATION_REQUIRED');
  mkdirSync(directory,{recursive:true,mode:0o700});
  const config={mode,port:58100,origin:mode==='local'?'http://127.0.0.1:58100':'https://admin.kavaroutes.com',database:resolve(directory,'admin.sqlite'),encryptionKey:randomBytes(32).toString('hex'),
    ...(mode==='cloudflare'?{accessIssuer:options['--issuer'],accessAudience:options['--audience']}:{})};
  const token=randomToken(),store=openStore(config.database);
  store.transaction(() => {
    store.run("INSERT INTO admins(email,role,state,invite_hash,invite_expiry) VALUES(?,'OWNER','INVITED',?,?)",owner,digest(token),Date.now()+24*60*60_000);
    store.audit('offline-operator','OWNER_INITIALIZED',owner);
  }); store.close();
  writeFileSync(configPath,JSON.stringify(config,null,2),{flag:'wx',mode:0o600});
  writeFileSync(resolve(directory,'owner-enrollment.json'),JSON.stringify({email:owner,invite:token},null,2),{flag:'wx',mode:0o600});
  console.log(`Created ${configPath}\nEnrollment file: ${resolve(directory,'owner-enrollment.json')}\nThis invitation expires in 24 hours. The file is private; do not commit or share it.\nStart: node apps/admin/src/main.mjs ${configPath}`);
} else if (command==='invite-admin' && options['--email'] && options['--role']) {
  const config=readConfig(configPath),store=openStore(config.database),token=randomToken();
  const email=options['--email'];
  // Hash the filename to avoid treating email characters as path components.
  const file=resolve(directory,`enrollment-${digest(email).slice(0,16)}.json`);
  if (existsSync(file)) { store.close(); throw new Error('ENROLLMENT_FILE_ALREADY_EXISTS'); }
  try { inviteAdmin(store,email,options['--role'],token); } finally { store.close(); }
  writeFileSync(file,JSON.stringify({email,invite:token},null,2),{flag:'wx',mode:0o600});
  console.log(`Additional administrator invitation saved privately: ${file}`);
} else if (command==='change-invited-owner' && options['--previous-email']) {
  const config=readConfig(configPath),store=openStore(config.database),token=randomToken();
  try { changeInvitedOwner(store,options['--previous-email'],owner,token); } finally { store.close(); }
  writeFileSync(resolve(directory,'owner-enrollment.json'),JSON.stringify({email:owner,invite:token},null,2),{mode:0o600});
  console.log('Owner email changed. Previous invitations invalidated; fresh enrollment file saved privately.');
} else if (command==='reset-owner' && options['--confirm-reset']===owner) {
  const config=readConfig(configPath),store=openStore(config.database),token=randomToken();
  store.transaction(() => {
    if (!store.run("UPDATE admins SET state='INVITED',subject=NULL,public_key=NULL,totp_secret=NULL,last_totp=-1,generation=generation+1,invite_hash=?,invite_expiry=? WHERE email=? AND role='OWNER'",digest(token),Date.now()+24*60*60_000,owner).changes) throw new Error('OWNER_NOT_FOUND');
    for (const table of ['sessions','enrollments','challenges']) store.run(`DELETE FROM ${table} WHERE email=?`,owner);
    store.audit('offline-operator','OWNER_RECOVERY_RESET',owner);
  }); store.close();
  writeFileSync(resolve(directory,'owner-enrollment.json'),JSON.stringify({email:owner,invite:token},null,2),{mode:0o600});
  console.log('Owner sessions and factors revoked. Complete fresh enrollment using the private owner-enrollment.json file.');
} else throw new Error('USE_INIT_OR_RESET_OWNER_WITH_EXPLICIT_CONFIRMATION');
