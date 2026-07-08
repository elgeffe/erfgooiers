/**
 * The Erfgooiers mark: a golden wheat garb bound with a cord, on a shield
 * above the green commons — in the manner of the old farmers' guild seals
 * of Het Gooi. Rendered inline in the top bar and intro card, and installed
 * as the favicon (SVG data URI, so no asset pipeline involved).
 */
export function logoSVG(size: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">
  <path d="M32 2.5 L58 10.5 V30 C58 46.5 46 56.5 32 61.5 C18 56.5 6 46.5 6 30 V10.5 Z" fill="#33271c" stroke="#d9a441" stroke-width="3" stroke-linejoin="round"/>
  <path d="M8.6 33 Q32 24.5 55.4 33 C54 46 44.5 54 32 58.6 C19.5 54 10 46 8.6 33 Z" fill="#4f6b3c"/>
  <g stroke="#d9a441" stroke-width="2.4" stroke-linecap="round" fill="none">
    <path d="M32 50 V21"/>
    <path d="M32 50 C29 40 25.5 33 22.5 24"/>
    <path d="M32 50 C35 40 38.5 33 41.5 24"/>
  </g>
  <path d="M25.8 41.5 Q32 45 38.2 41.5" stroke="#f0e6d2" stroke-width="2.6" fill="none" stroke-linecap="round"/>
  <g fill="#e8b855">
    <ellipse cx="32" cy="16" rx="4" ry="7"/>
    <ellipse cx="22.2" cy="19.5" rx="3.6" ry="6.2" transform="rotate(-20 22.2 19.5)"/>
    <ellipse cx="41.8" cy="19.5" rx="3.6" ry="6.2" transform="rotate(20 41.8 19.5)"/>
  </g>
  <g fill="#c98f2e">
    <ellipse cx="32" cy="16" rx="1.4" ry="5"/>
    <ellipse cx="22.2" cy="19.5" rx="1.3" ry="4.4" transform="rotate(-20 22.2 19.5)"/>
    <ellipse cx="41.8" cy="19.5" rx="1.3" ry="4.4" transform="rotate(20 41.8 19.5)"/>
  </g>
  <g stroke="#e8b855" stroke-width="1.3" stroke-linecap="round">
    <path d="M32 8 V4.6"/><path d="M19.8 13 L17.6 9.8"/><path d="M44.2 13 L46.4 9.8"/>
  </g>
</svg>`;
}

/** Set the wheat-garb shield as the tab icon. */
export function installFavicon(): void {
  const link = document.createElement('link');
  link.rel = 'icon';
  link.type = 'image/svg+xml';
  link.href = 'data:image/svg+xml;utf8,' + encodeURIComponent(logoSVG(64));
  document.head.appendChild(link);
}
