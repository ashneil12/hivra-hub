// A small Parquet reader for the memory eval's test file, so the harness needs no new dependency.
//
// It reads the parts the PersonalizationV4 test split uses: thrift compact protocol metadata, data pages
// v1 and v2, snappy or uncompressed column chunks, PLAIN and RLE_DICTIONARY values, RLE/bit-packed levels,
// optional scalars and list<element> columns. Anything else stops with a clear message rather than guessing.
// The file is untrusted input: every length is checked against the bytes that remain.

const MAGIC = "PAR1";

export class ParquetError extends Error {}

function fail(message) {
  throw new ParquetError(message);
}

/** Thrift compact protocol value types. */
const T = {
  STOP: 0,
  TRUE: 1,
  FALSE: 2,
  BYTE: 3,
  I16: 4,
  I32: 5,
  I64: 6,
  DOUBLE: 7,
  BINARY: 8,
  LIST: 9,
  SET: 10,
  MAP: 11,
  STRUCT: 12,
};

/** A cursor over one thrift compact structure, for the footer and the page headers. */
function cursor(buf, start, end) {
  let pos = start;
  return {
    get pos() {
      return pos;
    },
    byte() {
      if (pos >= end) fail("The Parquet metadata ended in the middle of a value.");
      return buf[pos++];
    },
    varint() {
      let value = 0;
      let shift = 0;
      for (;;) {
        const byte = this.byte();
        value += (byte & 0x7f) * 2 ** shift;
        if (!(byte & 0x80)) return value;
        shift += 7;
        if (shift > 63) fail("A number in the Parquet metadata is too long to read.");
      }
    },
    zigzag() {
      const value = this.varint();
      return value % 2 === 0 ? value / 2 : -(value + 1) / 2;
    },
    binary() {
      const length = this.varint();
      if (length < 0 || pos + length > end) fail("A byte string in the Parquet metadata runs past its end.");
      const bytes = buf.subarray(pos, pos + length);
      pos += length;
      return bytes;
    },
    listHeader() {
      const header = this.byte();
      let size = header >> 4;
      const type = header & 0x0f;
      if (size === 15) size = this.varint();
      return { size, type };
    },
  };
}

function readValue(r, type) {
  switch (type) {
    case T.TRUE:
      return true;
    case T.FALSE:
      return false;
    case T.BYTE:
      return r.byte();
    case T.I16:
    case T.I32:
    case T.I64:
      return r.zigzag();
    case T.DOUBLE: {
      const bytes = r.binary();
      if (bytes.length !== 8) fail("A double in the Parquet metadata is not eight bytes.");
      return bytes.readDoubleLE(0);
    }
    case T.BINARY:
      return r.binary();
    case T.LIST:
    case T.SET: {
      const { size, type: itemType } = r.listHeader();
      const out = [];
      for (let index = 0; index < size; index++) out.push(readValue(r, itemType));
      return out;
    }
    case T.MAP: {
      const size = r.varint();
      const out = new Map();
      if (size > 0) {
        const header = r.byte();
        const keyType = header >> 4;
        const valueType = header & 0x0f;
        for (let index = 0; index < size; index++) out.set(readValue(r, keyType), readValue(r, valueType));
      }
      return out;
    }
    case T.STRUCT:
      return readStruct(r);
    default:
      fail(`The Parquet metadata uses a value type this reader does not know (${type}).`);
  }
}

function readStruct(r) {
  const out = {};
  let lastId = 0;
  for (;;) {
    const header = r.byte();
    if (header === T.STOP) return out;
    const type = header & 0x0f;
    let id = header >> 4;
    if (id === 0) id = r.zigzag();
    else id += lastId;
    lastId = id;
    out[id] = readValue(r, type);
  }
}

const text = (bytes) => Buffer.from(bytes).toString("utf8");

/** The file metadata at the end of the file: schema, row groups and their column chunks. */
export function readFileMeta(buf) {
  if (!Buffer.isBuffer(buf)) fail("The Parquet reader needs a Buffer.");
  if (buf.length < 12) fail("That file is too short to be Parquet.");
  if (buf.subarray(0, 4).toString("latin1") !== MAGIC || buf.subarray(buf.length - 4).toString("latin1") !== MAGIC) {
    fail("That file does not start and end with the Parquet magic bytes.");
  }
  const length = buf.readUInt32LE(buf.length - 8);
  const start = buf.length - 8 - length;
  if (length <= 0 || start < 4) fail("The Parquet footer length points outside the file.");
  const meta = readStruct(cursor(buf, start, buf.length - 8));
  const schema = (meta[2] ?? []).map((element) => ({
    type: element[1],
    repetition: element[3],
    name: text(element[4] ?? Buffer.alloc(0)),
    children: element[5],
    convertedType: element[6],
  }));
  if (!schema.length) fail("The Parquet file has no schema.");
  const rowGroups = (meta[4] ?? []).map((group) => ({
    numRows: group[3] ?? 0,
    columns: (group[1] ?? []).map((chunk) => ({ fileOffset: chunk[2] ?? 0, meta: chunk[3] })),
  }));
  return { version: meta[1] ?? 0, numRows: meta[3] ?? 0, schema, rowGroups, createdBy: meta[6] ? text(meta[6]) : undefined };
}

