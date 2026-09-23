import { startMailWorker } from './customer-mail.mjs';
import { readConfig } from './config.mjs';
import { openStore } from './store.mjs';
import { createAdminServer } from './server.mjs';
import { adminStatus } from './logging.mjs';

process.umask(0o077);
const config = readConfig(process.argv[2]);
const store = openStore(config.database);
if (!store.get("SELECT email FROM admins WHERE role='OWNER'")) throw new Error('RUN_OPERATOR_INIT_FIRST');
const server = createAdminServer({config,store});
server.requestTimeout = 15_000; server.headersTimeout = 10_000;
server.keepAliveTimeout = 5000; server.maxHeadersCount = 40;
await new Promise((resolve,reject) => { server.once('error',reject); server.listen(config.port,'127.0.0.1',resolve); });
const stopMailWorker = startMailWorker(store, config);
adminStatus('ADMIN_READY');
for (const signal of ['SIGINT','SIGTERM']) process.once(signal,() => server.close(async () => { await stopMailWorker(); store.close(); process.exit(0); }));
