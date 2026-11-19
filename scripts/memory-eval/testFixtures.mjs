// Fixtures for the memory eval's tests: a tiny Parquet file built in code, and a handful of hand-made rows.
//
// Nothing here comes from the dataset. The builder writes the same shapes the test split uses (optional
// scalars, a list of optional values, a boolean) so the reader is tested against a file whose every byte the
// test can explain, and the eval's tests never need the network or the multi-megabyte download.

/**
 * Thrift compact protocol, written by hand. Field ids are deltas within one struct, so a struct body always
 * starts its own run at zero; `writeStruct` and `listOfStructs` are the only doors in, and both restart it.
 */
class Thrift {
  constructor() {
    this.bytes = [];
    this.lastId = 0;
  }
  byte(value) {
    this.bytes.push(value & 0xff);
  }
  varint(value) {
    let rest = value;
    while (rest >= 0x80) {
      this.byte((rest & 0x7f) | 0x80);
      rest = Math.floor(rest / 128);
    }
    this.byte(rest);
  }
  zigzag(value) {
    this.varint(value >= 0 ? value * 2 : -value * 2 - 1);
  }
  binary(textValue) {
    const raw = Buffer.isBuffer(textValue) ? textValue : Buffer.from(String(textValue), "utf8");
    this.varint(raw.length);
    for (const byte of raw) this.byte(byte);
  }
  /** One field inside the current struct body. */
  field(id, type, write) {
    this.byte(((id - this.lastId) << 4) | type);
    this.lastId = id;
    write(this);
  }
  stop() {
    this.byte(0);
  }
  take() {
    return Buffer.from(this.bytes);
  }
}

const T = { BOOL_TRUE: 1, BOOL_FALSE: 2, I32: 5, I64: 6, BINARY: 8, LIST: 9, STRUCT: 12 };
const OPTIONAL = 1;
const REPEATED = 2;

/** A struct body: field ids from zero, ending with STOP. */
function writeStruct(t, write) {
  const outer = t.lastId;
  t.lastId = 0;
  write(t);
  t.stop();
  t.lastId = outer;
}

/** A field whose value is a struct. */
function structField(t, id, write) {
  t.field(id, T.STRUCT, (w) => writeStruct(w, write));
}

/** A field whose value is a list; each item is written by `writeItem` (a scalar or a struct body). */
function listField(t, id, itemType, count, writeItem) {
  t.field(id, T.LIST, (w) => {
    if (count < 15) w.byte((count << 4) | itemType);
    else {
      w.byte(0xf0 | itemType);
      w.varint(count);
    }
    for (let index = 0; index < count; index++) writeItem(w, index);
  });
}

function schemaElement(t, { type, repetition, name, children }) {
  writeStruct(t, (w) => {
    if (type !== undefined) w.field(1, T.I32, (x) => x.zigzag(type));
    if (repetition !== undefined) w.field(3, T.I32, (x) => x.zigzag(repetition));
    w.field(4, T.BINARY, (x) => x.binary(name));
    if (children !== undefined) w.field(5, T.I32, (x) => x.zigzag(children));
  });
}

/** RLE runs for one level stream: consecutive equal levels become one run each. */
function rleLevels(levels, bitWidth) {
  const out = [];
  const width = Math.ceil(bitWidth / 8);
  let index = 0;
  while (index < levels.length) {
    const value = levels[index];
    let count = 1;
    while (index + count < levels.length && levels[index + count] === value) count += 1;
    let rest = count * 2;
    while (rest >= 0x80) {
      out.push((rest & 0x7f) | 0x80);
      rest = Math.floor(rest / 128);
    }
    out.push(rest);
    for (let byte = 0; byte < width; byte++) out.push((value >> (8 * byte)) & 0xff);
    index += count;
  }
  return Buffer.from(out);
}

function lengthPrefixed(buffer) {
  const header = Buffer.alloc(4);
  header.writeUInt32LE(buffer.length, 0);
  return Buffer.concat([header, buffer]);
}

