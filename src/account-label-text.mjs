// Shared by the account pool and the Control Center so the counter and the
// saved label count the same user-perceived characters.
export const ACCOUNT_LABEL_LIMIT = 120;

export const ACCOUNT_LABEL_INVALID = "Account label is invalid.";
export const ACCOUNT_LABEL_FORBIDDEN = "Account label contains characters that are not allowed.";
export const ACCOUNT_LABEL_TOO_LONG = "Account label is limited to 120 characters.";
export const ACCOUNT_LABEL_COLLISION = "Account label matches another account.";

// Controls, line separators, and bidi overrides/isolates. A label is a display
// name, so these can only spoof the row (RLO) or break the layout.
const FORBIDDEN_LABEL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/;
// Electron's ipcMain rejection prefixes the message the handler threw.
const REMOTE_METHOD_ERROR = /^Error invoking remote method 'router-control:[^']+': Error:\s*/;

export function visibleRemoteError(message) {
  return String(message ?? "").replace(REMOTE_METHOD_ERROR, "");
}

export function accountLabelRejection(message) {
  const text = visibleRemoteError(message);
  if (text === ACCOUNT_LABEL_FORBIDDEN) return "forbidden";
  if (text === ACCOUNT_LABEL_TOO_LONG) return "too-long";
  if (text === ACCOUNT_LABEL_COLLISION) return "collision";
  if (text === ACCOUNT_LABEL_INVALID) return "invalid";
  return "";
}

export function canonicalAccountLabel(label) {
  return String(label ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

// "ChatGPT account 1", "chatgpt  account  1", and full-width "１" are one name.
export function generatedAccountNumber(label) {
  const match = /^chatgpt account (\d+)$/.exec(canonicalAccountLabel(label));
  if (!match) return undefined;
  const number = Number(match[1]);
  if (!Number.isSafeInteger(number) || number < 1) return undefined;
  return number;
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
  if (typeof label !== "string") throw new Error(ACCOUNT_LABEL_INVALID);
  if (FORBIDDEN_LABEL_CHARACTERS.test(label) || accountLabelHasLoneSurrogate(label)) {
    throw new Error(ACCOUNT_LABEL_FORBIDDEN);
  }
  const trimmed = label.trim();
  if (accountLabelGraphemeLength(trimmed) > ACCOUNT_LABEL_LIMIT) {
    throw new Error(ACCOUNT_LABEL_TOO_LONG);
  }
  return trimmed;
}
