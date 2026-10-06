import { useState, type ReactNode } from "react";
import { Pressable, StyleSheet, useWindowDimensions, View, type ColorValue } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { AppText } from "../../components/AppText";

const PREVIEW_LINES = 5;

export function CollapsibleUserMessage(props: {
  readonly children: ReactNode;
  readonly backgroundColor: ColorValue;
  readonly lineHeight: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [contentHeight, setContentHeight] = useState(0);
  const { fontScale } = useWindowDimensions();
  const lineHeight = props.lineHeight * fontScale;
  const previewHeight = PREVIEW_LINES * lineHeight;
  const canCollapse = contentHeight > previewHeight + 1;
  const collapsed = !expanded;

  return (
    <View>
      <View style={[styles.viewport, collapsed && { maxHeight: previewHeight }]}>
        {/* Measure the full body even while its parent clips the preview. */}
        <View
          style={styles.body}
          onLayout={(event) => setContentHeight(event.nativeEvent.layout.height)}
        >
          {props.children}
        </View>
        {canCollapse && collapsed ? (
          <Svg
            pointerEvents="none"
            accessible={false}
            width="100%"
            height={lineHeight}
            style={styles.fade}
          >
            <Defs>
              <LinearGradient id="messageFade" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor={props.backgroundColor} stopOpacity={0} />
                <Stop offset="1" stopColor={props.backgroundColor} stopOpacity={1} />
              </LinearGradient>
            </Defs>
            <Rect width="100%" height="100%" fill="url(#messageFade)" />
          </Svg>
        ) : null}
      </View>
      {canCollapse ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          onPress={() => setExpanded((value) => !value)}
          className="mt-1 self-start py-1"
          hitSlop={8}
        >
          <AppText className="font-t3-medium text-xs text-white/80">
            {expanded ? "Show less" : "Show more"}
          </AppText>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  viewport: { overflow: "hidden" },
  body: { flexShrink: 0, width: "100%" },
  fade: { position: "absolute", bottom: 0 },
});
