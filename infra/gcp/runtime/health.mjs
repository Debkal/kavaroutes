// No credentials, response bodies, paths, or errors enter health output.
const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1024 || port > 65535) process.exit(1);
try {
  const response = await fetch(`http://127.0.0.1:${port}/health/ready`, { signal: AbortSignal.timeout(4000), redirect: 'error' });
  process.exit(response.status === 200 && (await response.json()).status === 'ready' ? 0 : 1);
} catch { process.exit(1); }