/**
 * Each leaf column by its dotted path: its type, and the definition and repetition levels its values can
 * carry (optional adds one definition level, a repeated step adds both).
 */
export function schemaColumns(meta) {
  const out = new Map();
  const walk = (index, prefix, def, rep) => {
    const element = meta.schema[index];
    const next = [...prefix, element.name];
    const stepDef = def + (element.repetition === 1 || element.repetition === 2 ? 1 : 0);
    const stepRep = rep + (element.repetition === 2 ? 1 : 0);
    let child = index + 1;
    if (element.children) {
      for (let count = 0; count < element.children; count++) child = walk(child, next, stepDef, stepRep);
      return child;
    }
    out.set(next.join("."), {
      path: next,
      type: element.type,
      convertedType: element.convertedType,
      maxDef: stepDef,
      maxRep: stepRep,
    });
    return child;
  };
  const root = meta.schema[0];
  let index = 1;
  for (let count = 0; count < (root.children ?? 0); count++) index = walk(index, [], 0, 0);
  return out;
}

/** Raw snappy, the block format a Parquet column chunk uses. */
export function snappyDecompress(src, expected) {
  if (!Buffer.isBuffer(src)) fail("The snappy reader needs a Buffer.");
  let pos = 0;
  let length = 0;
  let shift = 0;
  for (;;) {
    if (pos >= src.length) fail("A snappy block ended before its length.");
    const byte = src[pos++];
    length += (byte & 0x7f) * 2 ** shift;
    if (!(byte & 0x80)) break;
    shift += 7;
    if (shift > 35) fail("A snappy block's length is too long to read.");
  }
  if (expected !== undefined && length !== expected) {
    fail(`A snappy block says it holds ${length} bytes, but its page says ${expected}.`);
  }
  if (length > 512 * 1024 * 1024) fail("A snappy block claims more than half a gigabyte.");
  const out = Buffer.alloc(length);
  let at = 0;
  while (pos < src.length) {
    const tag = src[pos++];
    const kind = tag & 3;
    if (kind === 0) {
      let size = tag >> 2;
      if (size < 60) size += 1;
      else {
        const bytes = size - 59;
        if (pos + bytes > src.length) fail("A snappy literal is cut short.");
        size = 0;
        for (let index = 0; index < bytes; index++) size += src[pos + index] * 2 ** (8 * index);
        size += 1;
        pos += bytes;
      }
      if (pos + size > src.length || at + size > length) fail("A snappy literal runs past the block.");
      src.copy(out, at, pos, pos + size);
      pos += size;
      at += size;
      continue;
    }
    let size;
    let offset;
    if (kind === 1) {
      if (pos + 1 > src.length) fail("A snappy copy is cut short.");
      size = ((tag >> 2) & 7) + 4;
      offset = ((tag >> 5) << 8) | src[pos];
      pos += 1;
    } else if (kind === 2) {
      if (pos + 2 > src.length) fail("A snappy copy is cut short.");
      size = (tag >> 2) + 1;
      offset = src.readUInt16LE(pos);
      pos += 2;
    } else {
      if (pos + 4 > src.length) fail("A snappy copy is cut short.");
      size = (tag >> 2) + 1;
      offset = src.readUInt32LE(pos);
      pos += 4;
    }
    if (offset <= 0 || offset > at) fail("A snappy copy points before the start of its block.");
    if (at + size > length) fail("A snappy copy runs past the block.");
    // A copy may overlap what it is copying, so it goes one byte at a time.
    for (let index = 0; index < size; index++) {
      out[at + index] = out[at - offset + index];
    }
    at += size;
  }
  if (at !== length) fail("A snappy block is shorter than its length says.");
  return out;
}

