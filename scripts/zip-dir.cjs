'use strict';

// Zip a folder's contents, shared by both adapters' build pipelines.
//
// CommonJS on purpose: the Cocos side runs inside Cocos Creator's bundled Node 20, which cannot
// `require` an ESM module. Vite's config is ESM and imports the default export from here.
//
// The OS's own zip, so this stays dependency-free. Entry names are passed explicitly rather than
// `.` or a wildcard, and neither obvious invocation is correct out of the box:
//   - `tar -C dir .`                  prefixes every entry with `./`
//   - `Compress-Archive -Path dir\*`  nests entries under the folder name AND writes backslash
//                                     separators, which is outside the zip spec
// Every zip-taking ad network wants index.html at the archive root, so entries have to be clean.

const { execFileSync } = require('child_process');
const { existsSync, readdirSync, unlinkSync } = require('fs');

/**
 * @param {string} dir   folder whose CONTENTS become the archive root
 * @param {string} dest  the .zip to write (replaced if it exists)
 */
function zipDir(dir, dest) {
    if (existsSync(dest)) unlinkSync(dest);
    const entries = readdirSync(dir);
    if (entries.length === 0) throw new Error(`zipDir: nothing to zip in ${dir}`);

    // ponytail: two branches because Creator ships on Windows and macOS; add another if that changes.
    if (process.platform === 'win32') {
        // The full path, not `tar`: git's GNU tar is often first on PATH and reads `D:\...` as a
        // remote host ("Cannot connect to C: resolve failed").
        execFileSync('C:/Windows/System32/tar.exe', ['-a', '-c', '-f', dest, '-C', dir, ...entries]);
    } else {
        execFileSync('zip', ['-qr', dest, ...entries], { cwd: dir });
    }
}

module.exports = { zipDir };
