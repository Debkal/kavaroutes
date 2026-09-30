import {initializeApp} from 'firebase/app';
import {initializeAuth,inMemoryPersistence,browserPopupRedirectResolver,signInWithEmailAndPassword,
 signInWithPopup,GoogleAuthProvider,OAuthProvider,signOut,sendPasswordResetEmail,type Auth} from 'firebase/auth';
import {businessContext} from './business-context';

type Config={authEnabled:boolean;firebase:null|{apiKey:string;authDomain:string;projectId:string;tenantId:string}};
let identity:Promise<Auth>|undefined;
async function api<T>(path:string,body?:unknown,csrf?:string):Promise<T>{
 const response=await fetch(path,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',redirect:'error',
  headers:{'content-type':'application/json',...(csrf?{'x-kr-csrf':csrf}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(20000)});
 if(!response.ok)throw Error(response.status===401?'BUSINESS_SIGN_IN_DENIED':'BUSINESS_SIGN_IN_UNAVAILABLE');
 return response.status===204?undefined as T:response.json();
}
let configuration:Promise<Config>|undefined;
export const getBusinessAuthConfig=()=>configuration??=api<Config>('/auth/config').catch(error=>{configuration=undefined;throw error;});
export async function prepareBusinessSignIn(){const config=await getBusinessAuthConfig();if(config.authEnabled)await getIdentity();return config;}
async function getIdentity(){
 return identity??=getBusinessAuthConfig().then(config=>{
  if(!config.authEnabled||!config.firebase)throw Error('BUSINESS_SIGN_IN_UNAVAILABLE');
  const auth=initializeAuth(initializeApp(config.firebase,'business-web'),{persistence:inMemoryPersistence,popupRedirectResolver:browserPopupRedirectResolver});
  auth.tenantId=config.firebase.tenantId;return auth;
 }).catch(error=>{identity=undefined;throw error;});
}
export async function signInBusiness(input:{email:string;password:string}|{provider:'google'|'microsoft'}){
 const auth=await getIdentity();
 try{
  let result;
  if('provider' in input){const provider=input.provider==='google'?new GoogleAuthProvider():new OAuthProvider('microsoft.com');provider.setCustomParameters({prompt:'select_account'});result=await signInWithPopup(auth,provider);}
  else result=await signInWithEmailAndPassword(auth,input.email,input.password);
  if(!result.user.emailVerified)throw Error('BUSINESS_EMAIL_VERIFICATION_REQUIRED');
  const token=await result.user.getIdToken(true);
  const challenge=await api<{csrf:string}>('/auth/challenge',{});
  const {businesses}=await api<{businesses:{organizationId:string;name:string}[]}>('/auth/businesses',{token},challenge.csrf);
  if(!businesses.length)throw Error('BUSINESS_MEMBERSHIP_REQUIRED');
  // Provider token is held in this short-lived closure only, then discarded after
  // workspace selection. It is never written into storage, cookies or a URL.
  return {businesses,async select(organizationId:string){
   if(!businesses.some(business=>business.organizationId===organizationId))throw Error('BUSINESS_MEMBERSHIP_REQUIRED');
   await api('/auth/login',{organizationId,token},challenge.csrf);
  }};
 }finally{await signOut(auth);}
}
export async function resetBusinessPassword(email:string){await sendPasswordResetEmail(await getIdentity(),email);}
export async function signOutBusiness(){
 const context=businessContext();
 if(context.mode==='test'){window.location.assign('/cdn-cgi/access/logout');return;}
 await api('/auth/logout',{},context.csrf??undefined);window.location.assign('/sign-in');
}
