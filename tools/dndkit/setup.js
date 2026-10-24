#!/usr/bin/env node
/* One-off setup for tools/test-dndkit.js: installs React and the REAL @dnd-kit/core
   into <project>/.tmp/dndkit and bundles tools/dndkit/app.jsx for the test page.

   Everything lands under .tmp, the npm cache and temp folder too, so nothing is
   written outside the project. Install scripts are switched off (esbuild's binary arrives
   through its platform package, so it doesn't need one). Nothing here ships with the
   extension, and nothing in the extension depends on it. */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const scratch = require('../scratch.js');

const DIR = path.join(scratch.dir, 'dndkit');
const CACHE = path.join(scratch.dir, 'npm-cache');
const TMP = path.join(scratch.dir, 't');
for (const d of [DIR, CACHE, TMP]) fs.mkdirSync(d, { recursive: true });

// (MathLive too, the math-answer field the live site uses: tools/dndkit/math.jsx and tools/test-math.js.)
if (!fs.existsSync(path.join(DIR, 'node_modules', '@dnd-kit', 'sortable')) || !fs.existsSync(path.join(DIR, 'node_modules', 'mathlive'))) {
  if (!fs.existsSync(path.join(DIR, 'package.json'))) fs.writeFileSync(path.join(DIR, 'package.json'), JSON.stringify({ name: 'dndkit-test', private: true }, null, 2));
  execSync('npm install --ignore-scripts --no-audit --no-fund --loglevel=error react@18.3.1 react-dom@18.3.1 @dnd-kit/core@6.3.1 @dnd-kit/sortable@8.0.0 mathlive@0.101.0 esbuild@0.25.5', {
    cwd: DIR, stdio: 'inherit',
    env: { ...process.env, NPM_CONFIG_CACHE: CACHE, TEMP: TMP, TMP },
  });
}

const esbuild = require(path.join(DIR, 'node_modules', 'esbuild'));
for (const name of ['app', 'sort', 'math']) {         // the drag-and-drop page, the ordering page, the math-answer page
  esbuild.buildSync({
    entryPoints: [path.join(__dirname, `${name}.jsx`)],
    outfile: path.join(DIR, `${name}.js`),
    bundle: true,
    format: 'iife',
    loader: { '.jsx': 'jsx' },
    nodePaths: [path.join(DIR, 'node_modules')],
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'warning',
  });
  console.log('built', path.join(DIR, `${name}.js`));
}
