/** Write text to the system clipboard without ever surfacing an unhandled
 *  rejection. `navigator.clipboard.writeText` rejects when the document is not
 *  focused or the permission is denied, and `void promise` suppresses the value
 *  but not the rejection — which showed up as a NotAllowedError page error.
 *  Falls back to a hidden textarea + execCommand where the async API is
 *  unavailable, so "Copy as code" still works in those contexts. */
export function copyText(text: string): void {
  const fallback = () => {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    } catch {
      /* Clipboard is genuinely unavailable; callers still show their toast. */
    }
  };
  const api = navigator.clipboard;
  if (!api?.writeText) {
    fallback();
    return;
  }
  api.writeText(text).catch(fallback);
}
