import {readdir,readFile,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {adminStatus} from './logging.mjs';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const email=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function initBusinessSync(store){store.db.exec(`CREATE TABLE IF NOT EXISTS business_account_links(
  business_id TEXT PRIMARY KEY REFERENCES businesses(id),subject TEXT NOT NULL UNIQUE,
  owner_email TEXT NOT NULL,synced_at INTEGER NOT NULL);`);}

function valid(record,id){
  return record&&record.businessId===id&&uuid.test(id)&&typeof record.subject==='string'&&record.subject.length>0&&record.subject.length<=256&&
    typeof record.businessName==='string'&&record.businessName.trim()===record.businessName&&record.businessName.length>0&&record.businessName.length<=120&&!/[\x00-\x1f]/.test(record.businessName)&&
    typeof record.ownerEmail==='string'&&record.ownerEmail.length<=254&&email.test(record.ownerEmail)&&
    ['PENDING','DISABLED'].includes(record.state)&&Number.isSafeInteger(record.createdAt)&&record.createdAt>0;
}
export async function syncSiteBusinesses(store,directory='/var/lib/kavaroutes-registrations'){
  let names;
  try{names=await readdir(directory);}catch(error){if(error.code==='ENOENT')return 0;throw error;}
  let imported=0;
  for(const name of names.sort()){
    if(!uuid.test(name.slice(0,-5))||!name.endsWith('.json'))continue;
    const id=name.slice(0,-5),path=join(directory,name),info=await lstat(path);
    if(!info.isFile()||info.size<20||info.size>4096)throw new Error('BUSINESS_REGISTRATION_INVALID');
    let record;
    try{record=JSON.parse(await readFile(path,'utf8'));}catch{throw new Error('BUSINESS_REGISTRATION_INVALID');}
    if(!valid(record,id))throw new Error('BUSINESS_REGISTRATION_INVALID');
    store.transaction(()=>{
      const bySubject=store.get('SELECT business_id FROM business_account_links WHERE subject=?',record.subject);
      if(bySubject&&bySubject.business_id!==id)throw new Error('BUSINESS_SUBJECT_CONFLICT');
      const existing=store.get('SELECT id FROM businesses WHERE id=?',id);
      if(existing&&!bySubject)throw new Error('BUSINESS_ID_CONFLICT');
      if(bySubject&&store.get('SELECT owner_email FROM business_account_links WHERE business_id=?',id).owner_email===record.ownerEmail)return;
      if(!existing){
        store.run("INSERT INTO businesses(id,name,contact,status,plan,version,created,updated) VALUES(?,?,?,?,'STARTER',1,?,?)",
          id,record.businessName,record.ownerEmail,record.state==='DISABLED'?'SUSPENDED':'TRIAL',record.createdAt,Date.now());
        imported++;
        store.audit('site-registration','BUSINESS_SIGNUP_IMPORTED',id);
      }
      store.run(`INSERT INTO business_account_links(business_id,subject,owner_email,synced_at) VALUES(?,?,?,?)
        ON CONFLICT(business_id) DO UPDATE SET owner_email=excluded.owner_email,synced_at=excluded.synced_at`,
        id,record.subject,record.ownerEmail,Date.now());
    });
  }
  return imported;
}
export function startBusinessSync(store,directory){
  let busy=false;
  const tick=async()=>{if(busy)return;busy=true;try{await syncSiteBusinesses(store,directory);}catch{adminStatus('BUSINESS_SYNC_FAILED');}finally{busy=false;}};
  const timer=setInterval(tick,60000);timer.unref();
  return async()=>{clearInterval(timer);while(busy)await new Promise(resolve=>setTimeout(resolve,50));};
}
