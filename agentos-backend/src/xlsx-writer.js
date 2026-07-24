// xlsx-writer.js — builds a REAL, valid .xlsx file with zero dependencies.
// XLSX is just a ZIP archive of XML parts (OOXML SpreadsheetML). We build the
// ZIP by hand (STORED / uncompressed entries, so no deflate correctness risk)
// and write minimal-but-valid workbook/worksheet/styles XML.
//
// Validated by opening generated files with Python's openpyxl during testing.

const zlib = require('node:zlib');

// ---- CRC32 (standard IEEE 802.3 polynomial) ----
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function xmlEscape(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;' }[c]));
}
function colLetter(idx) {
  let s = '';
  idx += 1;
  while (idx > 0) { const r = (idx - 1) % 26; s = String.fromCharCode(65 + r) + s; idx = Math.floor((idx - 1) / 26); }
  return s;
}

// ---- minimal ZIP writer (STORED method — no compression, always correct) ----
function buildZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const size = data.length;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);   // version needed
    localHeader.writeUInt16LE(0, 6);    // flags
    localHeader.writeUInt16LE(0, 8);    // method: stored
    localHeader.writeUInt16LE(0, 10);   // mod time
    localHeader.writeUInt16LE(0, 12);   // mod date
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(size, 18);
    localHeader.writeUInt32LE(size, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuf, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);  // version made by
    centralHeader.writeUInt16LE(20, 6);  // version needed
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(size, 20);
    centralHeader.writeUInt32LE(size, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + data.length;
  }

  const centralDirStart = offset;
  const centralDir = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(centralDirStart, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDir, end]);
}

/**
 * Build a real .xlsx workbook.
 * @param {string} sheetName
 * @param {string[]} headers
 * @param {Array<Array<string|number|null>>} rows
 * @returns {Buffer}
 */
function buildXlsx(sheetName, headers, rows) {
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${xmlEscape(sheetName || 'Sheet1')}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf/></cellStyleXfs>
<cellXfs count="2"><xf fontId="0"/><xf fontId="1"/></cellXfs>
</styleSheet>`;

  const allRows = [headers, ...rows];
  let rowsXml = '';
  allRows.forEach((rowVals, rIdx) => {
    const rowNum = rIdx + 1;
    const isHeader = rIdx === 0;
    let cellsXml = '';
    rowVals.forEach((val, cIdx) => {
      const ref = colLetter(cIdx) + rowNum;
      const styleAttr = isHeader ? ' s="1"' : '';
      if (typeof val === 'number' && isFinite(val)) {
        cellsXml += `<c r="${ref}"${styleAttr}><v>${val}</v></c>`;
      } else {
        cellsXml += `<c r="${ref}" t="inlineStr"${styleAttr}><is><t xml:space="preserve">${xmlEscape(val)}</t></is></c>`;
      }
    });
    rowsXml += `<row r="${rowNum}">${cellsXml}</row>`;
  });

  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>${rowsXml}</sheetData>
</worksheet>`;

  const files = [
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rootRels, 'utf8') },
    { name: 'xl/workbook.xml', data: Buffer.from(workbook, 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(workbookRels, 'utf8') },
    { name: 'xl/styles.xml', data: Buffer.from(styles, 'utf8') },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheet, 'utf8') }
  ];
  return buildZip(files);
}

module.exports = { buildXlsx };
