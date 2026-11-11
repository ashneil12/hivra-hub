// The reader, tested on a file built byte by byte in this repo. Nothing here touches the network or the dataset.
//
// A reader of an untrusted file also gets the failure cases: truncated, mislabelled, and lengths that point
// outside the bytes. Each one must stop with a message and never read past its buffer.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  flatValues,
  listValues,
  ParquetError,
  readColumnChunk,
  readFileMeta,
  readRows,
  rleHybrid,
  schemaColumns,
  snappyDecompress,
} from "./parquet.mjs";
import { DEFAULT_ROWS, tinyParquet } from "./testFixtures.mjs";

const utf8 = (value) => (value === null || value === undefined ? value : Buffer.from(value).toString("utf8"));

test("reads every column of the hand-made file", () => {
  const { meta, data } = readRows(tinyParquet());
  assert.equal(meta.numRows, DEFAULT_ROWS.length);
  assert.deepEqual(data.get("user_id"), [7, 8, 8]);
  assert.deepEqual(data.get("question").map(utf8), DEFAULT_ROWS.map((row) => row.question));
  assert.deepEqual(data.get("answer").map(utf8), DEFAULT_ROWS.map((row) => row.answer));
  assert.deepEqual(
    data.get("choices.list.element").map((row) => row.map(utf8)),
    DEFAULT_ROWS.map((row) => row.choices),
  );
  assert.deepEqual(
    data.get("documents.list.element").map((row) => row.map(utf8)),
    DEFAULT_ROWS.map((row) => row.documents),
  );
  assert.deepEqual(data.get("hard"), [false, true, false]);
});

test("only the columns a caller asks for are decoded", () => {
  const { data } = readRows(tinyParquet(), { columns: ["user_id", "hard"] });
  assert.deepEqual([...data.keys()].sort(), ["hard", "user_id"]);
});

test("a null in an optional column stays null, it does not shift the rows", () => {
  const rows = [
    { user_id: 1, question: "a", answer: "b", choices: [], documents: [], hard: false },
    { user_id: 2, question: null, answer: "c", choices: [], documents: [], hard: null },
  ];
  const { data } = readRows(tinyParquet(rows));
  assert.deepEqual(data.get("user_id"), [1, 2]);
  assert.deepEqual(data.get("question").map(utf8), ["a", null]);
  assert.deepEqual(data.get("answer").map(utf8), ["b", "c"]);
  assert.deepEqual(data.get("hard"), [false, null]);
});

test("an empty list row is one row with no values, not a skipped row", () => {
  const rows = [
    { user_id: 1, question: "a", answer: "b", choices: [], documents: [], hard: false },
    { user_id: 2, question: "c", answer: "d", choices: ["x"], documents: ["y"], hard: false },
  ];
  const { data } = readRows(tinyParquet(rows), { columns: ["choices.list.element", "documents.list.element"] });
  assert.deepEqual(data.get("choices.list.element").map((row) => row.map(utf8)), [[], ["x"]]);
  assert.deepEqual(data.get("documents.list.element").map((row) => row.map(utf8)), [[], ["y"]]);
});

test("the schema gives each leaf its levels", () => {
  const columns = schemaColumns(readFileMeta(tinyParquet()));
  const choices = columns.get("choices.list.element");
  assert.equal(choices.maxDef, 3);
  assert.equal(choices.maxRep, 1);
  assert.equal(columns.get("user_id").maxDef, 1);
  assert.equal(columns.get("user_id").maxRep, 0);
  assert.equal(columns.get("user_id").type, 2);
});

test("flat and list values are read back to the row shape they came from", () => {
  const decoded = { defs: [1, 0, 1], values: [Buffer.from("a"), Buffer.from("c")], maxDef: 1 };
  assert.deepEqual(flatValues(decoded).map(utf8), ["a", null, "c"]);

  const list = {
    defs: [3, 3, 1, 3],
    reps: [0, 1, 0, 0],
    values: [Buffer.from("x"), Buffer.from("y"), Buffer.from("z")],
    maxDef: 3,
    maxRep: 1,
  };
  assert.deepEqual(listValues(list).map((row) => row.map(utf8)), [["x", "y"], [], ["z"]]);
});

test("values left over after the rows are a refusal, not a silent drop", () => {
  assert.throws(() => flatValues({ defs: [1], values: [Buffer.from("a"), Buffer.from("b")], maxDef: 1 }), ParquetError);
  assert.throws(
    () => listValues({ defs: [3], reps: [0], values: [Buffer.from("a"), Buffer.from("b")], maxDef: 3, maxRep: 1 }),
    ParquetError,
  );
});

