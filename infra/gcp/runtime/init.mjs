import { readConfig, readSecretJson } from './config.mjs';
import { initializeDatabase } from './database.mjs';

try {
  const [configPath, passwordsPath] = process.argv.slice(2);
  const config = await readConfig(configPath, 'admin');
  const passwords = await readSecretJson(passwordsPath);
  if (!passwords || Object.keys(passwords).sort().join(',') !== 'kr_cloud_api,kr_cloud_worker') throw new Error('SECRET_SCHEMA_INVALID');
  await initializeDatabase(config, passwords);
  process.stdout.write('RUNTIME_DATABASE_INITIALIZED_SYNTHETIC\n');
} catch {
  process.stderr.write('RUNTIME_DATABASE_INIT_FAILED\n');
  process.exitCode = 1;
}
