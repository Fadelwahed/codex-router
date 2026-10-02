// Shared by the account pool and the Control Center so the counter and the
// saved label count the same user-perceived characters.
export const ACCOUNT_LABEL_LIMIT = 120;

export const ACCOUNT_LABEL_INVALID = "Account label is invalid.";
export const ACCOUNT_LABEL_FORBIDDEN = "Account label contains characters that are not allowed.";
export const ACCOUNT_LABEL_TOO_LONG = "Account label is limited to 120 characters.";
export const ACCOUNT_LABEL_COLLISION = "Account label matches another account.";
export const ACCOUNT_LABEL_UNKNOWN_ID = "Account id is not registered.";
export const ACCOUNT_LABEL_IO = "The account label could not be saved.";
export const ACCOUNT_LABEL_CLI = "The account label command failed.";
export const ACCOUNT_LABEL_FAILED = "The account label could not be saved.";

// Stable across the pool, the CLI, IPC, and the renderer. Electron keeps only
// the message, so the code travels inside that one line.
export const ACCOUNT_LABEL_ERROR_CODES = Object.freeze([
  "invalid",
  "forbidden",
  "too-long",
  "collision",
  "unknown-id",
  "io",
  "cli",
  "unknown",
]);

const ACCOUNT_LABEL_ERROR_TEXT = Object.freeze({
  invalid: ACCOUNT_LABEL_INVALID,
  forbidden: ACCOUNT_LABEL_FORBIDDEN,
  "too-long": ACCOUNT_LABEL_TOO_LONG,
  collision: ACCOUNT_LABEL_COLLISION,
  "unknown-id": ACCOUNT_LABEL_UNKNOWN_ID,
  io: ACCOUNT_LABEL_IO,
  cli: ACCOUNT_LABEL_CLI,
  unknown: ACCOUNT_LABEL_FAILED,
});

const LEGACY_ACCOUNT_LABEL_ERRORS = new Map([
  [ACCOUNT_LABEL_INVALID, "invalid"],
  [ACCOUNT_LABEL_FORBIDDEN, "forbidden"],
  [ACCOUNT_LABEL_TOO_LONG, "too-long"],
  [ACCOUNT_LABEL_COLLISION, "collision"],
  [ACCOUNT_LABEL_UNKNOWN_ID, "unknown-id"],
  ["Account id is invalid.", "unknown-id"],
]);

// Controls, line separators, and bidi overrides/isolates. A label is a display
// name, so these can only spoof the row (RLO) or break the layout.
const FORBIDDEN_LABEL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/;
// Compared away, and rejected in a new label unless U+200D joins a real emoji.
const ZERO_WIDTH_COMPARE = /[\u200B-\u200D\u2060\uFEFF]/g;
const ACCOUNT_LABEL_WIRE = /^account-label-error:([a-z0-9-]+)\s*:\s*/;
// Electron's ipcMain rejection prefixes the message the handler threw.
const REMOTE_METHOD_ERROR = /^Error invoking remote method 'router-control:[^']+': Error:\s*/;
const IO_MESSAGE = /^(?:ENOSPC|EIO|EACCES|EPERM|EROFS|EDQUOT|ENFILE|EMFILE|EBUSY|EAGAIN|ENOMEM|ENOSYS|ENOENT|EEXIST|ENOTDIR|EISDIR|ENAMETOOLONG|ELOOP|EMLINK|ENXIO|ENODEV|ETXTBSY|EFBIG|ENOSR)\b/;

export function accountLabelWireMessage(code) {
  const resolved = ACCOUNT_LABEL_ERROR_TEXT[code] ? code : "unknown";
  return `account-label-error:${resolved}: ${ACCOUNT_LABEL_ERROR_TEXT[resolved]}`;
}

export function accountLabelError(code, cause) {
  const error = new Error(accountLabelWireMessage(code));
  error.code = ACCOUNT_LABEL_ERROR_TEXT[code] ? code : "unknown";
  if (cause !== undefined) error.cause = cause;
  return error;
}

export function visibleRemoteError(message) {
  return String(message ?? "").replace(REMOTE_METHOD_ERROR, "").trim();
}

function accountLabelErrorText(message) {
  const text = visibleRemoteError(message).replace(/\r\n/g, "\n");
  const line = text.split("\n").map((entry) => entry.trim()).find(Boolean) || "";
  return line;
}

export function accountLabelErrorCode(message) {
  const line = accountLabelErrorText(message);
  const wire = ACCOUNT_LABEL_WIRE.exec(line);
  if (wire) return ACCOUNT_LABEL_ERROR_TEXT[wire[1]] ? wire[1] : "unknown";
  const legacy = LEGACY_ACCOUNT_LABEL_ERRORS.get(line);
  if (legacy) return legacy;
  if (IO_MESSAGE.test(line)) return "io";
  if (/^Router command failed\b/.test(line)) return "cli";
  return "unknown";
}

export function accountLabelRejection(message) {
  return accountLabelErrorCode(message);
}

// The renderer never shows the backend sentence. IPC drops a custom code, so
// the thrown message is the wire line the page already knows how to translate.
export function accountLabelPresentedError(error) {
  const message = error instanceof Error ? error.message : error;
  return accountLabelError(accountLabelErrorCode(message), error);
}

