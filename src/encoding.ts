const ASCII_WHITESPACE = new Set([0x09, 0x0a, 0x0c, 0x0d, 0x20]);

const BYTES_DASH_DASH_GT = new Uint8Array([0x2d, 0x2d, 0x3e]); // -->

const BYTES_META = new Uint8Array([0x6d, 0x65, 0x74, 0x61]); // meta
const BYTES_CHARSET = new Uint8Array([0x63, 0x68, 0x61, 0x72, 0x73, 0x65, 0x74]); // charset
const BYTES_HTTP_EQUIV = new Uint8Array([
  0x68, 0x74, 0x74, 0x70, 0x2d, 0x65, 0x71, 0x75, 0x69, 0x76,
]); // http-equiv
const BYTES_CONTENT = new Uint8Array([0x63, 0x6f, 0x6e, 0x74, 0x65, 0x6e, 0x74]); // content
const BYTES_CONTENT_TYPE = new Uint8Array([
  0x63, 0x6f, 0x6e, 0x74, 0x65, 0x6e, 0x74, 0x2d, 0x74, 0x79, 0x70, 0x65,
]); // content-type

interface SniffResult {
  readonly encoding: string;
  readonly bomLength: number;
}
interface DecodeResult {
  readonly text: string;
  readonly encoding: string;
}

function asciiLowerByte(b: number): number {
  return b >= 0x41 && b <= 0x5a ? b | 0x20 : b;
}

function isAsciiAlphaByte(b: number): boolean {
  const c = asciiLowerByte(b);
  return c >= 0x61 && c <= 0x7a;
}

function skipAsciiWhitespace(data: Uint8Array, i: number): number {
  while (i < data.length && ASCII_WHITESPACE.has(data[i]!)) i += 1;
  return i;
}

function stripAsciiWhitespace(value: Uint8Array | undefined): Uint8Array | undefined {
  if (value == null) return;
  let start = 0;
  let end = value.length;
  while (start < end && ASCII_WHITESPACE.has(value[start]!)) start += 1;
  while (end > start && ASCII_WHITESPACE.has(value[end - 1]!)) end -= 1;
  return value.subarray(start, end);
}

function asciiDecodeIgnore(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) {
    if (b <= 0x7f) out += String.fromCharCode(b);
  }
  return out;
}

function indexOfByte(data: Uint8Array, byte: number, start: number): number {
  for (let i = start; i < data.length; i += 1) {
    if (data[i] === byte) return i;
  }
  return -1;
}

function indexOfSubarray(data: Uint8Array, pattern: Uint8Array, start: number): number {
  outer: for (let i = start; i <= data.length - pattern.length; i += 1) {
    for (const [j, element] of pattern.entries()) {
      if (data[i + j] !== element) continue outer;
    }
    return i;
  }
  return -1;
}

function bytesEqualLower(
  data: Uint8Array,
  start: number,
  end: number,
  asciiLowerPattern: Uint8Array
): boolean {
  const len = end - start;
  if (len !== asciiLowerPattern.length) {
    return false;
  }
  for (let i = 0; i < len; i += 1) {
    if (asciiLowerByte(data[start + i]!) !== asciiLowerPattern[i]) return false;
  }
  return true;
}

function bytesEqualIgnoreAsciiCase(
  data: Uint8Array,
  asciiLowerPattern: Uint8Array
): boolean {
  if (data.length !== asciiLowerPattern.length) {
    return false;
  }
  for (const [i, element] of asciiLowerPattern.entries()) {
    if (asciiLowerByte(data[i]!) !== element) {
      return false;
    }
  }
  return true;
}

export function normalizeEncodingLabel(
  label: string | Uint8Array | undefined
): string | undefined {
  if (!label) return;

  const s =
    typeof label === "string"
      ? label
      : label instanceof Uint8Array
        ? asciiDecodeIgnore(label)
        : "";

  switch (s.trim().toLowerCase()) {
    case "utf-7":
    case "utf7":
    case "x-utf-7":
      return "windows-1252";

    case "utf-8":
    case "utf8":
      return "utf-8";

    case "iso-8859-1":
    case "iso8859-1":
    case "latin1":
    case "latin-1":
    case "l1":
    case "cp819":
    case "ibm819":
      return "windows-1252";

    case "windows-1252":
    case "windows1252":
    case "cp1252":
    case "x-cp1252":
      return "windows-1252";

    case "iso-8859-2":
    case "iso8859-2":
    case "latin2":
    case "latin-2":
      return "iso-8859-2";

    case "euc-jp":
    case "eucjp":
      return "euc-jp";

    case "utf-16":
    case "utf16":
      return "utf-16";

    case "utf-16le":
    case "utf16le":
      return "utf-16le";

    case "utf-16be":
    case "utf16be":
      return "utf-16be";

    default:
      return;
  }
}

