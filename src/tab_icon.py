"""Navigation icon: a warship and a target sight, as on the store icon.

Astra 0.2.7 draws only vector tab icons; a PNG embedded through <image> leaves
the tab blank, so this is plain SVG that follows the theme via currentColor.
"""

TAB_ICON_SVG = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" '
    'stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">'
    '<path d="M2.5 15.5h15l-2.5 4H5z"/>'
    '<path d="M6 15.5v-3h6.5v3M9 12.5V10"/>'
    '<circle cx="18" cy="7" r="3.2"/>'
    '<path d="M18 2.5v1.3M18 10.2v1.3M13.5 7h1.3M21.2 7h1.3"/></svg>'
)