function isIoFailure(error) {
  const code = error && typeof error === "object" ? error.code : undefined;
  if (typeof code === "string" && /^E[A-Z0-9]{1,16}$/.test(code)) return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return accountLabelErrorCode(message) === "io" && !ACCOUNT_LABEL_WIRE.test(accountLabelErrorText(message));
}

export function accountLabelIoError(error) {
  if (isIoFailure(error)) return accountLabelError("io", error);
  if (error instanceof Error) throw error;
  throw new Error(String(error ?? ACCOUNT_LABEL_FAILED));
}

// One stderr line for every chatgpt-account-pool subcommand. Label failures
// keep their code; every other failure keeps its own sentence, without a stack.
export function accountPoolCommandFailureLine(error) {
  const line = accountLabelErrorText(error instanceof Error ? error.message : error);
  if (ACCOUNT_LABEL_WIRE.test(line)) return line;
  const legacy = LEGACY_ACCOUNT_LABEL_ERRORS.get(line);
  if (legacy) return accountLabelWireMessage(legacy);
  if (isIoFailure(error)) return accountLabelWireMessage("io");
  return line || ACCOUNT_LABEL_FAILED;
}

export function canonicalAccountLabel(label) {
  return String(label ?? "")
    .normalize("NFKC")
    .replace(ZERO_WIDTH_COMPARE, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// "ChatGPT account 1", "Chat GPT account 1", and full-width "１" are one name.
export function generatedAccountNumber(label) {
  const match = /^chat ?gpt account (\d+)$/.exec(canonicalAccountLabel(label));
  if (!match) return undefined;
  const number = Number(match[1]);
  if (!Number.isSafeInteger(number) || number < 1) return undefined;
  return number;
}

function isExtendedPictographic(codePoint) {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10FFFF) return false;
  return /\p{Extended_Pictographic}/u.test(String.fromCodePoint(codePoint));
}

// U+200D is a joiner only between emoji (optional variation selector or skin
// tone on either side). Every other zero-width character is rejected.
function zeroWidthJoinsEmoji(points, index) {
  if (points[index] !== 0x200D) return false;
  let previous = index - 1;
  if (points[previous] === 0xFE0F) previous -= 1;
  if (points[previous] >= 0x1F3FB && points[previous] <= 0x1F3FF) previous -= 1;
  if (!isExtendedPictographic(points[previous])) return false;
  let next = index + 1;
  if (points[next] === 0xFE0F) next += 1;
  if (!isExtendedPictographic(points[next])) return false;
  return true;
}

export function accountLabelHasDisallowedZeroWidth(value) {
  const points = Array.from(String(value ?? ""), (character) => character.codePointAt(0));
  for (let index = 0; index < points.length; index += 1) {
    const code = points[index];
    if (code !== 0x200B && code !== 0x200C && code !== 0x200D && code !== 0x2060 && code !== 0xFEFF) continue;
    if (!zeroWidthJoinsEmoji(points, index)) return true;
  }
  return false;
}

export function accountLabelIsUnsafe(value) {
  const text = String(value ?? "");
  return FORBIDDEN_LABEL_CHARACTERS.test(text) || accountLabelHasLoneSurrogate(text);
}

export function stripUnsafeAccountLabel(value) {
  const text = String(value ?? "");
  let cleaned = "";
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) {
        cleaned += text[index] + text[index + 1];
        index += 1;
      }
      continue;
    }
    if (code >= 0xDC00 && code <= 0xDFFF) continue;
    if (FORBIDDEN_LABEL_CHARACTERS.test(text[index])) continue;
    cleaned += text[index];
  }
  return cleaned;
}

export function accountLabelHasLoneSurrogate(value) {
  const text = String(value);
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return true;
      index += 1;
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      return true;
    }
  }
  return false;
}

export function accountLabelGraphemeLength(value, segment = true) {
  const text = String(value);
  if (segment) {
    try {
      if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
        const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
        let count = 0;
        for (const _part of segmenter.segment(text)) count += 1;
        return count;
      }
    } catch {
      // Fall through to code points when the segmenter is missing or rejects.
    }
  }
  return Array.from(text).length;
}

export function sliceAccountLabel(value, limit = ACCOUNT_LABEL_LIMIT) {
  const text = String(value);
  try {
    if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
      const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
      let count = 0;
      let end = 0;
      for (const part of segmenter.segment(text)) {
        if (count >= limit) break;
        count += 1;
        end = part.index + part.segment.length;
      }
      return text.slice(0, end);
    }
  } catch {
    // Fall through to code points.
  }
  return Array.from(text).slice(0, limit).join("");
}

// Spaces trim to empty, which is a reset. A control or bidi mark is rejected
// even when trimming would otherwise leave nothing, so the caller sees why.
export function assertAccountLabelText(label) {
  if (typeof label !== "string") throw accountLabelError("invalid");
  if (
    FORBIDDEN_LABEL_CHARACTERS.test(label)
    || accountLabelHasLoneSurrogate(label)
    || accountLabelHasDisallowedZeroWidth(label)
  ) {
    throw accountLabelError("forbidden");
  }
  const trimmed = label.trim();
  if (accountLabelGraphemeLength(trimmed) > ACCOUNT_LABEL_LIMIT) {
    throw accountLabelError("too-long");
  }
  return trimmed;
}
