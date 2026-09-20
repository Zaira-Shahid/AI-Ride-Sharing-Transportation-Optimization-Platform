import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useRef } from 'react';
import { DESTINATION_MARKER, LOCATION_MARKER, PICKUP_MARKER } from './markers';
import { TILE_ATTRIBUTION_HTML, TILE_MAX_ZOOM, TILE_URL_TEMPLATE } from './tiles';
import type { MapPoint, MapViewProps } from './types';
import { clampInsets, frameMap, frameMargin } from './view';

const toLatLng = (point: MapPoint): L.LatLngTuple => [point.latitude, point.longitude];

/** A round marker drawn in CSS, so no image files are needed. */
function dotIcon(marker: { color: string; ring: string }, size: number): L.DivIcon {
  const html = `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${marker.color};border:3px solid #ffffff;box-shadow:0 0 0 3px ${marker.ring};box-sizing:border-box"></div>`;
  return L.divIcon({
    html,
    className: '',
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function dotMarker(point: MapPoint, marker: typeof PICKUP_MARKER, size: number): L.Marker {
  return L.marker(toLatLng(point), {
    icon: dotIcon(marker, size),
    title: marker.label,
    alt: marker.label,
    keyboard: false,
    interactive: false,
  });
}

const NO_INSETS = { top: 0, bottom: 0 };

/**
 * The map on the web, drawn with Leaflet on OpenStreetMap tiles. It fills its parent, and shows the
 * destination and the device's location when there are any, framed so both can be seen.
 */
export function MapView({
  pickup,
  destination,
  currentLocation,
  insets = NO_INSETS,
}: MapViewProps) {
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<L.Map | null>(null);
  const markers = useRef<L.LayerGroup | null>(null);
  const zoomCorner = useRef<HTMLElement | null>(null);
  // Read when places change, so that a card growing does not move the map by itself.
  const latestInsets = useRef(insets);
  latestInsets.current = insets;

  // The map itself is made once.
  useEffect(() => {
    const node = container.current;
    if (!node) return undefined;
    const instance = L.map(node, { zoomControl: false, attributionControl: true });
    L.control.zoom({ position: 'topright' }).addTo(instance);
    L.tileLayer(TILE_URL_TEMPLATE, {
      maxZoom: TILE_MAX_ZOOM,
      attribution: TILE_ATTRIBUTION_HTML,
    }).addTo(instance);
    markers.current = L.layerGroup().addTo(instance);
    zoomCorner.current = node.querySelector<HTMLElement>('.leaflet-top.leaflet-right');
    const world = frameMap([]);
    if (world.kind === 'world') instance.setView(toLatLng(world.center), world.zoom);
    map.current = instance;

    // The parent can change size (the window, a keyboard); the map has to be told.
    const observer = new ResizeObserver(() => instance.invalidateSize());
    observer.observe(node);

    return () => {
      observer.disconnect();
      instance.remove();
      map.current = null;
      markers.current = null;
      zoomCorner.current = null;
    };
  }, []);

  // The zoom buttons sit on the right edge, below whatever covers the top of the map.
  useEffect(() => {
    if (!zoomCorner.current) return;
    zoomCorner.current.style.top = `${insets.top + 8}px`;
  }, [insets.top]);

  // The markers and the framing follow the points.
  useEffect(() => {
    const instance = map.current;
    const group = markers.current;
    if (!instance || !group) return;

    group.clearLayers();
    // Drawn in this order, so a pickup taken from the device's location covers its own dot.
    if (currentLocation) dotMarker(currentLocation, LOCATION_MARKER, 18).addTo(group);
    if (destination) dotMarker(destination, DESTINATION_MARKER, 24).addTo(group);
    if (pickup) dotMarker(pickup, PICKUP_MARKER, 22).addTo(group);

    const framing = frameMap([pickup, destination, currentLocation]);
    if (framing.kind === 'world') {
      instance.setView(toLatLng(framing.center), framing.zoom);
      return;
    }
    // Fit the places into the part of the map that is not covered. One place is a box of no size,
    // which the same call centres there and closes in on.
    const [southWest, northEast] =
      framing.kind === 'bounds'
        ? [framing.southWest, framing.northEast]
        : [framing.center, framing.center];
    const height = instance.getSize().y;
    const { top, bottom } = clampInsets(latestInsets.current, height);
    const margin = frameMargin(height - top - bottom);
    instance.fitBounds([toLatLng(southWest), toLatLng(northEast)], {
      paddingTopLeft: [margin, top + margin],
      paddingBottomRight: [margin, bottom + margin],
      maxZoom: framing.kind === 'point' ? framing.zoom : 16,
    });
  }, [pickup, destination, currentLocation]);

  return (
    <div
      ref={container}
      role="region"
      aria-label="Map"
      style={{ width: '100%', height: '100%', minHeight: 240 }}
    />
  );
}