/** PLAIN values for one column type. */
function plain(type, values) {
  if (type === 0) {
    const bytes = Buffer.alloc(Math.ceil(values.length / 8));
    values.forEach((value, index) => {
      if (value) bytes[index >> 3] |= 1 << (index & 7);
    });
    return bytes;
  }
  if (type === 6) {
    return Buffer.concat(
      values.map((value) => {
        const raw = Buffer.from(value, "utf8");
        const header = Buffer.alloc(4);
        header.writeUInt32LE(raw.length, 0);
        return Buffer.concat([header, raw]);
      }),
    );
  }
  if (type === 2) {
    const bytes = Buffer.alloc(values.length * 8);
    values.forEach((value, index) => bytes.writeBigInt64LE(BigInt(value), index * 8));
    return bytes;
  }
  throw new Error(`fixture: no PLAIN writer for type ${type}`);
}

/**
 * One column chunk: a single data page, version 1, PLAIN, uncompressed, with whatever levels the column
 * needs. `rows` holds one entry per row: a value, null, or an array for a list column.
 */
function columnChunk({ path, type, maxDef, maxRep, rows }) {
  const defs = [];
  const reps = [];
  const values = [];
  for (const row of rows) {
    const pieces = maxRep ? (Array.isArray(row) ? row : []) : [row];
    if (maxRep && pieces.length === 0) {
      reps.push(0);
      defs.push(maxDef - 2); // the list is present but empty
      continue;
    }
    pieces.forEach((piece, index) => {
      reps.push(index === 0 ? 0 : 1);
      if (piece === null) defs.push(maxDef - 1);
      else {
        defs.push(maxDef);
        values.push(piece);
      }
    });
  }
  const levelCount = maxRep ? reps.length : rows.length;
  const body = [];
  if (maxRep) body.push(lengthPrefixed(rleLevels(reps, Math.ceil(Math.log2(maxRep + 1)))));
  if (maxDef) body.push(lengthPrefixed(rleLevels(defs, Math.ceil(Math.log2(maxDef + 1)))));
  body.push(plain(type, values));
  const page = Buffer.concat(body);

  const header = new Thrift();
  header.field(1, T.I32, (w) => w.zigzag(0)); // DATA_PAGE
  header.field(2, T.I32, (w) => w.zigzag(page.length)); // uncompressed_page_size
  header.field(3, T.I32, (w) => w.zigzag(page.length)); // compressed_page_size
  structField(header, 5, (w) => {
    w.field(1, T.I32, (x) => x.zigzag(levelCount)); // num_values, one per level entry
    w.field(2, T.I32, (x) => x.zigzag(0)); // PLAIN
    w.field(3, T.I32, (x) => x.zigzag(3)); // repetition levels: RLE
    w.field(4, T.I32, (x) => x.zigzag(3)); // definition levels: RLE
  });
  header.field(7, T.STRUCT, (w) => writeStruct(w, () => {})); // statistics: an empty struct
  header.byte(0); // STOP
  const headerBytes = header.take();
  return {
    path,
    type,
    numValues: values.length,
    headerLength: headerBytes.length,
    bytes: Buffer.concat([headerBytes, page]),
  };
}

/**
 * A tiny Parquet file: an int64 user id, two binary strings, two lists of binary strings and a boolean.
 * One row group, uncompressed PLAIN pages, so every byte is something a test wrote.
 */
