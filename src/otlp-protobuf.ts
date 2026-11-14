// Decoder for OTLP trace exports in protobuf (ExportTraceServiceRequest, as
// sent by OTLP/HTTP with content-type application/x-protobuf). Hand-written
// so burnlint keeps no runtime dependencies; it turns the request into the
// OTLP/JSON shape the official JSON exporters send, which is what `record`
// writes and `audit` reads.
//
// Message and field numbers are those of opentelemetry-proto
// (opentelemetry/proto/{collector/trace,trace,resource,common}/v1). Checked
// against @opentelemetry/exporter-trace-otlp-proto 0.223.2: decoding its
// bodies gives what @opentelemetry/exporter-trace-otlp-http 0.223.2 sends for
// the same spans (fixtures/otel-js-exports.ndjson).
//
// JSON form, as in the OTLP/JSON spec: trace and span ids as lowercase hex;
// 64-bit times as decimal strings; enums (span kind, status code) as numbers;
// int attributes as numbers, or decimal strings beyond 2^53; bytes as base64.
// Fields at their default value are left out, as protobuf leaves them out of
// the wire. Unknown fields are skipped, so newer senders still decode.

export class ProtobufError extends Error {}

const MAX_DEPTH = 64;
const utf8 = new TextDecoder("utf-8");

// Wire types.
const VARINT = 0;
const I64 = 1;
const LEN = 2;
const I32 = 5;

class Reader {
  pos: number;
  constructor(
    readonly buf: Uint8Array,
    start: number,
    readonly end: number,
  ) {
    this.pos = start;
  }

  private need(n: number): void {
    if (n < 0 || this.pos + n > this.end) throw new ProtobufError("truncated message");
  }

  varint(): bigint {
    let result = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      this.need(1);
      const b = this.buf[this.pos++]!;
      result |= BigInt(b & 0x7f) << shift;
      if (b < 0x80) return BigInt.asUintN(64, result);
    }
    throw new ProtobufError("varint longer than 10 bytes");
  }

  /** A varint used as a length, tag or 32-bit count. */
  uint(): number {
    const v = this.varint();
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new ProtobufError("length out of range");
    return Number(v);
  }

  fixed64(): bigint {
    this.need(8);
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8).getBigUint64(0, true);
    this.pos += 8;
    return v;
  }

  fixed32(): number {
    this.need(4);
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 4).getUint32(0, true);
    this.pos += 4;
    return v;
  }

  double(): number {
    this.need(8);
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8).getFloat64(0, true);
    this.pos += 8;
    return v;
  }

  bytes(): Uint8Array {
    const n = this.uint();
    this.need(n);
    const b = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }

  string(): string {
    return utf8.decode(this.bytes());
  }

  /** The length-delimited message at the current position, as its own reader. */
  sub(): Reader {
    const n = this.uint();
    this.need(n);
    const r = new Reader(this.buf, this.pos, this.pos + n);
    this.pos += n;
    return r;
  }

  skip(wire: number): void {
    if (wire === VARINT) this.varint();
    else if (wire === I64) (this.need(8), (this.pos += 8));
    else if (wire === LEN) this.bytes();
    else if (wire === I32) (this.need(4), (this.pos += 4));
    else throw new ProtobufError(`unsupported wire type ${wire}`);
  }
}

/**
 * Reads every field of the message in `r`. `on` returns the wire type it
 * expects for a field it knows (and has read it), or undefined to skip it.
 */
function fields(r: Reader, on: (field: number, wire: number) => boolean): void {
  while (r.pos < r.end) {
    const tag = r.uint();
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (field === 0) throw new ProtobufError("field number 0");
    if (!on(field, wire)) r.skip(wire);
  }
}

/** Reads a field only when its wire type is the expected one; anything else is malformed. */
function expect(wire: number, want: number, field: number): void {
  if (wire !== want) throw new ProtobufError(`field ${field}: wire type ${wire}, expected ${want}`);
}

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const base64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

