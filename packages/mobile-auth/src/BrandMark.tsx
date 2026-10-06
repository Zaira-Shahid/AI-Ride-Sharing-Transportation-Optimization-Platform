import { palette, radius } from '@ridemesh/ui';
import { View } from 'react-native';

// PLACEHOLDER brand mark, drawn here from plain Views (no image, no dependency): three nodes joined
// by a route, the idea of riders sharing one journey. It is original and temporary; the real logo is
// a later decision and replaces this component, nothing else.

const NODES = [
  { x: 0.24, y: 0.66 },
  { x: 0.5, y: 0.3 },
  { x: 0.76, y: 0.66 },
] as const;

function Segment({
  from,
  to,
  size,
  thickness,
}: {
  from: { x: number; y: number };
  to: { x: number; y: number };
  size: number;
  thickness: number;
}) {
  const dx = (to.x - from.x) * size;
  const dy = (to.y - from.y) * size;
  const length = Math.hypot(dx, dy);
  const centreX = ((from.x + to.x) / 2) * size;
  const centreY = ((from.y + to.y) / 2) * size;
  return (
    <View
      style={{
        position: 'absolute',
        left: centreX - length / 2,
        top: centreY - thickness / 2,
        width: length,
        height: thickness,
        borderRadius: thickness / 2,
        backgroundColor: palette.electricCyan,
        transform: [{ rotate: `${Math.atan2(dy, dx)}rad` }],
      }}
    />
  );
}

export function BrandMark({ size = 64 }: { size?: number }) {
  const dot = size * 0.2;
  const thickness = Math.max(3, size * 0.06);
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: size,
        height: size,
        borderRadius: Math.min(radius.xl, size * 0.3),
        backgroundColor: palette.midnightNavy,
      }}
    >
      <Segment from={NODES[0]} to={NODES[1]} size={size} thickness={thickness} />
      <Segment from={NODES[1]} to={NODES[2]} size={size} thickness={thickness} />
      {NODES.map((node, index) => (
        <View
          key={index}
          style={{
            position: 'absolute',
            left: node.x * size - dot / 2,
            top: node.y * size - dot / 2,
            width: dot,
            height: dot,
            borderRadius: dot / 2,
            backgroundColor: index === 1 ? palette.cleanWhite : palette.electricCyan,
          }}
        />
      ))}
    </View>
  );
}
