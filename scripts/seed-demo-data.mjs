// Dev/preview convenience: if the pipeline has not produced public/data yet,
// copy the fictional demo fixtures so the app has something to load.
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';

const seeds = [
  ['fixtures/demo-cities.json', 'public/data/cities.json'],
  ['fixtures/demo-novi-sad.json', 'public/data/novi-sad.json'],
];

for (const [source, target] of seeds) {
  if (existsSync(target)) continue;
  mkdirSync('public/data', { recursive: true });
  copyFileSync(source, target);
  console.log('seeded demo data →', target);
}