function int64Json(v: bigint): number | string {
  const s = BigInt.asIntN(64, v);
  return s >= BigInt(Number.MIN_SAFE_INTEGER) && s <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(s) : s.toString();
}

function doubleJson(v: number): number | string {
  // JSON has no NaN or Infinity; proto3 JSON writes them as strings.
  return Number.isFinite(v) ? v : String(v);
}

type Json = Record<string, unknown>;

function anyValue(r: Reader, depth: number): Json {
  if (depth > MAX_DEPTH) throw new ProtobufError("attribute values nested too deep");
  let out: Json = {};
  fields(r, (f, w) => {
    switch (f) {
      case 1:
        expect(w, LEN, f);
        out = { stringValue: r.string() };
        return true;
      case 2:
        expect(w, VARINT, f);
        out = { boolValue: r.varint() !== 0n };
        return true;
      case 3:
        expect(w, VARINT, f);
        out = { intValue: int64Json(r.varint()) };
        return true;
      case 4:
        expect(w, I64, f);
        out = { doubleValue: doubleJson(r.double()) };
        return true;
      case 5: {
        expect(w, LEN, f);
        const values: Json[] = [];
        const a = r.sub();
        fields(a, (af, aw) => (af === 1 ? (expect(aw, LEN, af), values.push(anyValue(a.sub(), depth + 1)), true) : false));
        out = { arrayValue: { values } };
        return true;
      }
      case 6: {
        expect(w, LEN, f);
        const values: Json[] = [];
        const l = r.sub();
        fields(l, (lf, lw) => (lf === 1 ? (expect(lw, LEN, lf), values.push(keyValue(l.sub(), depth + 1)), true) : false));
        out = { kvlistValue: { values } };
        return true;
      }
      case 7:
        expect(w, LEN, f);
        out = { bytesValue: base64(r.bytes()) };
        return true;
    }
    return false;
  });
  return out;
}

function keyValue(r: Reader, depth = 0): Json {
  let key = "";
  let value: Json = {};
  fields(r, (f, w) => {
    if (f === 1) return expect(w, LEN, f), (key = r.string()), true;
    if (f === 2) return expect(w, LEN, f), (value = anyValue(r.sub(), depth + 1)), true;
    return false;
  });
  return { key, value };
}

/** Repeated KeyValue `attributes` plus `dropped_attributes_count`, shared by several messages. */
function attributeFields(out: Json, r: Reader, f: number, w: number, attrField: number, droppedField: number): boolean {
  if (f === attrField) {
    expect(w, LEN, f);
    ((out.attributes ??= []) as Json[]).push(keyValue(r.sub()));
    return true;
  }
  if (f === droppedField) {
    expect(w, VARINT, f);
    const n = r.uint();
    if (n) out.droppedAttributesCount = n;
    return true;
  }
  return false;
}

function setString(out: Json, key: string, r: Reader, w: number, f: number): true {
  expect(w, LEN, f);
  const s = r.string();
  if (s) out[key] = s;
  return true;
}

function setId(out: Json, key: string, r: Reader, w: number, f: number): true {
  expect(w, LEN, f);
  const b = r.bytes();
  if (b.length) out[key] = hex(b);
  return true;
}

function setUint(out: Json, key: string, r: Reader, w: number, f: number): true {
  expect(w, VARINT, f);
  const n = r.uint();
  if (n) out[key] = n;
  return true;
}

function setFixed32(out: Json, key: string, r: Reader, w: number, f: number): true {
  expect(w, I32, f);
  const n = r.fixed32();
  if (n) out[key] = n;
  return true;
}

function setTime(out: Json, key: string, r: Reader, w: number, f: number): true {
  expect(w, I64, f);
  out[key] = r.fixed64().toString();
  return true;
}

function resource(r: Reader): Json {
  const out: Json = {};
  fields(r, (f, w) => attributeFields(out, r, f, w, 1, 2));
  return out;
}

function scope(r: Reader): Json {
  const out: Json = {};
  fields(r, (f, w) => {
    if (f === 1) return setString(out, "name", r, w, f);
    if (f === 2) return setString(out, "version", r, w, f);
    return attributeFields(out, r, f, w, 3, 4);
  });
  return out;
}

