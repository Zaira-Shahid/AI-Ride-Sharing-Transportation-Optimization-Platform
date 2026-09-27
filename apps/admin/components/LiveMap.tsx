'use client';

import type { ActiveVehicle, MapPosition } from '@ridemesh/firebase';
import type L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useRef } from 'react';

const TILE_URL_TEMPLATE = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_MAX_ZOOM = 19;
const TILE_ATTRIBUTION_HTML =
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors';
const VEHICLE_DOT = { color: '#22d3ee', ring: 'rgba(34,211,238,0.35)' };
const ROUTE_LINE_OPTIONS = { color: '#3b82f6', weight: 3, opacity: 0.7, dashArray: '4 6' };
const WORLD_CENTER: L.LatLngTuple = [20, 0];
const WORLD_ZOOM = 2;

interface LiveMapProps {
  vehicles: ActiveVehicle[];
}

function toLatLng(point: MapPosition): L.LatLngTuple {
  return [point.latitude, point.longitude];
}

/**
 * Module 11.5 (admin dashboard: live map, first pass - vehicles only). A plain Leaflet map (not
 * @ridemesh/map's own MapView - that package's index also re-exports a react-native-maps-backed
 * native variant, which would break a Next.js web bundle) showing one dot per active vehicle and a
 * dashed straight line from its own origin to its own destination - not a real road route, since
 * currentRoute is never populated anywhere in this codebase and staff cannot call calculateRoute
 * (docs/security.md). Leaflet is loaded dynamically inside an effect, never at module scope, so it is
 * never evaluated during Next.js's server-side render pass.
 */
export function LiveMap({ vehicles }: LiveMapProps) {
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<L.Map | null>(null);
  const markers = useRef<L.LayerGroup | null>(null);
  const leaflet = useRef<typeof L | null>(null);

  useEffect(() => {
    const node = container.current;
    if (!node) return undefined;
    let cancelled = false;

    void import('leaflet').then((mod) => {
      if (cancelled || !node) return;
      const Lib = mod.default;
      leaflet.current = Lib;
      const instance = Lib.map(node, { zoomControl: true }).setView(WORLD_CENTER, WORLD_ZOOM);
      Lib.tileLayer(TILE_URL_TEMPLATE, {
        maxZoom: TILE_MAX_ZOOM,
        attribution: TILE_ATTRIBUTION_HTML,
      }).addTo(instance);
      markers.current = Lib.layerGroup().addTo(instance);
      map.current = instance;
    });

    return () => {
      cancelled = true;
      map.current?.remove();
      map.current = null;
      markers.current = null;
    };
  }, []);

  useEffect(() => {
    const Lib = leaflet.current;
    const instance = map.current;
    const group = markers.current;
    if (!Lib || !instance || !group) return;

    group.clearLayers();
    for (const vehicle of vehicles) {
      if (vehicle.origin && vehicle.destination) {
        Lib.polyline(
          [toLatLng(vehicle.origin), toLatLng(vehicle.destination)],
          ROUTE_LINE_OPTIONS,
        ).addTo(group);
      }
      if (vehicle.currentPosition) {
        const size = 16;
        Lib.marker(toLatLng(vehicle.currentPosition), {
          title: vehicle.journeyId,
          icon: Lib.divIcon({
            html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${VEHICLE_DOT.color};border:2px solid #ffffff;box-shadow:0 0 0 3px ${VEHICLE_DOT.ring};box-sizing:border-box"></div>`,
            className: '',
            iconSize: [size, size],
            iconAnchor: [size / 2, size / 2],
          }),
        }).addTo(group);
      }
    }
  }, [vehicles]);

  return (
    <div
      ref={container}
      role="region"
      aria-label="Live network map"
      className="h-[420px] w-full rounded-xl border border-white/10"
    />
  );
}
