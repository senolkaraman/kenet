import { useState } from "react";
import { View, Text, TouchableOpacity, ActivityIndicator, StyleSheet } from "react-native";
import { RTCView } from "react-native-webrtc";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, withTiming, runOnJS } from "react-native-reanimated";
import { session } from "../core/session";
import { useStore } from "../core/store";
import { colors } from "../theme";

const MAX_SCALE = 6;

export function Session() {
  const st = useStore(session.store, (x) => x);
  const [controlOn, setControlOn] = useState(false);

  // pinch-zoom / pan transform (all shared values so gesture worklets can read them)
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const savedTx = useSharedValue(0);
  const savedTy = useSharedValue(0);
  const stageW = useSharedValue(1);
  const stageH = useSharedValue(1);

  const active = st.phase === "active";
  const connecting = st.phase === "connecting" || st.phase === "requesting" || st.phase === "reconnecting";

  // Screen-space touch -> normalised (0..1) point on the remote desktop, undoing the current
  // pan/zoom so the mouse lands where the finger visually is even while zoomed in. Runs on the
  // JS thread (via runOnJS) where reading shared-value .value is fine.
  const sendPointer = (px: number, py: number, click: boolean) => {
    const w = stageW.value;
    const h = stageH.value;
    const bx = (px - w / 2 - tx.value) / scale.value + w / 2;
    const by = (py - h / 2 - ty.value) / scale.value + h / 2;
    const nx = Math.min(1, Math.max(0, bx / w));
    const ny = Math.min(1, Math.max(0, by / h));
    if (click) {
      session.sendControl({ type: "pointer", x: nx, y: ny, button: "left", down: true });
      setTimeout(() => session.sendControl({ type: "pointer", x: nx, y: ny, button: "left", down: false }), 40);
    } else {
      session.sendControl({ type: "pointer", x: nx, y: ny });
    }
  };

  const clampPan = () => {
    "worklet";
    const maxX = (stageW.value * (scale.value - 1)) / 2 + stageW.value * 0.4;
    const maxY = (stageH.value * (scale.value - 1)) / 2 + stageH.value * 0.4;
    tx.value = Math.min(maxX, Math.max(-maxX, tx.value));
    ty.value = Math.min(maxY, Math.max(-maxY, ty.value));
  };

  const resetZoom = () => {
    "worklet";
    scale.value = withTiming(1);
    savedScale.value = 1;
    tx.value = withTiming(0);
    ty.value = withTiming(0);
    savedTx.value = 0;
    savedTy.value = 0;
  };

  const pinch = Gesture.Pinch()
    .onUpdate((e) => {
      scale.value = Math.min(MAX_SCALE, Math.max(1, savedScale.value * e.scale));
    })
    .onEnd(() => {
      savedScale.value = scale.value;
      if (scale.value <= 1.01) resetZoom();
      else clampPan();
      savedTx.value = tx.value;
      savedTy.value = ty.value;
    });

  // Two-finger drag always pans the view.
  const panTwo = Gesture.Pan()
    .minPointers(2)
    .averageTouches(true)
    .onUpdate((e) => {
      tx.value = savedTx.value + e.translationX;
      ty.value = savedTy.value + e.translationY;
    })
    .onEnd(() => {
      clampPan();
      savedTx.value = tx.value;
      savedTy.value = ty.value;
    });

  // One-finger drag: pans when control is OFF, drives the mouse when control is ON.
  const panOne = Gesture.Pan()
    .minPointers(1)
    .maxPointers(1)
    .onUpdate((e) => {
      if (controlOn) {
        runOnJS(sendPointer)(e.x, e.y, false);
      } else {
        tx.value = savedTx.value + e.translationX;
        ty.value = savedTy.value + e.translationY;
      }
    })
    .onEnd(() => {
      if (!controlOn) {
        clampPan();
        savedTx.value = tx.value;
        savedTy.value = ty.value;
      }
    });

  const singleTap = Gesture.Tap()
    .maxDuration(250)
    .onEnd((e) => {
      if (controlOn) runOnJS(sendPointer)(e.x, e.y, true);
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd((e) => {
      if (scale.value > 1.01) {
        resetZoom();
      } else {
        // zoom toward the tapped point
        const w = stageW.value;
        const h = stageH.value;
        const target = 2.5;
        scale.value = withTiming(target);
        savedScale.value = target;
        tx.value = withTiming((w / 2 - e.x) * (target - 1));
        ty.value = withTiming((h / 2 - e.y) * (target - 1));
        savedTx.value = (w / 2 - e.x) * (target - 1);
        savedTy.value = (h / 2 - e.y) * (target - 1);
      }
    });

  const composed = Gesture.Exclusive(doubleTap, Gesture.Simultaneous(pinch, panTwo, panOne), singleTap);

  const animStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: scale.value }]
  }));

  const toggleControl = () => {
    const next = !controlOn;
    setControlOn(next);
    session.setControlActive(next);
  };

  return (
    <View style={styles.screen}>
      <GestureDetector gesture={composed}>
        <View
          style={styles.stage}
          onLayout={(e) => {
            stageW.value = e.nativeEvent.layout.width;
            stageH.value = e.nativeEvent.layout.height;
          }}
        >
          {st.remoteStream ? (
            <Animated.View style={[StyleSheet.absoluteFill, animStyle]}>
              <RTCView
                streamURL={(st.remoteStream as unknown as { toURL: () => string }).toURL()}
                style={StyleSheet.absoluteFill}
                objectFit="contain"
              />
            </Animated.View>
          ) : (
            <View style={styles.placeholder}>
              {connecting && <ActivityIndicator color={colors.accent} size="large" />}
              <Text style={styles.placeholderText}>{st.message || "Bağlanılıyor…"}</Text>
            </View>
          )}
        </View>
      </GestureDetector>

      <View style={styles.toolbar}>
        <Text style={styles.peer} numberOfLines={1}>
          {st.peerName ?? "Cihaz"} · {active ? "canlı" : st.phase}
        </Text>
        <View style={{ flexDirection: "row", gap: 8 }}>
          {st.controlOffered && (
            <TouchableOpacity style={[styles.tbBtn, controlOn && styles.tbBtnOn]} onPress={toggleControl}>
              <Text style={styles.tbBtnText}>{controlOn ? "Denetim açık" : "Denetim"}</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={[styles.tbBtn, styles.endBtn]} onPress={() => session.endSession()}>
            <Text style={styles.tbBtnText}>Bitir</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#000" },
  stage: { flex: 1, backgroundColor: "#000", overflow: "hidden" },
  placeholder: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    gap: 16
  },
  placeholderText: { color: colors.textDim, fontSize: 15, textAlign: "center", paddingHorizontal: 30 },
  toolbar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: "rgba(15,17,21,0.82)",
    gap: 10
  },
  peer: { color: colors.text, fontSize: 12, flex: 1 },
  tbBtn: {
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 7,
    backgroundColor: "rgba(32,36,46,0.9)"
  },
  tbBtnOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  endBtn: { backgroundColor: colors.accentDim, borderColor: colors.accentDim },
  tbBtnText: { color: colors.text, fontSize: 12, fontWeight: "600" }
});
