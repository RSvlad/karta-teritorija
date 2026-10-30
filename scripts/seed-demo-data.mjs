// Dev/preview convenience: if the pipeline has not produced public/data yet,
// copy the fictional demo fixture so the app has something to load.
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';

const target = 'public/data/novi-sad.json';
if (!existsSync(target)) {
  mkdirSync('public/data', { recursive: true });
  copyFileSync('fixtures/demo-novi-sad.json', target);
  console.log('seeded demo data →', target);
}