test("a file that does not carry the magic bytes is refused before anything is read", () => {
  assert.throws(() => readFileMeta(Buffer.from("not a parquet file at all, sorry")), ParquetError);
});

test("a footer length that points outside the file is refused", () => {
  const bad = Buffer.from(tinyParquet());
  bad.writeUInt32LE(0x7fffffff, bad.length - 8);
  assert.throws(() => readFileMeta(bad), /footer length/);
});

test("a zero footer length is refused", () => {
  const bad = Buffer.from(tinyParquet());
  bad.writeUInt32LE(0, bad.length - 8);
  assert.throws(() => readFileMeta(bad), /footer length/);
});

test("a truncated file is refused, never read past its end", () => {
  const good = tinyParquet();
  for (const cut of [8, 40, good.length - 40]) {
    assert.throws(() => readRows(good.subarray(0, cut)), ParquetError);
  }
});

test("a data page that starts past the end of the file is refused", () => {
  const good = tinyParquet();
  const meta = readFileMeta(good);
  const chunk = meta.rowGroups[0].columns[0];
  const lying = { ...chunk, meta: { ...chunk.meta, 9: good.length - 3 } };
  assert.throws(() => readColumnChunk(good, lying, schemaColumns(meta)), ParquetError);
});

test("a column that is not in the schema is refused by name", () => {
  const good = tinyParquet();
  const meta = readFileMeta(good);
  const chunk = meta.rowGroups[0].columns[0];
  const lying = { ...chunk, meta: { ...chunk.meta, 3: chunk.meta[3].map(() => Buffer.from("missing")) } };
  assert.throws(() => readColumnChunk(good, lying, schemaColumns(meta)), /missing is not in the schema/);
});

test("a column with a compression this reader does not know is refused by number", () => {
  const good = tinyParquet();
  const meta = readFileMeta(good);
  const chunk = meta.rowGroups[0].columns[0];
  const withGzip = { ...chunk, meta: { ...chunk.meta, 4: 2 } };
  assert.throws(() => readColumnChunk(good, withGzip, schemaColumns(meta)), /compression 2/);
});

test("snappy: a literal and a crossing copy decompress to the expected bytes", () => {
  // Length 6: a four-byte literal "abcd", then a two-byte copy from four bytes back, overlapping itself.
  const block = Buffer.from([0x06, 0x0c, 0x61, 0x62, 0x63, 0x64, 0x06, 0x04, 0x00]);
  assert.equal(snappyDecompress(block, 6).toString("utf8"), "abcdab");
});

test("snappy: a block whose length disagrees with its page is refused", () => {
  const block = Buffer.from([0x06, 0x0c, 0x61, 0x62, 0x63, 0x64, 0x06, 0x04, 0x00]);
  assert.throws(() => snappyDecompress(block, 7), /says it holds 6 bytes/);
});

test("snappy: a copy that points before the block start is refused", () => {
  const block = Buffer.from([0x04, 0x04, 0x61, 0x62, 0x06, 0x00, 0x00]);
  assert.throws(() => snappyDecompress(block, 4), /before the start/);
});

test("snappy: a truncated block is refused", () => {
  const block = Buffer.from([0x06, 0x0c, 0x61, 0x62]);
  assert.throws(() => snappyDecompress(block, 6), ParquetError);
});

test("rle hybrid: a repeated run and a bit-packed run both read", () => {
  const repeated = Buffer.from([0x06, 0x01]);
  assert.deepEqual(rleHybrid(repeated, 0, repeated.length, 1, 3), [1, 1, 1]);
  const packed = Buffer.from([0x03, 0b01011010]);
  assert.deepEqual(rleHybrid(packed, 0, packed.length, 1, 8), [0, 1, 0, 1, 1, 0, 1, 0]);
});

test("rle hybrid: only the levels a page asks for are returned", () => {
  const packed = Buffer.from([0x03, 0b01011010]);
  assert.deepEqual(rleHybrid(packed, 0, packed.length, 1, 3), [0, 1, 0]);
});

test("rle hybrid: a run cut short by the end of its buffer is refused", () => {
  const cut = Buffer.from([0x06]);
  assert.throws(() => rleHybrid(cut, 0, cut.length, 1, 3), ParquetError);
});
