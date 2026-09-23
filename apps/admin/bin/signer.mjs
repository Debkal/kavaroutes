#!/usr/bin/env node
// Portable, dependency-free Windows/Debian signer. Never uploads a private key.
import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, scryptSync, sign } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';

export function protectPrivateKey(privateKey, passphrase) {
  if (passphrase.length < 16) throw new Error('Use a passphrase of at least 16 characters.');
  const salt = randomBytes(16), iv = randomBytes(12);
  const key = scryptSync(passphrase,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024});
  const cipher = createCipheriv('aes-256-gcm',key,iv);
  cipher.setAAD(Buffer.from('KavaRoutes ML-DSA-65 private key v1'));
  const clear = privateKey.export({type:'pkcs8',format:'der'});
  const ciphertext = Buffer.concat([cipher.update(clear),cipher.final()]); clear.fill(0); key.fill(0);
  return {version:1,algorithm:'ML-DSA-65',kdf:'scrypt-N32768-r8-p1',salt:salt.toString('base64'),iv:iv.toString('base64'),ciphertext:ciphertext.toString('base64'),tag:cipher.getAuthTag().toString('base64')};
}
export function unlockPrivateKey(envelope, passphrase) {
  if (envelope.version!==1 || envelope.algorithm!=='ML-DSA-65' || envelope.kdf!=='scrypt-N32768-r8-p1') throw new Error('Unsupported key file.');
  const key = scryptSync(passphrase,Buffer.from(envelope.salt,'base64'),32,{N:32768,r:8,p:1,maxmem:64*1024*1024});
  const cipher = createDecipheriv('aes-256-gcm',key,Buffer.from(envelope.iv,'base64'));
  cipher.setAAD(Buffer.from('KavaRoutes ML-DSA-65 private key v1')); cipher.setAuthTag(Buffer.from(envelope.tag,'base64'));
  try {
    const clear = Buffer.concat([cipher.update(Buffer.from(envelope.ciphertext,'base64')),cipher.final()]);
    try { return createPrivateKey({key:clear,type:'pkcs8',format:'der'}); } finally { clear.fill(0); }
  } finally { key.fill(0); }
}
export function validateChallenge(text, origin, email, now = Date.now()) {
  if (typeof text!=='string' || text.length>2000) throw new Error('Invalid challenge.');
  let value; try { value = JSON.parse(text); } catch { throw new Error('Challenge file is not valid JSON. Download a new challenge.'); }
  if (!value || typeof value!=='object') throw new Error('Invalid challenge.');
  if (Object.keys(value).sort().join(',')!=='algorithm,email,expires,id,nonce,origin,protocol,purpose' ||
      value.protocol!=='KavaRoutes admin authentication v1' || value.algorithm!=='ML-DSA-65' ||
      !['enroll','login'].includes(value.purpose) || !Number.isSafeInteger(value.expires) ||
      !/^[a-f0-9-]{36}$/.test(value.id) || !/^[A-Za-z0-9_-]{43}$/.test(value.nonce)) throw new Error('Invalid challenge.');
  if (value.origin!==origin) throw new Error('Challenge origin does not match. Use a challenge from the intended admin site.');
  if (value.email!==email) throw new Error('Challenge email differs from --email. Use the same account in the browser and signer.');
  if (value.expires<=now) throw new Error('Challenge expired. Download a fresh challenge; new challenges allow ten minutes.');
  if (value.expires>now+600_000) throw new Error('Challenge expiry exceeds ten minutes. Check your computer clock.');
  return value;
}
export function signedResponse(privateKey, challenge) {
  if (privateKey.asymmetricKeyType!=='ml-dsa-65') throw new Error('ML-DSA-65 key required.');
  return {challenge,publicKey:createPublicKey(privateKey).export({type:'spki',format:'pem'}),signature:sign(null,Buffer.from(challenge),privateKey).toString('base64url')};
}
async function hidden(prompt) {
  if (!process.stdin.isTTY) throw new Error('Run interactively in a terminal to enter your passphrase.');
  process.stdout.write(prompt); process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
  return new Promise((resolveInput,reject) => {
    let input='';
    const finish = (error) => { process.stdin.off('data',onData); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n'); error?reject(error):resolveInput(input); };
    const onData = chunk => { for (const char of chunk) {
      if (char==='\u0003') return finish(new Error('Cancelled.'));
      if (char==='\r' || char==='\n') return finish();
      if (char==='\u007f' || char==='\b') input=input.slice(0,-1);
      else if (char>=' ') input+=char;
    }};
    process.stdin.on('data',onData);
  });
}
async function main() {
  process.umask(0o077);
  const [command,...args] = process.argv.slice(2), options={};
  for (let i=0;i<args.length;i+=2) {
    if (!['--key','--challenge','--output','--origin','--email'].includes(args[i]) || !args[i+1]) throw new Error('Invalid option.');
    options[args[i]]=args[i+1];
  }
  const path = resolve(options['--key'] ?? `${homedir()}/.kavaroutes-admin/signing-key.json`);
  if (command==='keygen') {
    const password=await hidden('New key passphrase (16+ characters; hidden): ');
    if (password!==await hidden('Repeat passphrase: ')) throw new Error('Passphrases differ.');
    const {privateKey,publicKey}=generateKeyPairSync('ml-dsa-65');
    const envelope=protectPrivateKey(privateKey,password);
    mkdirSync(dirname(path),{recursive:true,mode:0o700});
    writeFileSync(path,JSON.stringify(envelope),{flag:'wx',mode:0o600});
    writeFileSync(`${path}.public.pem`,publicKey.export({type:'spki',format:'pem'}),{flag:'wx',mode:0o600});
    console.log(`Encrypted private key saved: ${path}\nBack up this file securely and keep your passphrase separately. Never upload the private key.`);
    return;
  }
  if (command==='sign') {
    if (!options['--challenge'] || !options['--email']) throw new Error('--challenge and --email are required.');
    const origin=options['--origin'] ?? 'https://admin.kavaroutes.com';
    if (origin!=='https://admin.kavaroutes.com' && !/^http:\/\/127\.0\.0\.1:\d{4,5}$/.test(origin)) throw new Error('Unrecognized admin origin.');
    if (/[\r\n]/.test(options['--challenge'])) throw new Error('The challenge path contains a line break. Keep the entire quoted path on one line.');
    const challenge=readFileSync(options['--challenge'],'utf8');
    const parsed=validateChallenge(challenge,origin,options['--email'].toLowerCase());
    const prompt=createInterface({input:process.stdin,output:process.stdout});
    const answer=await prompt.question(`Sign ${parsed.purpose} for ${parsed.email} at ${parsed.origin}? Type SIGN: `); prompt.close();
    if (answer!=='SIGN') throw new Error('Cancelled.');
    const envelope=JSON.parse(readFileSync(path,'utf8'));
    const passphrase=await hidden('Key passphrase (hidden): ');
    let privateKey;
    try { privateKey=unlockPrivateKey(envelope,passphrase); } catch { throw new Error('Could not unlock the private key. Check your passphrase and key file.'); }
    validateChallenge(challenge,origin,options['--email'].toLowerCase());
    const output=resolve(options['--output'] ?? 'admin-response.json');
    writeFileSync(output,JSON.stringify(signedResponse(privateKey,challenge)),{flag:'wx',mode:0o600});
    console.log(`Signed response saved: ${output}\nSelect this response file in the admin login page. It expires with the challenge.`);
    return;
  }
  console.log('Node.js 24.19+ required.\n  node signer.mjs keygen [--key PATH]\n  node signer.mjs sign --challenge PATH --email EMAIL [--origin http://127.0.0.1:58100] [--key PATH] [--output PATH]');
}
if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) main().catch(error => {
  const known={ENOENT:'File not found. Check the challenge path and private-key location.',EEXIST:'Output file already exists. Choose a new --output filename.',EACCES:'Permission denied. Check file and folder access.'};
  console.error(`Signer failed: ${known[error.code] ?? (error.constructor===Error && !error.code ? error.message : 'Invalid file or unsupported runtime. Use Node.js 24.19 or later in the 24.x series.')}`); process.exitCode=1;
});
