// Rebuilds public/models/airlock.glb from ../scifi_airlock.py through Blender.
// Uses the BLENDER environment variable if set, otherwise `blender` on PATH.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const blender = process.env.BLENDER || 'blender';
const result = spawnSync(blender, ['-b', '--factory-startup', '--python', join(repo, 'export_glb.py')], {
  stdio: 'inherit',
});
if (result.error) {
  console.error(`Could not start Blender (${blender}): ${result.error.message}`);
  console.error('Set the BLENDER environment variable to the full path of blender.exe.');
  process.exit(1);
}
process.exit(result.status ?? 1);
