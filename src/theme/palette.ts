/**
 * The card border swatches (§4.4: "hex, picked from the theme palette").
 *
 * A `CardTemplate.borderColor` is a hex string inside the exported file, so it cannot be a CSS
 * variable — the export has to stand alone in another browser. These mirror `tokens.css` by hand;
 * the CSS-side lint only forbids raw hex in stylesheets, which is exactly the fork this avoids by
 * keeping the one copy that must exist in TypeScript here, next to the tokens it mirrors.
 */
export const CARD_BORDER_COLORS: { hex: string; name: string }[] = [
  { hex: '#241c14', name: 'Ink' },
  { hex: '#9e2f26', name: 'Red' },
  { hex: '#26467f', name: 'Blue' },
  { hex: '#2b6034', name: 'Green' },
  { hex: '#9a6a12', name: 'Amber' },
  { hex: '#5b452c', name: 'Dark kraft' },
  { hex: '#8d6d47', name: 'Kraft' },
];

export const DEFAULT_CARD_BORDER = CARD_BORDER_COLORS[0].hex;