/** RLE / bit-packed hybrid, as definition levels, repetition levels and dictionary indices use it. */
export function rleHybrid(buf, start, end, bitWidth, expected) {
  const out = [];
  let pos = start;
  const width = Math.ceil(bitWidth / 8);
  while (pos < end && (expected === undefined || out.length < expected)) {
    let header = 0;
    let shift = 0;
    for (;;) {
      if (pos >= end) fail("A run of levels or indices ended early.");
      const byte = buf[pos++];
      header += (byte & 0x7f) * 2 ** shift;
      if (!(byte & 0x80)) break;
      shift += 7;
      if (shift > 35) fail("A run header is too long to read.");
    }
    if ((header & 1) === 0) {
      const count = header >>> 1;
      if (pos + width > end) fail("A repeated run of levels or indices is cut short.");
      let value = 0;
      for (let index = 0; index < width; index++) value += buf[pos + index] * 2 ** (8 * index);
      pos += width;
      for (let index = 0; index < count; index++) out.push(value);
    } else {
      const count = (header >>> 1) * 8;
      const bytes = Math.ceil((count * bitWidth) / 8);
      if (pos + bytes > end) fail("A bit-packed run of levels or indices is cut short.");
      for (let index = 0; index < count; index++) {
        let value = 0;
        for (let bit = 0; bit < bitWidth; bit++) {
          const at = index * bitWidth + bit;
          if ((buf[pos + (at >> 3)] >> (at & 7)) & 1) value += 2 ** bit;
        }
        out.push(value);
      }
      pos += bytes;
    }
    if (out.length > 200_000_000) fail("A run of levels or indices claims more values than a page can hold.");
  }
  return expected === undefined ? out : out.slice(0, expected);
}

function plainValues(buf, start, end, type, expected) {
  const out = [];
  let pos = start;
  if (type === 0) {
    for (let index = 0; index < expected; index++) {
      const at = pos + (index >> 3);
      if (at >= end) fail("A page of booleans is cut short.");
      out.push(((buf[at] >> (index & 7)) & 1) === 1);
    }
    return out;
  }
  for (let index = 0; index < expected; index++) {
    if (type === 6) {
      if (pos + 4 > end) fail("A page of byte arrays is cut short.");
      const length = buf.readUInt32LE(pos);
      pos += 4;
      if (pos + length > end) fail("A byte array runs past the end of its page.");
      out.push(buf.subarray(pos, pos + length));
      pos += length;
    } else if (type === 1) {
      if (pos + 4 > end) fail("A page of 32-bit integers is cut short.");
      out.push(buf.readInt32LE(pos));
      pos += 4;
    } else if (type === 2) {
      if (pos + 8 > end) fail("A page of 64-bit integers is cut short.");
      out.push(Number(buf.readBigInt64LE(pos)));
      pos += 8;
    } else if (type === 5) {
      if (pos + 8 > end) fail("A page of doubles is cut short.");
      out.push(buf.readDoubleLE(pos));
      pos += 8;
    } else {
      fail(`The Parquet file has a column type this reader does not know (${type}).`);
    }
  }
  return out;
}

function readPageHeader(buf, start, end) {
  const r = cursor(buf, start, end);
  const header = readStruct(r);
  return { header, headerEnd: r.pos };
}

/**
 * Every level and value of one column chunk, in file order. Returns the definition levels, the repetition
 * levels (when the column is repeated) and the present values.
 */
