import { digest } from './crypto.mjs';

// Only an offline operator may move a not-yet-enrolled owner invitation.
// Active owners require an explicit identity/factor migration, never this path.
export function changeInvitedOwner(store, previous, next, token) {
  if (![previous,next].every(email=>typeof email==='string' && email.length<=254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) || previous===next) throw new Error('INVALID_EMAIL_CHANGE');
  store.transaction(()=>{
    const owner=store.get("SELECT * FROM admins WHERE role='OWNER' AND email=?",previous);
    if (!owner || owner.email!==previous || owner.state!=='INVITED') throw new Error('UNENROLLED_OWNER_REQUIRED');
    if (store.get('SELECT email FROM admins WHERE email=?',next)) throw new Error('EMAIL_ALREADY_REGISTERED');
    for (const table of ['sessions','enrollments','challenges']) store.run(`DELETE FROM ${table} WHERE email=?`,previous);
    store.run("UPDATE admins SET email=?,invite_hash=?,invite_expiry=?,generation=generation+1 WHERE email=? AND role='OWNER'",next,digest(token),Date.now()+24*60*60_000,previous);
    store.audit('offline-operator','OWNER_EMAIL_REPLACED',previous);
    store.audit('offline-operator','OWNER_INVITATION_REISSUED',next);
  });
}
