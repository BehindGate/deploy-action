'use strict';

/**
 * Minimal ZIP central-directory reader.
 *
 * Written by hand rather than pulled from npm so the integration test has no
 * dependencies, and parsed from the central directory rather than by scanning
 * for local-header signatures (compressed payloads can contain those bytes).
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;

function findEndOfCentralDirectory(buffer) {
  // The EOCD record is 22 bytes plus an optional trailing comment (max 65535).
  const earliest = Math.max(0, buffer.length - (22 + 0xffff));
  for (let i = buffer.length - 22; i >= earliest; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  throw new Error('Not a ZIP archive: no end-of-central-directory record found');
}

/**
 * List the entry names in a ZIP archive.
 *
 * @param {Buffer} buffer
 * @returns {string[]} names exactly as stored (forward slashes, no leading "./")
 */
function listZipEntries(buffer) {
  const eocd = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  const names = [];
  for (let i = 0; i < entryCount; i++) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new Error(`Corrupt ZIP: bad central directory header at ${offset}`);
    }
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);

    names.push(buffer.toString('utf8', offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return names;
}

module.exports = { listZipEntries };
