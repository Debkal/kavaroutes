import { digest } from './crypto.mjs';

// Offline provisioning only. The public invitation endpoint stays support-only.
export function inviteAdmin(store, email, role, token) {
  if (typeof email !== 'string' || email !== email.toLowerCase() || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('INVALID_EMAIL');
  if (!['OWNER','SUPPORT'].includes(role)) throw new Error('INVALID_ROLE');
  store.transaction(()=>{
    if (store.get('SELECT email FROM admins WHERE email=?',email)) throw new Error('ACCOUNT_ALREADY_EXISTS');
    store.run("INSERT INTO admins(email,role,state,invite_hash,invite_expiry) VALUES(?,?,'INVITED',?,?)",email,role,digest(token),Date.now()+24*60*60_000);
    store.audit('offline-operator',role==='OWNER'?'OWNER_INVITED':'SUPPORT_INVITED',email);
  });
}