export function tinyParquet(rows = DEFAULT_ROWS) {
  const schema = [
    { name: "schema", children: 6 },
    { name: "user_id", type: 2, repetition: OPTIONAL },
    { name: "question", type: 6, repetition: OPTIONAL },
    { name: "answer", type: 6, repetition: OPTIONAL },
    { name: "choices", repetition: OPTIONAL, children: 1 },
    { name: "list", repetition: REPEATED, children: 1 },
    { name: "element", type: 6, repetition: OPTIONAL },
    { name: "documents", repetition: OPTIONAL, children: 1 },
    { name: "list", repetition: REPEATED, children: 1 },
    { name: "element", type: 6, repetition: OPTIONAL },
    { name: "hard", type: 0, repetition: OPTIONAL },
  ];
  const plans = [
    { path: ["user_id"], type: 2, maxDef: 1, maxRep: 0, rows: rows.map((row) => row.user_id) },
    { path: ["question"], type: 6, maxDef: 1, maxRep: 0, rows: rows.map((row) => row.question) },
    { path: ["answer"], type: 6, maxDef: 1, maxRep: 0, rows: rows.map((row) => row.answer) },
    { path: ["choices", "list", "element"], type: 6, maxDef: 3, maxRep: 1, rows: rows.map((row) => row.choices) },
    { path: ["documents", "list", "element"], type: 6, maxDef: 3, maxRep: 1, rows: rows.map((row) => row.documents ?? []) },
    { path: ["hard"], type: 0, maxDef: 1, maxRep: 0, rows: rows.map((row) => row.hard) },
  ];
  let offset = 4; // past the leading PAR1
  const chunks = plans.map((plan) => {
    const chunk = columnChunk(plan);
    chunk.fileOffset = offset;
    chunk.dataPageOffset = offset; // the offset of the page itself, header first
    offset += chunk.bytes.length;
    return chunk;
  });

  const footer = new Thrift();
  footer.field(1, T.I32, (w) => w.zigzag(2)); // version
  listField(footer, 2, T.STRUCT, schema.length, (w, index) => schemaElement(w, schema[index]));
  footer.field(3, T.I64, (w) => w.zigzag(rows.length)); // num_rows
  listField(footer, 4, T.STRUCT, 1, (w) => {
    writeStruct(w, (group) => {
      listField(group, 1, T.STRUCT, chunks.length, (x, index) => {
        const chunk = chunks[index];
        writeStruct(x, (chunkStruct) => {
          chunkStruct.field(2, T.I64, (y) => y.zigzag(chunk.fileOffset));
          structField(chunkStruct, 3, (meta) => {
            meta.field(1, T.I32, (y) => y.zigzag(chunk.type));
            listField(meta, 2, T.I32, 1, (y) => y.zigzag(0)); // encodings: PLAIN
            listField(meta, 3, T.BINARY, chunk.path.length, (y, part) => y.binary(chunk.path[part]));
            meta.field(4, T.I32, (y) => y.zigzag(0)); // codec: uncompressed
            meta.field(5, T.I64, (y) => y.zigzag(chunk.numValues));
            meta.field(6, T.I64, (y) => y.zigzag(chunk.bytes.length));
            meta.field(7, T.I64, (y) => y.zigzag(chunk.bytes.length));
            meta.field(9, T.I64, (y) => y.zigzag(chunk.dataPageOffset));
          });
        });
      });
      group.field(2, T.I64, (x) => x.zigzag(chunks.reduce((total, chunk) => total + chunk.bytes.length, 0)));
      group.field(3, T.I64, (x) => x.zigzag(rows.length));
    });
  });
  footer.byte(0); // STOP
  const footerBytes = footer.take();
  const length = Buffer.alloc(4);
  length.writeUInt32LE(footerBytes.length, 0);
  return Buffer.concat([
    Buffer.from("PAR1", "latin1"),
    ...chunks.map((chunk) => chunk.bytes),
    footerBytes,
    length,
    Buffer.from("PAR1", "latin1"),
  ]);
}

/** Three rows in the test split's shape, none of them from the dataset. */
export const DEFAULT_ROWS = [
  {
    user_id: 7,
    question: "Would the person rather answer by email or by call?",
    answer: "Email, written slowly after a walk.",
    choices: ["Email, written slowly after a walk.", "A call at once.", "A voice note later."],
    documents: [
      "Leo: I read the failure twice before touching code, every time. Assistant: That sounds careful of you.",
      "Leo: Coffee in the morning, never tea. Assistant: Noted.",
    ],
    hard: false,
  },
  {
    user_id: 8,
    question: "What does the person do with a failing test?",
    answer: "Reads the failure twice before touching code.",
    choices: ["Reads the failure twice before touching code.", "Deletes the test.", "Reruns it until it passes."],
    documents: ["Leo: Long walks after lunch help me think about tests. Assistant: A good habit."],
    hard: true,
  },
  {
    user_id: 8,
    question: "Which drink does the person order?",
    answer: "",
    choices: ["Black coffee", "", "Tea"],
    documents: ["Leo: Coffee in the morning, never tea. Assistant: Understood."],
    hard: false,
  },
];

/** A small store of memories in Hivra's MemoryItem shape, for the scorer's tests. */
export function tinyItems(memoryId) {
  const make = (chat, text) => ({
    id: memoryId(["memory-eval", `chat-${chat}`, "part-0", text]),
    mateId: "memory-eval",
    action: "add",
    text,
    state: "confirmed",
    source: { kind: "import", ref: `chat-${chat}`, label: `chat ${chat + 1}` },
    evidence: text,
    support: 1,
    against: 0,
    createdAt: 1,
    updatedAt: 1,
  });
  return [
    make(0, "I read the failure twice before touching code, every time."),
    make(1, "Coffee in the morning, never tea."),
    make(2, "Long walks after lunch help me think about tests."),
  ];
}
