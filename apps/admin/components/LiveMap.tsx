'use client';

import type { ActiveVehicle, MapPosition } from '@ridemesh/firebase';
import type { LiveTripPosition } from '@ridemesh/types';
import type L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useRef } from 'react';

const TILE_URL_TEMPLATE = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_MAX_ZOOM = 19;
const TILE_ATTRIBUTION_HTML =
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors';
const VEHICLE_DOT = { color: '#22d3ee', ring: 'rgba(34,211,238,0.35)' };
const ROUTE_LINE_OPTIONS = { color: '#3b82f6', weight: 3, opacity: 0.7, dashArray: '4 6' };
const PICKUP_COLOR = { matched: '#94a3b8', unmatched: '#f59e0b' };
const DROPOFF_COLOR = '#60a5fa';
// Module 11.5, second pass: the high-demand heatmap, built from the same rounded pickup positions
// the markers use - a heatmap never needs an exact point for any single trip, so this stays within
// the same privacy boundary. A plain binned-density overlay (count per grid cell, rendered as a
// circle sized/colored by that count) rather than a dedicated heatmap library - no new dependency,
// and "roughly where demand clusters" does not need anything more precise than this.
const DEMAND_CELL_DEGREES = 0.01; // ~1.1 km at the equator
const WORLD_CENTER: L.LatLngTuple = [20, 0];
const WORLD_ZOOM = 2;

interface LiveMapProps {
  vehicles: ActiveVehicle[];
  tripPositions: LiveTripPosition[];
}

function toLatLng(point: MapPosition): L.LatLngTuple {
  return [point.latitude, point.longitude];
}

function demandCells(
  positions: LiveTripPosition[],
): Array<{ center: L.LatLngTuple; count: number }> {
  const counts = new Map<string, { latitude: number; longitude: number; count: number }>();
  for (const trip of positions) {
    if (!trip.pickup) continue;
    const cellLat = Math.round(trip.pickup.latitude / DEMAND_CELL_DEGREES) * DEMAND_CELL_DEGREES;
    const cellLon = Math.round(trip.pickup.longitude / DEMAND_CELL_DEGREES) * DEMAND_CELL_DEGREES;
    const key = `${cellLat}_${cellLon}`;
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else counts.set(key, { latitude: cellLat, longitude: cellLon, count: 1 });
  }
  return [...counts.values()].map((cell) => ({
    center: [cell.latitude, cell.longitude],
    count: cell.count,
  }));
}

/**
 * Module 11.5 (admin dashboard: live map). A plain Leaflet map (not @ridemesh/map's own MapView -
 * that package's index also re-exports a react-native-maps-backed native variant, which would break
 * a Next.js web bundle) showing: one dot per active vehicle with a dashed straight line from its own
 * origin to its own destination (not a real road route, since currentRoute is never populated
 * anywhere in this codebase and staff cannot call calculateRoute, docs/security.md); a pickup marker
 * per currently-open trip, colored by whether it already has a driver (section 48's own "Unmatched
 * request" marker type); a drop-off marker per trip; and a high-demand heatmap built from the same
 * pickup positions. Every trip position is already rounded server-side
 * (functions/src/liveNetwork.ts) before it ever reaches this component - never the exact place.
 * Leaflet is loaded dynamically inside an effect, never at module scope, so it is never evaluated
 * during Next.js's server-side render pass.
 */
export function LiveMap({ vehicles, tripPositions }: LiveMapProps) {
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<L.Map | null>(null);
  const heatLayer = useRef<L.LayerGroup | null>(null);
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
      // The heat layer is added first, so it always renders beneath the vehicle/pickup/drop-off
      // markers added to the second layer group.
      heatLayer.current = Lib.layerGroup().addTo(instance);
      markers.current = Lib.layerGroup().addTo(instance);
      map.current = instance;
    });

    return () => {
      cancelled = true;
      map.current?.remove();
      map.current = null;
      heatLayer.current = null;
      markers.current = null;
    };
  }, []);

  useEffect(() => {
    const Lib = leaflet.current;
    const instance = map.current;
    const heat = heatLayer.current;
    if (!Lib || !instance || !heat) return;

    heat.clearLayers();
    const cells = demandCells(tripPositions);
    const maxCount = Math.max(1, ...cells.map((cell) => cell.count));
    for (const cell of cells) {
      const intensity = cell.count / maxCount;
      Lib.circle(cell.center, {
        radius: 600,
        color: 'transparent',
        fillColor: '#ef4444',
        fillOpacity: 0.12 + intensity * 0.35,
        stroke: false,
      }).addTo(heat);
    }
  }, [tripPositions]);

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

    for (const trip of tripPositions) {
      if (trip.pickup) {
        const size = 10;
        const color = trip.unmatched ? PICKUP_COLOR.unmatched : PICKUP_COLOR.matched;
        Lib.marker(toLatLng(trip.pickup), {
          title: trip.unmatched ? 'Unmatched pickup' : 'Pickup',
          icon: Lib.divIcon({
            html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:1.5px solid #ffffff;box-sizing:border-box"></div>`,
            className: '',
            iconSize: [size, size],
            iconAnchor: [size / 2, size / 2],
          }),
        }).addTo(group);
      }
      if (trip.dropoff) {
        const size = 9;
        Lib.marker(toLatLng(trip.dropoff), {
          title: 'Drop-off',
          icon: Lib.divIcon({
            html: `<div style="width:${size}px;height:${size}px;background:${DROPOFF_COLOR};border:1.5px solid #ffffff;box-sizing:border-box;transform:rotate(45deg)"></div>`,
            className: '',
            iconSize: [size, size],
            iconAnchor: [size / 2, size / 2],
          }),
        }).addTo(group);
      }
    }
  }, [vehicles, tripPositions]);

  return (
    <div
      ref={container}
      role="region"
      aria-label="Live network map"
      className="h-[420px] w-full rounded-xl border border-white/10"
    />
  );
}