export function readColumnChunk(buf, chunk, columns) {
  const information = chunk.meta;
  if (!information) fail("A column chunk has no metadata.");
  const pathKey = (information[3] ?? []).map(text).join(".");
  const column = columns.get(pathKey);
  if (!column) fail(`The column ${pathKey} is not in the schema.`);
  const codec = information[4] ?? 0;
  if (codec !== 0 && codec !== 1) fail(`The column ${pathKey} uses compression ${codec}; this reader reads only uncompressed and snappy Parquet.`);
  const valueCount = information[5] ?? 0;
  const starts = [information[11], information[9]].filter((value) => typeof value === "number" && value >= 0);
  if (!starts.length) fail(`The column ${pathKey} says neither where its dictionary nor its data page is.`);
  let pos = Math.min(...starts);
  const end = buf.length - 8;
  const { maxDef, maxRep, type } = column;
  let dictionary;
  const defs = [];
  const reps = [];
  const values = [];
  let seen = 0;

  while (seen < valueCount) {
    if (pos >= end) fail(`The pages of ${pathKey} ended before its ${valueCount} values.`);
    const { header, headerEnd } = readPageHeader(buf, pos, end);
    const pageType = header[1];
    const compressedSize = header[3] ?? 0;
    if (compressedSize < 0 || headerEnd + compressedSize > end) fail(`A page of ${pathKey} claims more bytes than the file has.`);
    const compressed = buf.subarray(headerEnd, headerEnd + compressedSize);
    const page = codec === 1 ? snappyDecompress(compressed) : compressed;

    if (pageType === 2) {
      const count = header[7]?.[1] ?? 0;
      const encoding = header[7]?.[2] ?? 0;
      if (encoding !== 0 && encoding !== 2) fail(`The dictionary of ${pathKey} uses encoding ${encoding}, which this reader does not know.`);
      dictionary = plainValues(page, 0, page.length, type, count);
      pos = headerEnd + compressedSize;
      continue;
    }
    if (pageType !== 0 && pageType !== 3) fail(`The column ${pathKey} has a page type this reader does not know (${pageType}).`);

    let count;
    let encoding;
    let at = 0;
    if (pageType === 0) {
      count = header[5]?.[1] ?? 0;
      encoding = header[5]?.[2] ?? 0;
      const readLevels = (maxLevel) => {
        if (!maxLevel) return [];
        if (at + 4 > page.length) fail(`A page of ${pathKey} is too short for its levels.`);
        const length = page.readUInt32LE(at);
        at += 4;
        if (at + length > page.length) fail(`The levels of ${pathKey} run past their page.`);
        const out = rleHybrid(page, at, at + length, Math.ceil(Math.log2(maxLevel + 1)), count);
        at += length;
        return out;
      };
      const pageReps = readLevels(maxRep);
      const pageDefs = readLevels(maxDef);
      reps.push(...pageReps);
      defs.push(...pageDefs);
    } else {
      count = header[8]?.[1] ?? 0;
      encoding = header[8]?.[4] ?? 0;
      const defLength = header[8]?.[5] ?? 0;
      const repLength = header[8]?.[6] ?? 0;
      if (maxRep && repLength) reps.push(...rleHybrid(page, 0, repLength, Math.ceil(Math.log2(maxRep + 1)), count));
      if (maxDef && defLength) defs.push(...rleHybrid(page, repLength, repLength + defLength, Math.ceil(Math.log2(maxDef + 1)), count));
      at = repLength + defLength;
    }
    if (defs.length < count + seen) fail(`A page of ${pathKey} has fewer definition levels than values.`);
    const present = count === 0 ? 0 : countAt(defs, seen, count, maxDef);
    let pageValues;
    if (encoding === 0) {
      pageValues = plainValues(page, at, page.length, type, present);
    } else if (encoding === 8 || encoding === 2) {
      if (!dictionary) fail(`The column ${pathKey} reads dictionary indices but has no dictionary page.`);
      if (at >= page.length) fail(`The column ${pathKey} has an empty page of dictionary indices.`);
      const bitWidth = page[at];
      if (bitWidth > 32) fail(`The column ${pathKey} uses a bit width of ${bitWidth}, which cannot be right.`);
      pageValues = rleHybrid(page, at + 1, page.length, bitWidth, present).map((index) => {
        if (index >= dictionary.length) fail(`The column ${pathKey} points at dictionary entry ${index} of ${dictionary.length}.`);
        return dictionary[index];
      });
    } else {
      fail(`The column ${pathKey} uses value encoding ${encoding}, which this reader does not know.`);
    }
    if (pageValues.length !== present) fail(`The column ${pathKey} has ${present} present values but read ${pageValues.length}.`);
    values.push(...pageValues);
    seen += count;
    pos = headerEnd + compressedSize;
  }
  return { defs, reps: maxRep ? reps : undefined, values, maxDef, maxRep, type };
}

/** How many of one page's definition levels sit at the column's maximum (the rows that hold a value). */
function countAt(defs, from, count, maxDef) {
  let present = 0;
  for (let index = from; index < from + count; index++) if (defs[index] === maxDef) present += 1;
  return present;
}

/** The value of a flat optional column, one per row, or null where the row has none. */
export function flatValues(decoded) {
  let at = 0;
  const out = decoded.defs.map((level) => (level === decoded.maxDef ? decoded.values[at++] : null));
  if (at !== decoded.values.length) fail("A column has values left over after its rows.");
  return out;
}

/** A list column as one array of values per row. */
export function listValues(decoded) {
  const rows = [];
  let current = null;
  let at = 0;
  for (let index = 0; index < decoded.defs.length; index++) {
    const rep = decoded.reps?.[index] ?? 0;
    if (rep === 0) {
      current = [];
      rows.push(current);
    }
    if (!current) fail("A list column starts in the middle of a row.");
    if (decoded.defs[index] === decoded.maxDef) current.push(decoded.values[at++]);
  }
  if (at !== decoded.values.length) fail("A list column has values left over after its rows.");
  return rows;
}

/** The rows of a whole file, column by column, from one row group or all of them. */
export function readRows(buf, options = {}) {
  const meta = readFileMeta(buf);
  const columns = schemaColumns(meta);
  const wanted = options.columns ? new Set(options.columns) : undefined;
  const out = new Map();
  for (const [key] of columns) if (!wanted || wanted.has(key)) out.set(key, []);
  for (const group of meta.rowGroups) {
    for (const chunk of group.columns) {
      const pathKey = (chunk.meta?.[3] ?? []).map(text).join(".");
      const target = out.get(pathKey);
      if (!target) continue;
      const decoded = readColumnChunk(buf, chunk, columns);
      const column = columns.get(pathKey);
      target.push(...(column.maxRep ? listValues(decoded) : flatValues(decoded)));
    }
  }
  return { meta, columns, data: out };
}
