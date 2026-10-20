// Adds a content fingerprint to the page's own files in index.html, e.g.
//   <script src="app.js?v=3f9a2c1d">
// GitHub Pages lets browsers cache each file for 10 minutes. Without this,
// a browser can combine a new index.html with an old app.js after an update.
// Run after changing app.js, lib.js, theme.js or the styles:  npm run build
// Use --check to only verify (CI fails when index.html is out of date).
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const ASSETS = ['app.js', 'lib.js', 'theme.js', 'tailwind.css'];
const check = process.argv.includes('--check');

const html = readFileSync('index.html', 'utf8');
let out = html;
for (const file of ASSETS) {
    // Normalize line endings so Windows (CRLF) and CI (LF) get the same fingerprint
    const content = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    const hash = createHash('sha256').update(content).digest('hex').slice(0, 10);
    const re = new RegExp(`((?:src|href)=")${file.replace('.', '\\.')}(?:\\?v=[0-9a-f]+)?(")`, 'g');
    if (!re.test(out)) throw new Error(`index.html does not reference ${file}`);
    out = out.replace(re, `$1${file}?v=${hash}$2`);
}

if (check) {
    if (out !== html) {
        console.error('index.html fingerprints are out of date. Run: npm run build');
        process.exit(1);
    }
    console.log('index.html fingerprints are up to date.');
} else if (out !== html) {
    writeFileSync('index.html', out);
    console.log('Updated fingerprints in index.html');
} else {
    console.log('Fingerprints already up to date.');
}