function normalizeMetaDeclaredEncoding(label: string | Uint8Array): string | undefined {
  const enc = normalizeEncodingLabel(label);
  switch (enc) {
    case undefined:
      return;

    case "utf-16":
    case "utf-16le":
    case "utf-16be":
    case "utf-32":
    case "utf-32le":
    case "utf-32b":
      return "utf-8";

    default:
      return enc;
  }
}

function sniffBOM(data: Uint8Array): { bomEnc: string | undefined; bomLength: number } {
  if (data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) {
    return { bomEnc: "utf-8", bomLength: 3 };
  } else if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe) {
    return { bomEnc: "utf-16le", bomLength: 2 };
  } else if (data.length >= 2 && data[0] === 0xfe && data[1] === 0xff) {
    return { bomEnc: "utf-16be", bomLength: 2 };
  } else {
    return { bomEnc: undefined, bomLength: 0 };
  }
}

function extractCharsetFromContent(
  contentBytes: Uint8Array | undefined
): Uint8Array | undefined {
  if (contentBytes == null || contentBytes.length === 0) {
    return;
  }

  const normalized = new Uint8Array(contentBytes.length);
  for (const [i, ch] of contentBytes.entries()) {
    normalized[i] = ASCII_WHITESPACE.has(ch) ? 0x20 : asciiLowerByte(ch);
  }

  const charsetNeedle = new Uint8Array([0x63, 0x68, 0x61, 0x72, 0x73, 0x65, 0x74]); // charset
  const idx = indexOfSubarray(normalized, charsetNeedle, 0);
  if (idx === -1) return;

  let i = idx + charsetNeedle.length;
  const n = normalized.length;
  while (i < n && ASCII_WHITESPACE.has(normalized[i]!)) {
    i += 1;
  }
  if (i >= n || normalized[i] !== 0x3d) return; // '='
  i += 1;
  while (i < n && ASCII_WHITESPACE.has(normalized[i]!)) {
    i += 1;
  }
  if (i >= n) return;

  let quote: number | undefined;
  if (normalized[i] === 0x22 || normalized[i] === 0x27) {
    quote = normalized[i];
    i += 1;
  }

  const start = i;
  while (i < n) {
    const ch = normalized[i]!;
    if (quote != null) {
      if (ch === quote) break;
    } else if (ASCII_WHITESPACE.has(ch) || ch === 0x3b) {
      break;
    }
    i += 1;
  }

  if (quote != null && (i >= n || normalized[i] !== quote)) return;

  return normalized.subarray(start, i);
}

