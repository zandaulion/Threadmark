// Migrates a single server.env (used by older deployments for every container)
// into per-container files. The original is left in place for you to delete
// once the new deployment is running.
import fs from 'node:fs';
import path from 'node:path';
import { configDir, ENV_LAYOUT, parseEnv, writeEnvFiles } from './env-layout.mjs';

const directory = configDir();
const source = process.argv[2] || path.join(directory, 'server.env');
if (!fs.existsSync(source)) {
  console.error(`${source} does not exist.`);
  process.exit(2);
}
const values = parseEnv(fs.readFileSync(source, 'utf8'));
const known = new Set(Object.values(ENV_LAYOUT).flat());
const unknown = Object.keys(values).filter((key) => !known.has(key));
if (unknown.length) {
  console.error(`Unrecognised settings in ${source}: ${unknown.join(', ')}. Add them to scripts/env-layout.mjs first.`);
  process.exit(2);
}
try {
  const created = writeEnvFiles(directory, values);
  console.log(`Created ${created.join(', ')} with mode 0600. Delete ${source} after verifying the deployment.`);
} catch (error) {
  console.error(error.message);
  process.exit(2);
}
