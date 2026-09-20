import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useRef } from 'react';
import { DESTINATION_MARKER, LOCATION_MARKER } from './markers';
import { TILE_ATTRIBUTION_HTML, TILE_MAX_ZOOM, TILE_URL_TEMPLATE } from './tiles';
import type { MapPoint, MapViewProps } from './types';
import { frameMap } from './view';

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

function dotMarker(point: MapPoint, marker: typeof DESTINATION_MARKER, size: number): L.Marker {
  return L.marker(toLatLng(point), {
    icon: dotIcon(marker, size),
    title: marker.label,
    alt: marker.label,
    keyboard: false,
    interactive: false,
  });
}

/**
 * The map on the web, drawn with Leaflet on OpenStreetMap tiles. It fills its parent, and shows the
 * destination and the device's location when there are any, framed so both can be seen.
 */
export function MapView({ destination, currentLocation }: MapViewProps) {
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<L.Map | null>(null);
  const markers = useRef<L.LayerGroup | null>(null);

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
    // The zoom buttons sit in the middle of the right edge: the search and the location button on
    // the passenger's Home cover the top and the bottom of the map, and would hide them.
    const corner = node.querySelector<HTMLElement>('.leaflet-top.leaflet-right');
    if (corner) {
      corner.style.top = '50%';
      corner.style.transform = 'translateY(-50%)';
    }
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
    };
  }, []);

  // The markers and the framing follow the points.
  useEffect(() => {
    const instance = map.current;
    const group = markers.current;
    if (!instance || !group) return;

    group.clearLayers();
    if (destination) dotMarker(destination, DESTINATION_MARKER, 24).addTo(group);
    if (currentLocation) dotMarker(currentLocation, LOCATION_MARKER, 18).addTo(group);

    const framing = frameMap([destination, currentLocation]);
    if (framing.kind === 'bounds') {
      instance.fitBounds([toLatLng(framing.southWest), toLatLng(framing.northEast)], {
        padding: [64, 64],
        maxZoom: 16,
      });
    } else {
      instance.setView(toLatLng(framing.center), framing.zoom);
    }
  }, [destination, currentLocation]);

  return (
    <div
      ref={container}
      role="region"
      aria-label="Map"
      style={{ width: '100%', height: '100%', minHeight: 240 }}
    />
  );
}
