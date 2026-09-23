import {initializeApp,applicationDefault} from 'firebase-admin/app';
import {getAuth} from 'firebase-admin/auth';
export function createIdentity(config) {
  if(!config.authEnabled)return null;
  if(process.env.FIREBASE_AUTH_EMULATOR_HOST)throw new Error('SITE_AUTH_EMULATOR_DENIED');
  const app=initializeApp({projectId:config.firebase.projectId,credential:applicationDefault()},'business-site');
  const auth=getAuth(app).tenantManager().authForTenant(config.firebase.tenantId);
  return {verify:token=>auth.verifyIdToken(token,true),account:subject=>auth.getUser(subject)};
}
