// Explicit live compatibility probe; synthetic data only. Not part of tests/build.
import { loadEnv } from 'vite';
import { randomBytes, randomInt } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';

const markers = [randomBytes(8).toString('hex'), randomBytes(8).toString('hex')];
const amounts = [randomInt(10000, 99000), randomInt(10000, 99000)];
const lines = markers.map((marker, i) => [`Synthetic file test page ${i + 1}`, `Verification code: ${marker}`, `Settlement amount: ${amounts[i]} CNY.`, 'Payment occurs after handover; no deadline is specified.']);

function pdf() {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>'];
  for (let i = 0; i < 2; i++) {
    const stream = `BT /F1 16 Tf 50 750 Td ${lines[i].map((line, j) => `${j ? '0 -30 Td ' : ''}(${line}) Tj`).join('\n')} ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents ${4 + i * 2} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let out = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((obj, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${obj}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out);
}
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function docx() {
  const entries = {
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${lines.map((page, i) => `${i ? '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' : ''}${page.map(line => `<w:p><w:r><w:t>${line}</w:t></w:r></w:p>`).join('')}`).join('')}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>`
  };
  const local = [], central = []; let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const filename = Buffer.from(name), raw = Buffer.from(value), zipped = deflateRawSync(raw), crc = crc32(raw);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(8, 8);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(zipped.length, 18); header.writeUInt32LE(raw.length, 22); header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, zipped);
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(zipped.length, 20); cd.writeUInt32LE(raw.length, 24); cd.writeUInt16LE(filename.length, 28); cd.writeUInt32LE(offset, 42);
    central.push(cd, filename); offset += header.length + filename.length + zipped.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(3, 8); end.writeUInt16LE(3, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
const files = [
  { name: 'synthetic.pdf', mime: 'application/pdf', bytes: pdf() },
  { name: 'synthetic.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: docx() }
];
const directory = 'work/file-input-smoke';
await mkdir(directory, { recursive: true });
for (const file of files) await writeFile(`${directory}/${file.name}`, file.bytes);
if (!process.argv.includes('--call')) {
  console.log('Generated synthetic PDF and DOCX. No API calls made.');
} else {
  const env = loadEnv('development', process.cwd(), '');
  const base = env.AI_BASE_URL?.replace(/\/+$/, '');
  if (!base || new URL(base).hostname !== 'api.tu-zi.com' || !env.AI_API_KEY || !env.AI_MODEL) throw Error('Tuzi configuration incomplete');
  const prompt = 'Read only the attached file. Return JSON with codes (all verification codes in document order) and amounts (all settlement amounts as numbers in document order). If you cannot read the file, say so. Do not guess.';
  const results = [];
  for (const endpoint of ['chat/completions', 'responses']) {
    const batch = await Promise.all(files.map(async file => {
      const data = `data:${file.mime};base64,${file.bytes.toString('base64')}`;
      const body = endpoint === 'chat/completions'
        ? { model: env.AI_MODEL, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'file', file: { filename: file.name, file_data: data } }] }], response_format: { type: 'json_object' } }
        : { model: env.AI_MODEL, input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }, { type: 'input_file', filename: file.name, file_data: data }] }], store: false };
      const start = Date.now();
      try {
        const response = await fetch(`${base}/${endpoint}`, { method: 'POST', headers: { Authorization: `Bearer ${env.AI_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(55_000) });
        const raw = await response.text();
        let parsed; try { parsed = JSON.parse(raw); } catch { parsed = {}; }
        const content = endpoint === 'chat/completions' ? parsed.choices?.[0]?.message?.content ?? '' : (parsed.output ?? []).flatMap(item => item.content ?? []).map(item => item.text ?? '').join('\n');
        let error = String(parsed.error?.message ?? '').replaceAll(env.AI_API_KEY, '[REDACTED]').replace(/data:[^\s"']+/g, '[FILE]').replace(/[A-Za-z0-9+/=_-]{60,}/g, '[REDACTED]').slice(0, 320);
        return { endpoint, file: file.name, status: response.status, seconds: Math.round((Date.now() - start) / 100) / 10, readBothCodes: markers.every(code => content.includes(code)), readBothAmounts: amounts.every(amount => content.includes(String(amount))), answer: content.slice(0, 1000), error };
      } catch (error) { return { endpoint, file: file.name, status: 0, error: error.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK_ERROR' }; }
    }));
    results.push(...batch); batch.forEach(result => console.log(JSON.stringify(result)));
  }
  await writeFile(`${directory}/results.json`, JSON.stringify({ model: env.AI_MODEL, results }, null, 2));
}
