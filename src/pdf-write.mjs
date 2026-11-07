import { Buffer } from 'node:buffer';

export function createPdf() {
  const chunks = [];
  const offsets = [0];
  let size = 0;
  function append(value) {
    const bytes = typeof value === 'string' ? Buffer.from(value, 'latin1') : value;
    chunks.push(bytes);
    size += bytes.length;
  }
  append('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  return {
    object(body, stream) {
      const id = offsets.length;
      offsets.push(size);
      append(id + ' 0 obj\n');
      if (stream) {
        append('<< ' + body + ' /Length ' + stream.length + ' >>\nstream\n');
        append(stream);
        append('\nendstream');
      } else append(body);
      append('\nendobj\n');
    },
    finish() {
      const xref = size;
      append(`xref\n0 ${offsets.length}\n0000000000 65535 f \n`);
      for (const offset of offsets.slice(1)) append(String(offset).padStart(10, '0') + ' 00000 n \n');
      append(`trailer\n<< /Root 1 0 R /Size ${offsets.length} >>\nstartxref\n${xref}\n%%EOF\n`);
      return chunks;
    },
  };
}
