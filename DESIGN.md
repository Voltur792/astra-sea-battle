# Design system — Морской бой

## North Star

Рабочий тактический пульт настольной игры: карты остаются главным содержимым, а прозрачные стеклянные панели и тонкие контуры наследуют визуальный язык Sleep Pause Timer в Astra.

## Register

Продуктовый экран для ведения партии против Астры. Сначала читаемость координат и состояния клеток, затем декоративные детали.

## Colors and theme

- Surface glass: `color-mix(in srgb, var(--color-surface, #808080) 12%, transparent)`.
- Soft glass: `color-mix(in srgb, var(--color-surface, #808080) 8%, transparent)`.
- Hover glass: `color-mix(in srgb, var(--color-surface, #808080) 24%, transparent)`.
- Text: `var(--color-text, #f7f6ff)`; muted text: `var(--color-text-muted, #89869b)`.
- Accent and focus: `var(--color-accent, #8b5cf6)` and `var(--edge-focus, var(--color-accent, #8b5cf6))`.
- Borders: `var(--color-border, rgba(255, 255, 255, .09))` and `var(--edge-control, rgba(255, 255, 255, .16))`.
- Cell states add semantic sea-glass colors: hit coral, sunk amber, miss muted; symbols repeat the meaning without relying on color.

## Typography

- Sans: `var(--font-sans, 'Segoe UI', system-ui, sans-serif)`.
- Coordinates and counts use tabular numerals; labels are compact uppercase utility text.

## Layout and density

- Two equal map panels on wide windows; one column on narrow windows.
- Grid labels sit outside the 10×10 map. Cells remain square, with a consistent gap and visible outlines.
- Game selection and turn summary stay above the maps; legend stays adjacent to map content.

## Shape, elevation, and iconography

- Cards use 17px corners, a subtle inset highlight, 1px theme border, and a short accent hairline.
- Controls use the timer plugin's pill shape. Cells are near-square with small rounded corners.
- Use concise text glyphs for game states and one outline SVG icon for navigation.

## Motion and interaction

- Hover lift is limited to controls and available cells; respect `prefers-reduced-motion`.
- Focus rings use the Astra theme focus token. All map actions are native buttons.
- Runtime CSS tokens above are the canonical source; this file documents their mapping and local geometry.

## Anti-references

- No opaque dashboard canvas or heavy gradients that hide Astra's theme.
- No decorative ocean illustration competing with the grid.
- No color-only cell state and no hidden-only hover controls.