function preScanForMetaCharset(data: Uint8Array): string | undefined {
  const maxNonComment = 1024;
  const maxTotalScan = 65536;

  const n = data.length;
  let i = 0;
  let nonComment = 0;

  while (i < n && i < maxTotalScan && nonComment < maxNonComment) {
    if (data[i] !== 0x3c) {
      i += 1;
      nonComment += 1;
      continue;
    }

    // Comment <!-- ... -->
    if (
      i + 3 < n &&
      data[i + 1] === 0x21 &&
      data[i + 2] === 0x2d &&
      data[i + 3] === 0x2d
    ) {
      const end = indexOfSubarray(data, BYTES_DASH_DASH_GT, i + 4);
      if (end === -1) return;
      i = end + 3;
      continue;
    }

    // Tag open
    let j = i + 1;

    // End tag: skip it.
    if (j < n && data[j] === 0x2f) {
      let k = i;
      let quote: number | undefined;
      while (k < n && k < maxTotalScan && nonComment < maxNonComment) {
        const ch = data[k];
        if (quote == null) {
          if (ch === 0x22 || ch === 0x27) quote = ch;
          else if (ch === 0x3e) {
            k += 1;
            nonComment += 1;
            break;
          }
        } else if (ch === quote) {
          quote = undefined;
        }
        k += 1;
        nonComment += 1;
      }
      i = k;
      continue;
    }

    if (j >= n || !isAsciiAlphaByte(data[j]!)) {
      i += 1;
      nonComment += 1;
      continue;
    }

    const nameStart = j;
    while (j < n && isAsciiAlphaByte(data[j]!)) j += 1;

    if (!bytesEqualLower(data, nameStart, j, BYTES_META)) {
      // Skip rest of tag (with quote handling) to avoid interpreting '<' inside attrs.
      let k = i;
      let quote: number | undefined;
      while (k < n && k < maxTotalScan && nonComment < maxNonComment) {
        const ch = data[k];
        if (quote == null) {
          if (ch === 0x22 || ch === 0x27) quote = ch;
          else if (ch === 0x3e) {
            k += 1;
            nonComment += 1;
            break;
          }
        } else if (ch === quote) {
          quote = undefined;
        }
        k += 1;
        nonComment += 1;
      }
      i = k;
      continue;
    }

    // Parse attributes until '>'.
    let charset: Uint8Array | undefined;
    let httpEquiv: Uint8Array | undefined;
    let content: Uint8Array | undefined;

    let k = j;
    let sawGt = false;
    const startI = i;

    while (k < n && k < maxTotalScan) {
      const ch = data[k]!;
      if (ch === 0x3e) {
        sawGt = true;
        k += 1;
        break;
      }

      if (ch === 0x3c) break;

      if (ASCII_WHITESPACE.has(ch) || ch === 0x2f) {
        k += 1;
        continue;
      }

      const attrStart = k;
      while (k < n) {
        const c = data[k]!;
        if (
          ASCII_WHITESPACE.has(c) ||
          c === 0x3d ||
          c === 0x3e ||
          c === 0x2f ||
          c === 0x3c
        )
          break;
        k += 1;
      }
      const attrEnd = k;
      k = skipAsciiWhitespace(data, k);

      let value: Uint8Array | undefined;
      if (k < n && data[k] === 0x3d) {
        k += 1;
        k = skipAsciiWhitespace(data, k);
        if (k >= n) break;

        const q = data[k];
        if (q === 0x22 || q === 0x27) {
          const quote = q;
          k += 1;
          const valStart = k;
          const endQuote = indexOfByte(data, quote, k);
          if (endQuote === -1) {
            // Unclosed quote: ignore this meta.
            i += 1;
            nonComment += 1;
            charset = undefined;
            httpEquiv = undefined;
            content = undefined;
            sawGt = false;
            break;
          }
          value = data.subarray(valStart, endQuote);
          k = endQuote + 1;
        } else {
          const valStart = k;
          while (k < n) {
            const c = data[k]!;
            if (ASCII_WHITESPACE.has(c) || c === 0x3e || c === 0x3c) break;
            k += 1;
          }
          value = data.subarray(valStart, k);
        }
      }

      if (bytesEqualLower(data, attrStart, attrEnd, BYTES_CHARSET)) {
        charset = stripAsciiWhitespace(value);
      } else if (bytesEqualLower(data, attrStart, attrEnd, BYTES_HTTP_EQUIV)) {
        httpEquiv = value;
      } else if (bytesEqualLower(data, attrStart, attrEnd, BYTES_CONTENT)) {
        content = value;
      }
    }

    if (sawGt) {
      if (charset && charset.length) {
        const enc = normalizeMetaDeclaredEncoding(charset);
        if (enc) return enc;
      }

      if (
        httpEquiv &&
        bytesEqualIgnoreAsciiCase(httpEquiv, BYTES_CONTENT_TYPE) &&
        content
      ) {
        const extracted = extractCharsetFromContent(content);
        if (extracted) {
          const enc = normalizeMetaDeclaredEncoding(extracted);
          if (enc) return enc;
        }
      }

      i = k;
      const consumed = i - startI;
      nonComment += consumed;
    } else {
      i += 1;
      nonComment += 1;
    }
  }

  return;
}

/**
 * Resolves the encoding for an HTML byte stream using transport headers, BOM, and meta pre-scan.
 */
export function sniffHTMLEncoding(
  data: Uint8Array,
  transportEncoding: string | Uint8Array | undefined
): SniffResult {
  const transport = normalizeEncodingLabel(transportEncoding);
  if (transport) return { encoding: transport, bomLength: 0 };

  const { bomEnc, bomLength } = sniffBOM(data);
  if (bomEnc) return { encoding: bomEnc, bomLength };

  const metaEnc = preScanForMetaCharset(data);
  if (metaEnc) return { encoding: metaEnc, bomLength: 0 };

  return { encoding: "windows-1252", bomLength: 0 };
}

const SUPPORTED_DECODE_HTML_ENCODINGS = new Set([
  "utf-8",
  "windows-1252",
  "iso-8859-2",
  "euc-jp",
  "utf-16",
  "utf-16le",
  "utf-16be",
]);

/**
 * Decodes HTML bytes into text using `sniffHTMLEncoding`.
 */
export function decodeHTML(
  data: Uint8Array,
  transportEncoding: string | Uint8Array | undefined
): DecodeResult {
  const { encoding, bomLength } = sniffHTMLEncoding(data, transportEncoding);

  let enc = encoding;
  if (!SUPPORTED_DECODE_HTML_ENCODINGS.has(enc)) {
    enc = "windows-1252";
  }

  const payload = bomLength ? data.subarray(bomLength) : data;

  if (enc === "utf-16") {
    const { bomEnc, bomLength } = sniffBOM(payload);
    if (bomEnc === "utf-16le" || bomEnc === "utf-16be") {
      return {
        text: new TextDecoder(bomEnc).decode(payload.subarray(bomLength)),
        encoding: enc,
      };
    }

    return {
      text: new TextDecoder("utf-16le").decode(payload),
      encoding: enc,
    };
  }

  return {
    text: new TextDecoder(enc).decode(payload),
    encoding: enc,
  };
}
