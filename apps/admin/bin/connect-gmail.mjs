// Run on your own computer. Writes a private configuration file; never prints tokens.
import {createServer} from 'node:http';
import {readFile,writeFile} from 'node:fs/promises';
import {randomBytes,createHash} from 'node:crypto';
import {resolve} from 'node:path';
process.umask(0o077);
const args=process.argv.slice(2),arg=name=>{const i=args.indexOf(name);return i>=0?args[i+1]:undefined;};
let server;
try{
 const credentials=arg('--credentials'),output=arg('--output'),from=arg('--from');
 if(!credentials||!output||!from||!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(from))throw Error('Usage: node apps/admin/bin/connect-gmail.mjs --credentials PATH_TO_DESKTOP_CLIENT.json --from kavasupport@kavaroutes.com --output PRIVATE_OUTPUT.json');
 const client=JSON.parse(await readFile(credentials,'utf8')).installed;if(!client?.client_id||!client?.client_secret)throw Error('Use a Google OAuth Desktop app client JSON file.');
 const state=randomBytes(32).toString('base64url'),verifier=randomBytes(32).toString('base64url'),challenge=createHash('sha256').update(verifier).digest('base64url');
 let finish,reject;const received=new Promise((ok,no)=>{finish=ok;reject=no;});
 server=createServer((req,res)=>{const url=new URL(req.url,'http://127.0.0.1');res.setHeader('Content-Type','text/plain');res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');if(url.pathname!=='/oauth/callback'||url.searchParams.get('state')!==state){res.writeHead(400);res.end('Invalid callback.');return;}if(url.searchParams.get('error')||!url.searchParams.get('code')){res.end('Authorization was not completed. Return to the terminal.');reject(Error('Gmail authorization declined.'));return;}res.end('Authorization received. Return to the terminal.');finish(url.searchParams.get('code'));});
 await new Promise(ok=>server.listen(0,'127.0.0.1',ok));const redirect=`http://127.0.0.1:${server.address().port}/oauth/callback`;
 const params=new URLSearchParams({client_id:client.client_id,redirect_uri:redirect,response_type:'code',scope:'https://www.googleapis.com/auth/gmail.send',access_type:'offline',prompt:'consent',state,code_challenge:challenge,code_challenge_method:'S256'});
 console.log('Open this URL on this computer and choose the Gmail mailbox that owns the verified Send mail as alias:');console.log('https://accounts.google.com/o/oauth2/v2/auth?'+params);
 const timer=setTimeout(()=>reject(Error('Authorization timed out. Run again.')),10*60*1000);let code;try{code=await received;}finally{clearTimeout(timer);server.close();}
 const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:client.client_id,client_secret:client.client_secret,code,code_verifier:verifier,grant_type:'authorization_code',redirect_uri:redirect})});
 if(!response.ok)throw Error('Google token exchange failed. Check the OAuth client and retry.');const token=await response.json();if(!token.refresh_token||!token.scope?.split(' ').includes('https://www.googleapis.com/auth/gmail.send'))throw Error('Google did not grant persistent Gmail sending access.');
 await writeFile(resolve(output),JSON.stringify({provider:'gmail',enabled:false,from,clientId:client.client_id,clientSecret:client.client_secret,refreshToken:token.refresh_token},null,2)+'\n',{flag:'wx',mode:0o600});
 console.log('Private Gmail configuration saved. Sending is disabled. Keep this file private and install it on the VM; do not paste it into chat.');
}catch(e){console.error(e.code==='EEXIST'?'Output already exists; choose a new filename.':e.message);process.exitCode=1;}finally{server?.close();}
