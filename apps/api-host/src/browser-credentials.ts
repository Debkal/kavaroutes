import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const sessionName='__Host-kr-session';
const challengeName='__Host-kr-login';
const randomPattern=/^[A-Za-z0-9_-]{43}$/;
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const cookieOptions='Path=/; Secure; HttpOnly; SameSite=Strict';
const deny=()=>new Error('BROWSER_CREDENTIAL_DENIED');
const random=()=>randomBytes(32).toString('base64url');
export const hashBrowserCredential=(value:string)=>createHash('sha256').update(value).digest('hex');

function equal(left:string,right:string) {
  const a=Buffer.from(left),b=Buffer.from(right);
  return a.length===b.length && timingSafeEqual(a,b);
}
function readCookie(header:unknown,name:string):string|null {
  if(header===undefined) return null;
  if(typeof header!=='string'||header.length>4096||/[\r\n]/.test(header)) throw deny();
  const values=header.split(';').map(part=>part.trim()).filter(part=>part.startsWith(`${name}=`));
  if(values.length>1) throw deny();
  return values[0]?.slice(name.length+1)??null;
}

/** Host-only browser credential encoding. Tenant in the cookie is only a lookup
 * hint; the session repository must validate its random credential and binding.
 * No provider token, password, role or signature is embedded in these cookies.
 */
export function createBrowserCredentials(options:{origin:string;signingKey:Buffer;now?:()=>number}) {
  const origin=new URL(options.origin);
  if(origin.protocol!=='https:'||origin.origin!==options.origin||options.signingKey.length<32) throw new Error('BROWSER_CREDENTIAL_CONFIG_INVALID');
  const key=Buffer.from(options.signingKey),now=options.now??(()=>Math.floor(Date.now()/1000));
  const sign=(value:string)=>createHmac('sha256',key).update(`kr-login-v1:${value}`).digest('base64url');
  // Domain separated from login challenges; stable per session for reloads and
  // multiple tabs. The opaque bearer itself is never returned in JSON.
  const sessionCsrf=(value:string)=>createHmac('sha256',key).update(`kr-session-csrf-v1:${value}`).digest('base64url');
  const parseSession=(cookie:unknown)=>{
    const raw=readCookie(cookie,sessionName);
    if(!raw)return null;
    const parts=raw.split('.');
    if(parts.length!==2||!uuid.test(parts[0]!)||!randomPattern.test(parts[1]!))throw deny();
    return {raw,organizationId:parts[0]!,tokenHash:hashBrowserCredential(parts[1]!)};
  };
  const clock=()=>{const value=now();if(!Number.isSafeInteger(value)||value<0)throw deny();return value;};
  return Object.freeze({
    assertSameOrigin(headers:{origin?:unknown;'sec-fetch-site'?:unknown}) {
      if(headers.origin!==options.origin ||
        (headers['sec-fetch-site']!==undefined&&headers['sec-fetch-site']!=='same-origin')) throw deny();
    },
    challenge() {
      const csrf=random(),payload=`${clock()}.${csrf}`;
      return {csrf,cookie:`${challengeName}=${payload}.${sign(payload)}; ${cookieOptions}; Max-Age=300`};
    },
    verifyChallenge(cookie:unknown,csrf:unknown) {
      if(typeof csrf!=='string'||!randomPattern.test(csrf)) throw deny();
      const raw=readCookie(cookie,challengeName);
      if(!raw||raw.length>120) throw deny();
      const parts=raw.split('.');
      if(parts.length!==3||!/^\d{1,12}$/.test(parts[0]!)||!randomPattern.test(parts[1]!)||!randomPattern.test(parts[2]!))throw deny();
      const issued=Number(parts[0]),age=clock()-issued;
      if(age<0||age>=300||!equal(parts[1]!,csrf)||!equal(parts[2]!,sign(`${parts[0]}.${parts[1]}`)))throw deny();
    },
    issue(organizationId:string) {
      if(!uuid.test(organizationId)) throw deny();
      const token=random(),csrf=sessionCsrf(`${organizationId}.${token}`);
      return {csrf,tokenHash:hashBrowserCredential(token),csrfHash:hashBrowserCredential(csrf),
        cookie:`${sessionName}=${organizationId}.${token}; ${cookieOptions}; Max-Age=3600`};
    },
    read(cookie:unknown,csrf?:unknown) {
      const parsed=parseSession(cookie);
      if(!parsed)return null;
      if(csrf!==undefined&&(typeof csrf!=='string'||!randomPattern.test(csrf)))throw deny();
      return {organizationId:parsed.organizationId,tokenHash:parsed.tokenHash,
        ...(typeof csrf==='string'?{csrfHash:hashBrowserCredential(csrf)}:{})};
    },
    recover(cookie:unknown) {
      const parsed=parseSession(cookie);
      if(!parsed)return null;
      const csrf=sessionCsrf(parsed.raw);
      // Caller must resolve these hashes against the active database session
      // before disclosing csrf. This never creates or extends a session.
      return {organizationId:parsed.organizationId,tokenHash:parsed.tokenHash,csrfHash:hashBrowserCredential(csrf),csrf};
    },
    clearSession:`${sessionName}=; ${cookieOptions}; Max-Age=0`,
    clearChallenge:`${challengeName}=; ${cookieOptions}; Max-Age=0`,
  });
}
