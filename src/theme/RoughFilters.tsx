/* The three SVG filters every rough surface references through --cb-rough{,-sm,-lg}.
   TECHNICAL_DESIGN.md §6.9. Mounted exactly once, in App.

   primitiveUnits="userSpaceOnUse" is load-bearing: without it `scale` is read in bounding-box units
   and a 96px thumbnail gets wildly more distortion than a 420px zoom. With it, roughness is a
   constant number of pixels at every size — which is what scissors actually do. */

const SCALES = [
  { id: 'cb-rough-sm', scale: 2.5 }, // chips, inputs
  { id: 'cb-rough-md', scale: 5 }, // cards, buttons
  { id: 'cb-rough-lg', scale: 9 }, // panels, modals
] as const;

export function RoughFilters() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      // Not `display:none` and not `hidden`: a filter inside a display:none subtree is still
      // resolvable, but the zero-box + absolute keeps it out of layout without relying on that.
      style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }}
    >
      <defs>
        {SCALES.map(({ id, scale }) => (
          <filter
            key={id}
            id={id}
            x="-8%"
            y="-10%"
            width="116%"
            height="120%"
            filterUnits="objectBoundingBox"
            primitiveUnits="userSpaceOnUse"
          >
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.022 0.045"
              numOctaves={3}
              seed={7}
              result="n"
            />
            <feDisplacementMap
              in="SourceGraphic"
              in2="n"
              scale={scale}
              xChannelSelector="R"
              yChannelSelector="G"
            />
          </filter>
        ))}
      </defs>
    </svg>
  );
}
