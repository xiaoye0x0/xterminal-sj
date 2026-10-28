#!/usr/bin/env node
/*
 * XTerminal 5.8.6 local VIP gate patch (manual verification helper)
 *
 * This script is intentionally NOT executed automatically. It patches a copy
 * of resources/app.asar that you explicitly pass with --asar.
 *
 * Usage:
 *   node xterminal-local-vip-patch.js --asar "C:\path\XTerminal\resources\app.asar"
 *   node xterminal-local-vip-patch.js --asar "..." --check
 *   node xterminal-local-vip-patch.js --asar "..." --restore
 *
 * If Node.js is not installed, Electron can run this script as Node:
 *   set ELECTRON_RUN_AS_NODE=1
 *   "C:\path\XTerminal\XTerminal.exe" xterminal-local-vip-patch.js --asar "..."
 */

'use strict';

// When this script is launched with ELECTRON_RUN_AS_NODE=1, Electron patches
// fs so that paths ending in .asar are treated as archive directories. We need
// to read/write the raw app.asar file itself, so bypass that layer.
process.noAsar = true;

let fs;
try {
  // Electron exposes original-fs; normal Node.js does not.
  fs = require('original-fs');
} catch {
  fs = require('fs');
}

const crypto = require('crypto');
const path = require('path');

const KEY = Buffer.from('xEhs4DzKYH3KZ2GFNdaTyDycHchh8jQw', 'utf8');
const IV = Buffer.from('wQj8hhcHcyDyTadN', 'utf8');
const BUNDLE = 'dist/render/assets/feature-session-ssh-aw8dbiM4.js';
const OLD = 'return!la.memberEnd||!la.userId||la.userId!==this.userInfo?.id?!1:pr(la.memberEnd).isAfter(pr())';
const NEW = 'return!0' + ' '.repeat(OLD.length - 'return!0'.length);

function usage() {
  console.log('Usage:');
  console.log('  node xterminal-local-vip-patch.js --asar <app.asar>');
  console.log('  node xterminal-local-vip-patch.js --asar <app.asar> --check');
  console.log('  node xterminal-local-vip-patch.js --asar <app.asar> --restore');
}

function parseArgs(argv) {
  const out = { asar: '', check: false, restore: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--asar') out.asar = argv[++i] || '';
    else if (a === '--check') out.check = true;
    else if (a === '--restore') out.restore = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error('unknown argument: ' + a);
  }
  return out;
}

function parseAsar(buf) {
  if (buf.length < 16) throw new Error('file is too small to be an asar archive');
  const headerSize = buf.readUInt32LE(12);
  const dataStart = 16 + headerSize;
  if (dataStart > buf.length) throw new Error('invalid asar header size');
  const header = JSON.parse(buf.subarray(16, dataStart).toString('utf8'));
  return { header, dataStart };
}

function getEntry(header, filePath) {
  let cur = header;
  for (const part of filePath.split('/')) {
    if (cur.files) cur = cur.files;
    cur = cur[part];
    if (!cur) return null;
  }
  return cur;
}

function decrypt(ciphertext) {
  const d = crypto.createDecipheriv('aes-256-cbc', KEY, IV);
  return Buffer.concat([d.update(ciphertext), d.final()]);
}

function encrypt(plaintext) {
  const c = crypto.createCipheriv('aes-256-cbc', KEY, IV);
  return Buffer.concat([c.update(plaintext), c.final()]);
}

function inspect(asarPath) {
  const buf = fs.readFileSync(asarPath);
  const { header, dataStart } = parseAsar(buf);
  const entry = getEntry(header, BUNDLE);
  if (!entry) throw new Error('bundle not found: ' + BUNDLE);
  if (entry.unpacked) throw new Error('bundle is marked unpacked; this helper expects packed app.asar data');
  const start = dataStart + Number(entry.offset);
  const ciphertext = buf.subarray(start, start + Number(entry.size));
  if (ciphertext.length !== Number(entry.size)) throw new Error('truncated asar entry');
  const plaintext = decrypt(ciphertext);
  const text = plaintext.toString('utf8');
  const patched = text.includes('isVip(){return!0');
  return {
    buf,
    entry,
    start,
    ciphertext,
    plaintext,
    text,
    patched,
    oldCount: text.split(OLD).length - 1,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.asar) {
    usage();
    process.exit(args.help ? 0 : 2);
  }

  const asar = path.resolve(args.asar);
  if (!fs.existsSync(asar)) throw new Error('app.asar not found: ' + asar);
  const backup = asar + '.bak-vip-test';

  if (args.restore) {
    if (!fs.existsSync(backup)) throw new Error('backup not found: ' + backup);
    fs.copyFileSync(backup, asar);
    console.log('[+] restored:', asar);
    console.log('[+] backup kept:', backup);
    return;
  }

  const state = inspect(asar);
  console.log('[*] asar      :', asar);
  console.log('[*] bundle    :', BUNDLE);
  console.log('[*] size      :', state.entry.size);
  console.log('[*] offset    :', state.entry.offset);
  console.log('[*] isVip patch present:', state.patched);
  console.log('[*] old body occurrences:', state.oldCount);

  if (args.check) {
    process.exit(state.patched ? 0 : 1);
  }

  if (state.patched) {
    console.log('[=] already patched; nothing to do');
    return;
  }
  if (state.oldCount !== 1) {
    throw new Error('unexpected isVip body count: ' + state.oldCount + ' (aborting)');
  }

  if (!fs.existsSync(backup)) {
    fs.copyFileSync(asar, backup);
    console.log('[+] backup created:', backup);
  } else {
    console.log('[=] backup already exists:', backup);
  }

  const oldBuffer = Buffer.from(OLD, 'utf8');
  const newBuffer = Buffer.from(NEW, 'utf8');
  if (newBuffer.length !== oldBuffer.length) throw new Error('patch length mismatch');

  const idx = state.plaintext.indexOf(oldBuffer);
  if (idx < 0) throw new Error('old isVip body not found');
  const patchedPlain = Buffer.concat([
    state.plaintext.subarray(0, idx),
    newBuffer,
    state.plaintext.subarray(idx + oldBuffer.length),
  ]);
  const patchedCipher = encrypt(patchedPlain);
  if (patchedCipher.length !== Number(state.entry.size)) {
    throw new Error('encrypted size changed: ' + patchedCipher.length + ' != ' + state.entry.size);
  }

  const out = Buffer.from(state.buf);
  patchedCipher.copy(out, state.start);
  fs.writeFileSync(asar, out);

  const verify = inspect(asar);
  if (!verify.patched) throw new Error('verification failed after write');
  console.log('[+] patched isVip -> return!0');
  console.log('[+] backup:', backup);
  console.log('[+] restore with: node xterminal-local-vip-patch.js --asar "' + asar + '" --restore');
}

try {
  main();
} catch (e) {
  console.error('[-] ' + (e && e.message ? e.message : e));
  process.exit(2);
}
