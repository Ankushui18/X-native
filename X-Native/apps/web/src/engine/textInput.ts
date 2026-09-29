/**
 * Text-input conveniences from the Text-and-typography section:
 * emoji `:codes` (360039957174 §Add emojis), smart quotes/symbols (same
 * article §Add smart symbols, behind Preferences ▸ Use smart quotes/symbols),
 * and RTL/bidi direction detection (4972283635863: "Figma automatically
 * handles text direction based on language detection").
 *
 * Pure functions: the editor overlay calls them on the textarea's value, and
 * the tests pin the conversions without a DOM.
 */

/** `:name` → emoji. The article's codes plus the common set; Figma inserts the
 *  Apple-emoji glyph, here the platform emoji the browser paints. Keyword
 *  search matches any substring of the name. */
export const EMOJI_CODES: Record<string, string> = {
  smile: "😀", grin: "😁", joy: "😂", wink: "😉", heart: "❤️", blue_heart: "💙",
  green_heart: "💚", yellow_heart: "💛", purple_heart: "💜", black_heart: "🖤",
  fire: "🔥", star: "⭐", sparkles: "✨", zap: "⚡", boom: "💥", tada: "🎉",
  rocket: "🚀", bulb: "💡", check: "✅", x: "❌", warning: "⚠️", question: "❓",
  exclamation: "❗", plus: "➕", minus: "➖", arrow_right: "➡️", arrow_left: "⬅️",
  arrow_up: "⬆️", arrow_down: "⬇️", thumbsup: "👍", thumbsdown: "👎", clap: "👏",
  wave: "👋", ok_hand: "👌", muscle: "💪", eyes: "👀", speech_balloon: "💬",
  hourglass: "⏳", lock: "🔒", unlock: "🔓", key: "🔑", mag: "🔍", gear: "⚙️",
  hammer: "🔨", wrench: "🔧", package: "📦", mailbox: "📬", calendar: "📅",
  camera: "📸", video_camera: "🎥", microphone: "🎤", headphones: "🎧",
  book: "📖", pencil: "✏️", paperclip: "📎", pushpin: "📌", chart_up: "📈",
  chart_down: "📉", moneybag: "💰", dollar: "💵", credit_card: "💳",
  hourglass_flowing: "⌛", bell: "🔔", trophy: "🏆", medal: "🏅", crown: "👑",
  gift: "🎁", balloon: "🎈", cake: "🍰", pizza: "🍕", coffee: "☕", beer: "🍺",
  earth_americas: "🌎", sun: "☀️", crescent_moon: "🌙", cloud: "☁️", rainbow: "🌈",
  dog: "🐶", cat: "🐱", fox: "🦊", bear: "🐻", panda_face: "🐼", penguin: "🐧",
  bug: "🐛", butterfly: "🦋", flower: "🌸", four_leaf_clover: "🍀", apple: "🍎",
};

/** Up to `limit` emoji for a typed prefix or keyword (the article's `:heart`
 *  search). Empty prefix matches nothing - the picker needs a query. */
export function emojiCompletions(query: string, limit = 5): { code: string; emoji: string }[] {
  const q = query.toLowerCase();
  if (!q) return [];
  const out: { code: string; emoji: string }[] = [];
  for (const [code, emoji] of Object.entries(EMOJI_CODES)) {
    if (code.startsWith(q) || code.includes(q)) out.push({ code, emoji });
    if (out.length >= limit) break;
  }
  return out;
}

/** The `:name` fragment right before the caret, or null. */
export function emojiQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, Math.max(0, caret));
  const m = /(?:^|[\s(])[:]([\w+-]{1,32})$/.exec(before);
  if (!m) return null;
  return { start: caret - m[1].length - 1, query: m[1] };
}

/** Replace a `:name` fragment with the emoji; returns the new text/caret. */
export function insertEmoji(text: string, start: number, caret: number, emoji: string): { text: string; caret: number } {
  return { text: text.slice(0, start) + emoji + text.slice(caret), caret: start + emoji.length };
}

/**
 * Smart quotes/symbols (360039957174): the documented character pairs and
 * straight-quote flipping. Operates on the whole value (the textarea's) so
 * quotes can tell opening from closing by what precedes them.
 */
export function smartConvert(text: string): string {
  let out = text
    .replace(/->/g, "→")
    .replace(/<-/g, "←")
    .replace(/vv/g, "↓")
    .replace(/\^\^/g, "↑")
    .replace(/\(c\)/g, "©")
    .replace(/\(r\)/g, "®")
    .replace(/\(tm\)/g, "™")
    .replace(/\[ \]/g, "▢");
  // Straight quotes become curly: a quote after whitespace/opening punctuation
  // (or at the start) opens, otherwise it closes. Same for single quotes.
  out = out
    .replace(/(^|[\s([{—-])"/g, "$1\u201c")
    .replace(/"/g, "\u201d")
    .replace(/(^|[\s([{—-])'/g, "$1\u2018")
    .replace(/'/g, "\u2019");
  return out;
}

const RTL = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;

/**
 * Font fallback (360040449673 / 4972283635863): "If a font doesn't support a
 * character you input, Figma will render that specific character in a Noto
 * font." Every text surface resolves through this stack so CJK and RTL
 * scripts land in Noto before the generic system fallback.
 */
export function fontFamilyStack(family: string): string {
  const f = (family || "Inter").replace(/["\\]/g, "");
  return `"${f}", Inter, "Noto Sans", "Noto Sans SC", "Noto Sans TC", "Noto Sans JP", "Noto Sans KR", "Noto Sans Arabic", "Noto Sans Hebrew", system-ui`;
}

/** Language detection (4972283635863): any RTL-script character marks the
 *  text as RTL-capable. */
export function hasRtlScript(text: string): boolean {
  return RTL.test(text);
}

/** Resolved paragraph direction: an explicit override wins, otherwise the
 *  first strong character of the paragraph decides (the browser's own rule,
 *  which the article describes as language detection). */
export function directionOf(text: string, override?: "auto" | "ltr" | "rtl" | null): "ltr" | "rtl" {
  if (override === "ltr" || override === "rtl") return override;
  return hasRtlScript(text) ? "rtl" : "ltr";
}
