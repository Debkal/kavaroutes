const key='driver-sign-out-notice';
const notice='Signed out of this phone. Server session revocation could not be confirmed; ask your business admin to sign out this device if needed.';
export function rememberUnconfirmedSignout():void {
  try{window.sessionStorage.setItem(key,'unconfirmed');}catch{/* Storage can be disabled; local sign-out must still complete. */}
}
export function takeSignoutNotice():string {
  try{const value=window.sessionStorage.getItem(key);window.sessionStorage.removeItem(key);return value==='unconfirmed'?notice:'';}catch{return '';}
}
