import { SPRITE_MARKUP } from '../../assets/icons/sprite';

/**
 * Mounts every `<symbol>` once, in App, so `<use href="#gi-…">` resolves anywhere in the tree.
 *
 * The markup is a generated build-time constant from a vendored dataset (scripts/gen-icons.mjs) —
 * no user input, no fetch, no runtime string building. That is the whole reason innerHTML is
 * acceptable here: it is a static asset that happens to be authored as SVG rather than as JSX.
 */
export function IconSprite() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      // Zero-box rather than display:none — a hidden subtree still resolves <use>, but this keeps
      // the element out of layout without depending on that.
      style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }}
      dangerouslySetInnerHTML={{ __html: SPRITE_MARKUP }}
    />
  );
}