function event(r: Reader): Json {
  const out: Json = {};
  fields(r, (f, w) => {
    if (f === 1) return setTime(out, "timeUnixNano", r, w, f);
    if (f === 2) return setString(out, "name", r, w, f);
    return attributeFields(out, r, f, w, 3, 4);
  });
  return out;
}

function link(r: Reader): Json {
  const out: Json = {};
  fields(r, (f, w) => {
    if (f === 1) return setId(out, "traceId", r, w, f);
    if (f === 2) return setId(out, "spanId", r, w, f);
    if (f === 3) return setString(out, "traceState", r, w, f);
    if (f === 6) return setFixed32(out, "flags", r, w, f);
    return attributeFields(out, r, f, w, 4, 5);
  });
  return out;
}

function status(r: Reader): Json {
  const out: Json = {};
  fields(r, (f, w) => {
    if (f === 2) return setString(out, "message", r, w, f);
    if (f === 3) return setUint(out, "code", r, w, f);
    return false;
  });
  return out;
}

function span(r: Reader): Json {
  const out: Json = {};
  fields(r, (f, w) => {
    switch (f) {
      case 1:
        return setId(out, "traceId", r, w, f);
      case 2:
        return setId(out, "spanId", r, w, f);
      case 3:
        return setString(out, "traceState", r, w, f);
      case 4:
        return setId(out, "parentSpanId", r, w, f);
      case 5:
        return setString(out, "name", r, w, f);
      case 6:
        return setUint(out, "kind", r, w, f);
      case 7:
        return setTime(out, "startTimeUnixNano", r, w, f);
      case 8:
        return setTime(out, "endTimeUnixNano", r, w, f);
      case 11:
        expect(w, LEN, f);
        ((out.events ??= []) as Json[]).push(event(r.sub()));
        return true;
      case 12:
        return setUint(out, "droppedEventsCount", r, w, f);
      case 13:
        expect(w, LEN, f);
        ((out.links ??= []) as Json[]).push(link(r.sub()));
        return true;
      case 14:
        return setUint(out, "droppedLinksCount", r, w, f);
      case 15:
        expect(w, LEN, f);
        out.status = status(r.sub());
        return true;
      case 16:
        return setFixed32(out, "flags", r, w, f);
    }
    return attributeFields(out, r, f, w, 9, 10);
  });
  return out;
}

export interface DecodedTraces {
  /** The request in OTLP/JSON form: `{ resourceSpans: [...] }`. */
  request: { resourceSpans: Json[] };
  spans: number;
}

/** Decodes an ExportTraceServiceRequest. Throws ProtobufError on malformed input. */
export function decodeTraceRequest(body: Uint8Array): DecodedTraces {
  const r = new Reader(body, 0, body.length);
  const resourceSpans: Json[] = [];
  let spans = 0;
  fields(r, (f, w) => {
    if (f !== 1) return false;
    expect(w, LEN, f);
    const rs: Json = {};
    const rr = r.sub();
    fields(rr, (rf, rw) => {
      if (rf === 1) return expect(rw, LEN, rf), (rs.resource = resource(rr.sub())), true;
      if (rf === 3) return setString(rs, "schemaUrl", rr, rw, rf);
      if (rf !== 2) return false;
      expect(rw, LEN, rf);
      const ss: Json = {};
      const sr = rr.sub();
      fields(sr, (sf, sw) => {
        if (sf === 1) return expect(sw, LEN, sf), (ss.scope = scope(sr.sub())), true;
        if (sf === 3) return setString(ss, "schemaUrl", sr, sw, sf);
        if (sf !== 2) return false;
        expect(sw, LEN, sf);
        ((ss.spans ??= []) as Json[]).push(span(sr.sub()));
        spans++;
        return true;
      });
      ((rs.scopeSpans ??= []) as Json[]).push(ss);
      return true;
    });
    resourceSpans.push(rs);
    return true;
  });
  return { request: { resourceSpans }, spans };
}
