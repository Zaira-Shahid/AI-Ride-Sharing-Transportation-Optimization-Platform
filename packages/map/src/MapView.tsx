import { useEffect, useRef } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import NativeMap, { Marker, Polyline, UrlTile } from 'react-native-maps';
import { DESTINATION_MARKER, DRIVER_MARKER, LOCATION_MARKER, PICKUP_MARKER } from './markers';
import { TILE_ATTRIBUTION_TEXT, TILE_MAX_ZOOM, TILE_URL_TEMPLATE } from './tiles';
import type { MapViewProps } from './types';
import { WORLD_CENTER, WORLD_ZOOM, clampInsets, frameMap, frameMargin } from './view';

// A region this many degrees across is about a street; a whole world is about 360 wide.
const POINT_SPAN = 0.01;
const NO_INSETS = { top: 0, bottom: 0 };
const WORLD_SPAN = 360 / 2 ** (WORLD_ZOOM - 1);
// How the route line looks (Module 4.7): a blue distinct from the pickup/destination/location dots.
const ROUTE_LINE_COLOR = '#3b82f6';

/**
 * The map on phones: react-native-maps with OpenStreetMap tiles drawn over it (see tiles.ts). It
 * fills its parent, and shows the destination and the device's location when there are any, framed
 * so both can be seen, with the route line between pickup and destination when one has been found
 * (Module 4.7). The web build has its own file (MapView.web.tsx).
 */
export function MapView({
  pickup,
  destination,
  currentLocation,
  driverLocation = null,
  route,
  insets = NO_INSETS,
}: MapViewProps) {
  const map = useRef<NativeMap | null>(null);
  const height = useRef(0);
  // Read when places change, so that a card growing does not move the map by itself.
  const latestInsets = useRef(insets);
  latestInsets.current = insets;

  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    // The whole route is framed when there is one, not just its two ends: a road route can bow out
    // past the straight line between them.
    const framing = frameMap([
      pickup,
      destination,
      currentLocation,
      driverLocation,
      ...(route ?? []),
    ]);
    if (framing.kind === 'bounds') {
      const { top, bottom } = clampInsets(latestInsets.current, height.current);
      const margin = frameMargin(height.current - top - bottom);
      instance.fitToCoordinates([framing.southWest, framing.northEast], {
        edgePadding: {
          top: top + margin,
          right: margin,
          bottom: bottom + margin,
          left: margin,
        },
        animated: true,
      });
    } else if (framing.kind === 'point') {
      // Put the place in the middle of the part that is not covered: move the centre of the map
      // north by half the difference of the covers, in degrees.
      const { top, bottom } = clampInsets(latestInsets.current, height.current);
      const shift = height.current > 0 ? ((top - bottom) / 2 / height.current) * POINT_SPAN : 0;
      instance.animateToRegion({
        latitude: framing.center.latitude + shift,
        longitude: framing.center.longitude,
        latitudeDelta: POINT_SPAN,
        longitudeDelta: POINT_SPAN,
      });
    } else {
      instance.animateToRegion({
        ...framing.center,
        latitudeDelta: WORLD_SPAN,
        longitudeDelta: WORLD_SPAN,
      });
    }
  }, [pickup, destination, currentLocation, driverLocation, route]);

  return (
    <View
      style={styles.fill}
      accessibilityLabel="Map"
      onLayout={(event) => {
        height.current = event.nativeEvent.layout.height;
      }}
    >
      <NativeMap
        ref={map}
        style={styles.fill}
        // The tiles below are the map. On Android the base map is switched off; on iOS the tiles
        // replace Apple's own map content.
        mapType={Platform.OS === 'android' ? 'none' : 'standard'}
        initialRegion={{
          ...WORLD_CENTER,
          latitudeDelta: WORLD_SPAN,
          longitudeDelta: WORLD_SPAN,
        }}
        rotateEnabled={false}
        toolbarEnabled={false}
        showsUserLocation={false}
      >
        <UrlTile urlTemplate={TILE_URL_TEMPLATE} maximumZ={TILE_MAX_ZOOM} shouldReplaceMapContent />
        {route && route.length > 1 ? (
          <Polyline coordinates={[...route]} strokeColor={ROUTE_LINE_COLOR} strokeWidth={4} />
        ) : null}
        {pickup ? (
          <Marker coordinate={pickup} title={PICKUP_MARKER.label} pinColor={PICKUP_MARKER.color} />
        ) : null}
        {destination ? (
          <Marker
            coordinate={destination}
            title={DESTINATION_MARKER.label}
            pinColor={DESTINATION_MARKER.color}
          />
        ) : null}
        {currentLocation ? (
          <Marker
            coordinate={currentLocation}
            title={LOCATION_MARKER.label}
            anchor={{ x: 0.5, y: 0.5 }}
            tracksViewChanges={false}
          >
            <View
              style={[
                styles.dot,
                { backgroundColor: LOCATION_MARKER.color, shadowColor: LOCATION_MARKER.ring },
              ]}
            />
          </Marker>
        ) : null}
        {driverLocation ? (
          <Marker
            coordinate={driverLocation}
            title={DRIVER_MARKER.label}
            anchor={{ x: 0.5, y: 0.5 }}
            tracksViewChanges={false}
          >
            <View
              style={[
                styles.dot,
                { backgroundColor: DRIVER_MARKER.color, shadowColor: DRIVER_MARKER.ring },
              ]}
            />
          </Marker>
        ) : null}
      </NativeMap>
      {/* OpenStreetMap requires this wherever its map is shown. */}
      <View pointerEvents="none" style={styles.attribution}>
        <Text style={styles.attributionText}>{TILE_ATTRIBUTION_TEXT}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  dot: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 3,
    borderColor: '#ffffff',
  },
  attribution: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    paddingHorizontal: 6,
    paddingVertical: 2,
    backgroundColor: 'rgba(255,255,255,0.8)',
  },
  attributionText: { fontSize: 10, color: '#333333' },
});
