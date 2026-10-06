import { fontFamily } from '@ridemesh/ui';
import { createContext, forwardRef, useContext } from 'react';
import {
  StyleSheet,
  Text as NativeText,
  TextInput as NativeTextInput,
  type TextInputProps,
  type TextProps,
  type TextStyle,
} from 'react-native';

// Inter, one family: a custom font is chosen by family name per weight, and fontWeight is ignored for
// one on Android. These two wrap react-native's Text and TextInput and turn the weight a style already
// asks for into the matching Inter family, so a screen changes only its import, never its styles.
// Digits are tabular (fares and times line up); an app shows nothing until its fonts have loaded.

const FAMILY_BY_WEIGHT: Record<string, string> = {
  normal: fontFamily.regular,
  '100': fontFamily.regular,
  '200': fontFamily.regular,
  '300': fontFamily.regular,
  '400': fontFamily.regular,
  '500': fontFamily.medium,
  '600': fontFamily.semibold,
  '700': fontFamily.bold,
  bold: fontFamily.bold,
  '800': fontFamily.bold,
  '900': fontFamily.bold,
};

function interStyle(style: TextProps['style'], nested: boolean): TextStyle {
  const { fontWeight, fontFamily: own, ...rest } = StyleSheet.flatten(style) ?? {};
  const family = own ?? (fontWeight ? FAMILY_BY_WEIGHT[String(fontWeight)] : undefined);
  return {
    ...rest,
    // Text nested in other text inherits the family unless it names a weight of its own.
    ...(family ? { fontFamily: family } : nested ? {} : { fontFamily: fontFamily.regular }),
    fontVariant: rest.fontVariant ?? ['tabular-nums'],
  };
}

const InsideText = createContext(false);

export function Text(props: TextProps) {
  const nested = useContext(InsideText);
  return (
    <InsideText.Provider value>
      <NativeText {...props} style={interStyle(props.style, nested)} />
    </InsideText.Provider>
  );
}

export const TextInput = forwardRef<NativeTextInput, TextInputProps>(
  function TextInput(props, ref) {
    return <NativeTextInput ref={ref} {...props} style={interStyle(props.style, false)} />;
  },
);
export type TextInput = NativeTextInput;
