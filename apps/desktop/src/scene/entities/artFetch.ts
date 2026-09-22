/**
 * One fetch per drawing, shared by everything that draws it.
 *
 * The existence probe loads the file into an `HTMLImageElement` to find out
 * whether it is there; that element is also exactly what Pixi needs to make a
 * texture. Loading it a second time by URL would be a second fetch of the same
 * bytes — and, worse, a second *chance to get different bytes*.
 *
 * **Which is what happened.** In dev the browser is free to cache an image it
 * was given no cache headers for, and it does. The decor was re-delivered
 * trimmed to its ink — a 25px bookcase where a 100px canvas had been — under
 * the same file name, and a normal reload went on serving the old canvas. The
 * scene sized the sprite for a 25px drawing, so the bookcase came out a
 * quarter of its height and floated mid-wall, anchored to the bottom of a
 * canvas that was mostly empty. Nothing in the code was wrong and nothing on
 * screen was right.
 *
 * So in dev every ask carries a stamp that is new once per page load: the same
 * file name is asked for afresh after every reload, which is the only rate at
 * which anyone re-imports art anyway. A shipped build carries its art inside
 * the installer, where there is nothing to go stale, and asks for it as is.
 */
const STAMP = import.meta.env.DEV ? `?v=${Date.now()}` : "";

/** The drawing at this path, or null when there is no such file. Quiet: a
 *  missing drawing is the ordinary state while a set is being drawn. */
export function fetchImage(path: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => resolve(null);
    el.src = path + STAMP;
  });
}
