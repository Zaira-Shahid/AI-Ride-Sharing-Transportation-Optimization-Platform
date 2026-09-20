// Where the map's pictures come from. This file is the only place that names the tile provider, so
// moving to another one (for example Google's, once billing is set up) means changing it and the
// two MapView files, nothing that uses the map.
//
// OpenStreetMap's own tile server is free and needs no key, but its usage policy allows only light
// use and requires the attribution below. It suits development and small pilots; before launch
// switch to a tile provider whose terms cover the expected traffic.
export const TILE_URL_TEMPLATE = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
export const TILE_MAX_ZOOM = 19;

/** Required by OpenStreetMap wherever its map is shown. HTML for the web map's attribution line. */
export const TILE_ATTRIBUTION_HTML =
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors';
/** The same, as plain text for the phone map. */
export const TILE_ATTRIBUTION_TEXT = '© OpenStreetMap contributors';
