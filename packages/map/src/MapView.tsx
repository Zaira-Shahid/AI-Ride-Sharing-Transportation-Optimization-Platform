import { useEffect, useRef } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import NativeMap, { Marker, UrlTile } from 'react-native-maps';
import { DESTINATION_MARKER, LOCATION_MARKER } from './markers';
import { TILE_ATTRIBUTION_TEXT, TILE_MAX_ZOOM, TILE_URL_TEMPLATE } from './tiles';
import type { MapViewProps } from './types';
import { WORLD_CENTER, WORLD_ZOOM, frameMap } from './view';

// A region this many degrees across is about a street; a whole world is about 360 wide.
const POINT_SPAN = 0.01;
const WORLD_SPAN = 360 / 2 ** (WORLD_ZOOM - 1);

/**
 * The map on phones: react-native-maps with OpenStreetMap tiles drawn over it (see tiles.ts). It
 * fills its parent, and shows the destination and the device's location when there are any, framed
 * so both can be seen. The web build has its own file (MapView.web.tsx).
 */
export function MapView({ destination, currentLocation }: MapViewProps) {
  const map = useRef<NativeMap | null>(null);

  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    const framing = frameMap([destination, currentLocation]);
    if (framing.kind === 'bounds') {
      instance.fitToCoordinates([framing.southWest, framing.northEast], {
        edgePadding: { top: 64, right: 64, bottom: 64, left: 64 },
        animated: true,
      });
    } else {
      const span = framing.kind === 'point' ? POINT_SPAN : WORLD_SPAN;
      instance.animateToRegion({ ...framing.center, latitudeDelta: span, longitudeDelta: span });
    }
  }, [destination, currentLocation]);

  return (
    <View style={styles.fill} accessibilityLabel="Map">
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
