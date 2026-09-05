import { useRef, useState } from "react";
import { View, Text, TouchableOpacity, ActivityIndicator, StyleSheet, TextInput, Platform } from "react-native";
import { RTCView } from "react-native-webrtc";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, withTiming, runOnJS } from "react-native-reanimated";
import { session } from "../core/session";
import { charToKeyEvents, keyPress } from "../core/keys";
import { useStore } from "../core/store";
import { colors } from "../theme";

const MAX_SCALE = 6;

export function Session() {
  const st = useStore(session.store, (x) => x);
  const [controlOn, setControlOn] = useState(false);
  const [kbOpen, setKbOpen] = useState(false);
  const [kbSession, setKbSession] = useState(0); // bump to remount the hidden input (clears it)
  const kbRef = useRef<TextInput>(null);
  const kbBuf = useRef(""); // last known text of the hidden input, for diffing

  // pinch-zoom / pan transform + video geometry (shared values so gesture worklets can read them)
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const savedTx = useSharedValue(0);
  const savedTy = useSharedValue(0);
  const stageW = useSharedValue(1);
  const stageH = useSharedValue(1);
  const videoW = useSharedValue(0);
  const videoH = useSharedValue(0);

  const active = st.phase === "active";
  const connecting = st.phase === "connecting" || st.phase === "requesting" || st.phase === "reconnecting";

  /**
   * Screen-space touch -> normalised (0..1) point on the remote desktop.
   * Undoes (a) the user's pinch/pan transform and (b) the "contain" letterboxing of the
   * video inside the stage, so a tap lands exactly where the finger visually is — even
   * on a small target like a checkbox, zoomed in, in portrait with big black bars.
   */
  const toRemoteNorm = (px: number, py: number): { x: number; y: number } => {
    const sw = stageW.value;
    const sh = stageH.value;
    // undo user zoom/pan (transform is around the stage centre)
    const bx = (px - sw / 2 - tx.value) / scale.value + sw / 2;
    const by = (py - sh / 2 - ty.value) / scale.value + sh / 2;
    // the letterboxed rect the video actually occupies inside the stage
    const vw = videoW.value || sw;
    const vh = videoH.value || sh;
    const videoAR = vw / vh;
    const stageAR = sw / sh;
    let rectW = sw;
    let rectH = sh;
    if (videoAR > stageAR) rectH = sw / videoAR;
    else rectW = sh * videoAR;
    return {
      x: Math.min(1, Math.max(0, (bx - (sw - rectW) / 2) / rectW)),
      y: Math.min(1, Math.max(0, (by - (sh - rectH) / 2) / rectH))
    };
  };

  const sendPointer = (px: number, py: number, click: boolean) => {
    const { x, y } = toRemoteNorm(px, py);
    if (click) {
      session.sendControl({ type: "pointer", x, y, button: "left", down: true });
      setTimeout(() => session.sendControl({ type: "pointer", x, y, button: "left", down: false }), 45);
    } else {
      session.sendControl({ type: "pointer", x, y });
    }
  };

  const sendPointerButton = (px: number, py: number, button: "left" | "right" | "middle") => {
    const { x, y } = toRemoteNorm(px, py);
    session.sendControl({ type: "pointer", x, y, button, down: true });
    setTimeout(() => session.sendControl({ type: "pointer", x, y, button, down: false }), 45);
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

  // Single finger tap -> left click (control mode only). runOnJS must be called directly
  // inside the worklet — wrapping it in a plain JS helper crashes on the UI thread.
  const singleTap = Gesture.Tap().onEnd((e) => {
    if (controlOn) runOnJS(sendPointer)(e.x, e.y, true);
  });

  // Two-finger tap -> right click (control mode only).
  const twoFingerTap = Gesture.Tap()
    .minPointers(2)
    .maxDuration(300)
    .onEnd((e) => {
      if (controlOn) runOnJS(sendPointerButton)(e.x, e.y, "right");
    });

  // Double tap -> zoom toward the point / reset. Only when NOT controlling, so a fast
  // double tap in control mode passes straight through as a remote double-click.
  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .enabled(!controlOn)
    .onEnd((e) => {
      if (scale.value > 1.01) {
        resetZoom();
      } else {
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

  const composed = Gesture.Simultaneous(
    pinch,
    panTwo,
    panOne,
    Gesture.Exclusive(doubleTap, twoFingerTap, singleTap)
  );

  const animStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: scale.value }]
  }));

  const toggleControl = () => {
    const next = !controlOn;
    setControlOn(next);
    session.setControlActive(next);
    if (!next) closeKeyboard();
  };

  const openKeyboard = () => {
    kbBuf.current = "";
    setKbSession((n) => n + 1); // fresh (empty) input
    setKbOpen(true);
    setTimeout(() => kbRef.current?.focus(), 60);
  };
  const closeKeyboard = () => {
    setKbOpen(false);
    kbRef.current?.blur();
    kbBuf.current = "";
  };
  const toggleKeyboard = () => (kbOpen ? closeKeyboard() : openKeyboard());

  // Hidden, uncontrolled TextInput driven by the phone keyboard. Diff each change against
  // the last known text: characters added -> remote key events, characters removed ->
  // Backspace. Reset (remount) once it gets long so it can't grow unbounded.
  const onType = (next: string) => {
    const prev = kbBuf.current;
    let p = 0;
    while (p < prev.length && p < next.length && prev[p] === next[p]) p++;
    for (let i = 0; i < prev.length - p; i++) {
      for (const cmd of keyPress("Backspace")) session.sendControl(cmd);
    }
    for (const ch of next.slice(p)) {
      for (const cmd of charToKeyEvents(ch)) session.sendControl(cmd);
    }
    kbBuf.current = next;
    if (next.length > 60) {
      kbBuf.current = "";
      setKbSession((n) => n + 1);
      setTimeout(() => kbRef.current?.focus(), 30);
    }
  };
  const onKbKeyPress = (e: { nativeEvent: { key: string } }) => {
    if (e.nativeEvent.key === "Backspace" && kbBuf.current.length === 0) {
      for (const cmd of keyPress("Backspace")) session.sendControl(cmd);
    }
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
                onDimensionsChange={(e) => {
                  videoW.value = e.nativeEvent.width;
                  videoH.value = e.nativeEvent.height;
                }}
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

      {controlOn && kbOpen && (
        <TextInput
          key={kbSession}
          ref={kbRef}
          defaultValue=""
          onChangeText={onType}
          onKeyPress={onKbKeyPress}
          onSubmitEditing={() => {
            for (const cmd of keyPress("Enter", "Enter")) session.sendControl(cmd);
          }}
          onBlur={() => setKbOpen(false)}
          blurOnSubmit={false}
          multiline={false}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          spellCheck={false}
          keyboardType={Platform.OS === "android" ? "visible-password" : "default"}
          style={styles.hiddenInput}
        />
      )}

      <View style={styles.toolbar}>
        <Text style={styles.peer} numberOfLines={1}>
          {st.peerName ?? "Cihaz"} · {active ? "canlı" : st.phase}
        </Text>
        <View style={{ flexDirection: "row", gap: 8 }}>
          {st.controlOffered && controlOn && (
            <TouchableOpacity style={[styles.tbBtn, kbOpen && styles.tbBtnOn]} onPress={toggleKeyboard}>
              <Text style={styles.tbBtnText}>⌨</Text>
            </TouchableOpacity>
          )}
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
  hiddenInput: { position: "absolute", top: -100, left: 0, width: 1, height: 1, opacity: 0 },
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
