// Install a private Gmail configuration into an existing admin config.
import {readFile,writeFile,rename,unlink} from 'node:fs/promises';
import {readConfig} from '../src/config.mjs';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
process.umask(0o077);
const args=process.argv.slice(2),arg=name=>{const i=args.indexOf(name);return i>=0?args[i+1]:undefined;};
let temporary;
try{
 const path=arg('--config'),emailFile=arg('--email-file');
 if(!path||(!emailFile&&!args.includes('--enable')&&!args.includes('--disable')))throw Error('Usage: configure-email.mjs --config CONFIG_PATH [--email-file PRIVATE_GMAIL_JSON] [--enable | --disable]');
 if(args.includes('--enable')&&args.includes('--disable'))throw Error('Choose enable or disable.');
 readConfig(path);const config=JSON.parse(await readFile(path,'utf8'));
 if(emailFile){config.email=JSON.parse(await readFile(emailFile,'utf8'));config.email.enabled=false;}
 if(!config.email)throw Error('Install the Gmail configuration first.');
 if(args.includes('--enable'))config.email.enabled=true;
 if(args.includes('--disable'))config.email.enabled=false;
 temporary=resolve(path)+'.'+randomUUID()+'.tmp';await writeFile(temporary,JSON.stringify(config,null,2)+'\n',{mode:0o600,flag:'wx'});readConfig(temporary);await rename(temporary,path);temporary=undefined;
 console.log(`Email configuration saved; automatic sending is ${config.email.enabled?'enabled':'paused'}. Restart the admin service to apply.`);
}catch(e){console.error(['EACCES','ENOENT'].includes(e.code)?'Cannot access the specified private configuration file.':e.message);process.exitCode=1;}finally{if(temporary)await unlink(temporary).catch(()=>{});}
