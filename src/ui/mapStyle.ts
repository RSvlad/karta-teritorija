// Quiet light basemap. OpenFreeMap is a free public service without an availability guarantee
// (see its terms); VITE_MAP_STYLE swaps it for a self-hosted style/PMTiles without code changes.
// tile.openstreetmap.org must not be used here.
export const STYLE_URL: string = import.meta.env.VITE_MAP_STYLE || 'https://tiles.openfreemap.org/styles/positron';
