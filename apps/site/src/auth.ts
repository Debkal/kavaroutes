import {initializeApp} from 'firebase/app';
import {initializeAuth,inMemoryPersistence,browserPopupRedirectResolver,createUserWithEmailAndPassword,
  signInWithEmailAndPassword,signInWithPopup,GoogleAuthProvider,OAuthProvider,sendEmailVerification,
  sendPasswordResetEmail,signOut,updateProfile,type Auth,type User} from 'firebase/auth';

type Config={authEnabled:boolean;firebase:null|{apiKey:string;authDomain:string;projectId:string;tenantId:string}};
let configuration:Promise<Config>|undefined;
let auth:Auth|undefined;
export async function api<T>(path:string,body?:unknown):Promise<T>{
  const response=await fetch(path,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',redirect:'error',
    headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(20000)});
  if(!response.ok){const data=await response.json().catch(()=>({}));throw Object.assign(new Error('Request failed'),{code:data.error??'REQUEST_UNAVAILABLE'});}
  return response.status===204?undefined as T:response.json();
}
export function getConfig(){return configuration??=api<Config>('/api/config').catch(error=>{configuration=undefined;throw error;});}
async function getIdentity(){
  if(auth)return auth;
  const config=await getConfig();
  if(!config.authEnabled||!config.firebase)throw {code:'SIGN_IN_UNAVAILABLE'};
  auth=initializeAuth(initializeApp(config.firebase),{persistence:inMemoryPersistence,popupRedirectResolver:browserPopupRedirectResolver});
  auth.tenantId=config.firebase.tenantId;
  return auth;
}
async function finish(user:User,businessName?:string){
  if(!user.emailVerified){
    await sendEmailVerification(user);
    return 'VERIFY_EMAIL' as const;
  }
  await api('/api/session',{token:await user.getIdToken(true),...(businessName?.trim()?{businessName:businessName.trim()}:{})});
  return 'SIGNED_IN' as const;
}
export async function emailSignIn(email:string,password:string,businessName?:string){
  const identity=await getIdentity();
  try{return await finish((await signInWithEmailAndPassword(identity,email,password)).user,businessName);}
  finally{await signOut(identity);}
}
export async function emailSignUp(email:string,password:string,businessName:string){
  const identity=await getIdentity();
  try{const {user}=await createUserWithEmailAndPassword(identity,email,password);await updateProfile(user,{displayName:businessName.trim()});await sendEmailVerification(user);}
  finally{await signOut(identity);}
}
export async function socialSignIn(provider:'google'|'microsoft',businessName?:string){
  const identity=await getIdentity();
  const selected=provider==='google'?new GoogleAuthProvider():new OAuthProvider('microsoft.com');
  selected.setCustomParameters({prompt:'select_account'});
  try{return await finish((await signInWithPopup(identity,selected)).user,businessName);}
  finally{await signOut(identity);}
}
export async function resetPassword(email:string){
  try{await sendPasswordResetEmail(await getIdentity(),email);}
  catch(error){if((error as {code?:string}).code!=='auth/user-not-found')throw error;}
}
export function messageFor(error:unknown){
  const code=(error as {code?:string})?.code;
  const messages:Record<string,string>={
    SIGN_IN_UNAVAILABLE:'Business sign-in is being prepared. Please check back soon.',
    BUSINESS_SIGN_IN_REQUIRED:'Use a verified business account to continue. Driver accounts cannot sign in here.',
    BUSINESS_PROFILE_REQUIRED:'Enter your business name to finish setting up your account, then sign in again.',
    BUSINESS_ACCESS_UNAVAILABLE:'This business account is unavailable. Please contact support.',
    SIGN_IN_REQUIRED:'Please sign in to view your business account.',
    'auth/invalid-credential':'We could not sign you in with those details. Please try again.',
    'auth/wrong-password':'We could not sign you in with those details. Please try again.',
    'auth/user-not-found':'We could not sign you in with those details. Please try again.',
    'auth/email-already-in-use':'Unable to create this account. Try signing in or resetting your password.',
    'auth/weak-password':'Choose a stronger password with at least 12 characters.',
    'auth/password-does-not-meet-requirements':'Your password does not meet the account security requirements. Please choose a stronger password.',
    'auth/too-many-requests':'Too many attempts. Please wait a moment and try again.',
    'auth/popup-closed-by-user':'Sign-in was closed. You can try again when you’re ready.',
    'auth/popup-blocked':'Your browser blocked the sign-in window. Allow pop-ups for this site and try again.',
    'auth/account-exists-with-different-credential':'Use the sign-in method you originally used for this email address.',
    'auth/operation-not-allowed':'This sign-in option is not available yet. Please try another option.',
  };
  return messages[code??'']??'We could not complete that request. Please try again.';
}
