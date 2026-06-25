# IDML → Fabric.js Full Conversion Checklist

## 1) Geometry + transforms

- [x] Convert all `PathGeometry` shapes (not only rect/text)
- [x] Map `ItemTransform` fully (translate/scale/rotate/shear)
- [x] Support nested/group transform inheritance
- [x] Preserve original z-order exactly
- [x] Export mixed per-corner radii/types
- [x] Prevent unintended rounded corners on non-rounded rectangles

## 2) Paint model

- [x] Full stroke mapping (alignment, caps, joins, miter, dashes)
- [x] Linear gradient conversion (stops, angle, transform)
- [x] Radial gradient conversion (stops, focal settings if needed)
- [x] Tint/spot/swatches support
- [x] Stable CMYK → RGB conversion policy
- [x] Opacity + blend mode mapping
- [x] Overprint behavior mapping (or fallback warnings)

## 3) Text fidelity

- [x] Threaded story flow across linked text frames (estimated split with diagnostics)
- [x] Paragraph/character style inheritance + overrides
- [x] Kerning/tracking/leading/baseline shift mapping
- [x] First baseline behavior parity
- [x] Text-on-path baseline/alignment/start-offset parity
- [x] OpenType features (ligatures, small caps, etc.)
- [x] Superscript/subscript and case transforms
- [ ] Vertical justification + inset spacing parity

## 4) Effects + appearance

- [ ] Drop shadow conversion
- [ ] Inner shadow conversion
- [ ] Feather/glow/transparency effects
- [ ] Object clipping/masks (including nested masks)
- [ ] Correct fill/stroke/effects render order

## 5) Document structure

- [ ] Layer visibility/lock/printability mapping
- [ ] Master page and override support
- [ ] Facing pages/spread coordinate normalization
- [ ] Bleed/slug/page box mapping to canvas/clip

## 6) Linked/embedded assets

- [ ] Image placement with frame vs content transforms
- [ ] Crop/fitting options parity
- [ ] Linked vs embedded asset resolution
- [ ] Windows-safe path handling for asset references
- [ ] ICC/profile-aware color handling (if required)

## 7) Special content

- [ ] Tables support
- [ ] Bullets/numbering support
- [ ] Inline/anchored object support
- [ ] Footnotes/endnotes support (if required)
- [ ] Hyperlinks/notes/conditions support (if required)
- [ ] Non-rectangular text wrap + offsets

## 8) Reliability layer

- [x] Refactor and double-check the coordinate system to be more accurate with Fabric.js
- [ ] Versioned output JSON schema
- [ ] Feature parity matrix (`supported/partial/unsupported`)
- [ ] Fallback rules for unsupported IDML constructs
- [ ] Warning/diagnostic log output
- [ ] Golden-file visual regression tests
- [ ] Structural diff checks (counts, bounds, styles)
- [ ] CI pipeline for regression + fixture validation
