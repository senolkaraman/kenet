import { useRef, useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
  TextInput,
  Platform,
  ScrollView
} from "react-native";
import { RTCView } from "react-native-webrtc";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, withTiming, runOnJS } from "react-native-reanimated";
import * as Clipboard from "expo-clipboard";
import { session } from "../core/session";
import { charToKeyEvents, keyPress, keyWithMods, comboCmd } from "../core/keys";
import { useStore } from "../core/store";
import { colors } from "../theme";

const MAX_SCALE = 6;
const MODS = ["Control", "Alt", "Shift", "Meta"] as const;
const MOD_LABEL: Record<string, string> = { Control: "Ctrl", Alt: "Alt", Shift: "⇧", Meta: "⊞" };

function KeyBtn({ label, on, onPress }: { label: string; on?: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity style={[styles.key, on && styles.keyOn]} onPress={onPress}>
      <Text style={styles.keyText}>{label}</Text>
    </TouchableOpacity>
  );
}

export function Session() {
  const st = useStore(session.store, (x) => x);
  const [controlOn, setControlOn] = useState(false);
  const [kbOpen, setKbOpen] = useState(false);
  const [kbSession, setKbSession] = useState(0);
  const [keysBar, setKeysBar] = useState(false);
  const [mods, setMods] = useState<string[]>([]);
  const [moreKeys, setMoreKeys] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const kbRef = useRef<TextInput>(null);
  const kbBuf = useRef("");
  const modsRef = useRef<string[]>([]);
  modsRef.current = mods;
  const scrollAccum = useRef({ x: 0, y: 0 });

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
  const scrollPrevX = useSharedValue(0);
  const scrollPrevY = useSharedValue(0);

  const active = st.phase === "active";
  const connecting = st.phase === "connecting" || st.phase === "requesting" || st.phase === "reconnecting";

  const flash = (m: string) => {
    setToast(m);
    setTimeout(() => setToast(null), 1800);
  };

  const toRemoteNorm = (px: number, py: number): { x: number; y: number } => {
    const sw = stageW.value;
    const sh = stageH.value;
    const bx = (px - sw / 2 - tx.value) / scale.value + sw / 2;
    const by = (py - sh / 2 - ty.value) / scale.value + sh / 2;
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

  const clearMods = () => {
    if (modsRef.current.length) setMods([]);
  };

  const sendPointer = (px: number, py: number, click: boolean) => {
    const { x, y } = toRemoteNorm(px, py);
    if (click) {
      const m = modsRef.current;
      m.forEach((mod) => session.sendControl({ type: "key", key: mod, code: "", down: true, modifiers: [] }));
      session.sendControl({ type: "pointer", x, y, button: "left", down: true });
      setTimeout(() => {
        session.sendControl({ type: "pointer", x, y, button: "left", down: false });
        [...m].reverse().forEach((mod) =>
          session.sendControl({ type: "key", key: mod, code: "", down: false, modifiers: [] })
        );
      }, 45);
      clearMods();
    } else {
      session.sendControl({ type: "pointer", x, y });
    }
  };

  const sendPointerButton = (px: number, py: number, button: "left" | "right" | "middle") => {
    const { x, y } = toRemoteNorm(px, py);
    session.sendControl({ type: "pointer", x, y, button, down: true });
    setTimeout(() => session.sendControl({ type: "pointer", x, y, button, down: false }), 45);
  };

  // Explicit double-click: two clicks at the *same* remote coordinate, close together, so
  // Windows registers it (a fast finger double-tap otherwise lands two clicks a few pixels
  // apart and opens nothing).
  const sendDoubleClick = (px: number, py: number) => {
    const { x, y } = toRemoteNorm(px, py);
    const clickAt = () => {
      session.sendControl({ type: "pointer", x, y, button: "left", down: true });
      setTimeout(() => session.sendControl({ type: "pointer", x, y, button: "left", down: false }), 25);
    };
    clickAt();
    setTimeout(clickAt, 90);
  };

  // Drag: long-press holds the left button down, then finger movement drags, lifting releases.
  const startDrag = (px: number, py: number) => {
    const { x, y } = toRemoteNorm(px, py);
    session.sendControl({ type: "pointer", x, y, button: "left", down: true });
  };
  const dragMove = (px: number, py: number) => {
    const { x, y } = toRemoteNorm(px, py);
    session.sendControl({ type: "pointer", x, y });
  };
  const endDrag = (px: number, py: number) => {
    const { x, y } = toRemoteNorm(px, py);
    session.sendControl({ type: "pointer", x, y, button: "left", down: false });
  };

  // Two-finger drag delta (px) -> mouse-wheel notches. Accumulate the fraction so slow
  // drags aren't lost to rounding. Finger down => wheel down (mouse-wheel convention).
  const sendScroll = (px: number, py: number, dxPx: number, dyPx: number) => {
    scrollAccum.current.y += dyPx * 0.02;
    scrollAccum.current.x += dxPx * 0.02;
    const ny = Math.trunc(scrollAccum.current.y);
    const nx = Math.trunc(scrollAccum.current.x);
    if (!nx && !ny) return;
    scrollAccum.current.y -= ny;
    scrollAccum.current.x -= nx;
    const { x, y } = toRemoteNorm(px, py);
    session.sendControl({ type: "scroll", x, y, dx: nx, dy: ny });
  };

  // named key from the shortcut bar
  const fireKey = (key: string, code = "") => {
    for (const cmd of keyWithMods(key, modsRef.current, code)) session.sendControl(cmd);
    clearMods();
  };
  const fireCombo = (keys: string[]) => {
    session.sendControl(comboCmd(keys));
    clearMods();
  };

  const toggleMod = (mod: string) => setMods((cur) => (cur.includes(mod) ? cur.filter((m) => m !== mod) : [...cur, mod]));

  // ---------- clipboard ----------
  const pushClipboard = async () => {
    const text = await Clipboard.getStringAsync();
    if (!text) return flash("Telefon panosu boş");
    session.sendClipboardText(text);
    flash("Pano PC'ye gönderildi");
  };
  const pullClipboard = async () => {
    if (!st.remoteClipboard) return flash("PC panosu boş");
    await Clipboard.setStringAsync(st.remoteClipboard);
    flash("PC panosu telefona kopyalandı");
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

  // Two-finger drag: scroll wheel when controlling, pan the zoomed view otherwise.
  const panTwo = Gesture.Pan()
    .minPointers(2)
    .averageTouches(true)
    .onStart(() => {
      scrollPrevX.value = 0;
      scrollPrevY.value = 0;
    })
    .onUpdate((e) => {
      if (controlOn) {
        const dY = e.translationY - scrollPrevY.value;
        const dX = e.translationX - scrollPrevX.value;
        scrollPrevY.value = e.translationY;
        scrollPrevX.value = e.translationX;
        if (dY !== 0 || dX !== 0) runOnJS(sendScroll)(e.x, e.y, dX, dY);
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

  // Hold, then drag — a real button-held drag on the remote (move windows, select text,
  // drag & drop). Only when controlling; a quick drag still just moves the cursor.
  const dragPan = Gesture.Pan()
    .minPointers(1)
    .maxPointers(1)
    .enabled(controlOn)
    .activateAfterLongPress(350)
    .onStart((e) => runOnJS(startDrag)(e.x, e.y))
    .onUpdate((e) => runOnJS(dragMove)(e.x, e.y))
    .onEnd((e) => runOnJS(endDrag)(e.x, e.y));

  const singleTap = Gesture.Tap()
    .maxDuration(220)
    .onEnd((e) => {
      if (controlOn) runOnJS(sendPointer)(e.x, e.y, true);
    });

  const twoFingerTap = Gesture.Tap()
    .minPointers(2)
    .maxDuration(300)
    .onEnd((e) => {
      if (controlOn) runOnJS(sendPointerButton)(e.x, e.y, "right");
    });

  // Double tap: a real remote double-click when controlling (open files/folders), or
  // zoom-to-point / reset when just viewing.
  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .maxDelay(280)
    .onEnd((e) => {
      if (controlOn) {
        runOnJS(sendDoubleClick)(e.x, e.y);
        return;
      }
      if (scale.value > 1.01) resetZoom();
      else {
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
    Gesture.Exclusive(dragPan, panOne),
    Gesture.Exclusive(doubleTap, twoFingerTap, singleTap)
  );

  const animStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: scale.value }]
  }));

  const toggleControl = () => {
    const next = !controlOn;
    setControlOn(next);
    session.setControlActive(next);
    setKeysBar(next);
    if (!next) {
      closeKeyboard();
      setMods([]);
    }
  };

  const openKeyboard = () => {
    kbBuf.current = "";
    setKbSession((n) => n + 1);
    setKbOpen(true);
    setTimeout(() => kbRef.current?.focus(), 60);
  };
  const closeKeyboard = () => {
    setKbOpen(false);
    kbRef.current?.blur();
    kbBuf.current = "";
  };
  const toggleKeyboard = () => (kbOpen ? closeKeyboard() : openKeyboard());

  const onType = (next: string) => {
    const prev = kbBuf.current;
    let p = 0;
    while (p < prev.length && p < next.length && prev[p] === next[p]) p++;
    for (let i = 0; i < prev.length - p; i++) {
      for (const cmd of keyPress("Backspace")) session.sendControl(cmd);
    }
    for (const ch of next.slice(p)) {
      for (const cmd of keyWithMods(ch, modsRef.current)) session.sendControl(cmd);
      clearMods();
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

      {toast && (
        <View style={styles.toast}>
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      )}

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

      {controlOn && keysBar && (
        <View style={styles.keysWrap}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.keysRow}>
            <KeyBtn label="Esc" onPress={() => fireKey("Escape")} />
            <KeyBtn label="Tab" onPress={() => fireKey("Tab", "Tab")} />
            {MODS.map((m) => (
              <KeyBtn key={m} label={MOD_LABEL[m]} on={mods.includes(m)} onPress={() => toggleMod(m)} />
            ))}
            <KeyBtn label="←" onPress={() => fireKey("ArrowLeft")} />
            <KeyBtn label="↑" onPress={() => fireKey("ArrowUp")} />
            <KeyBtn label="↓" onPress={() => fireKey("ArrowDown")} />
            <KeyBtn label="→" onPress={() => fireKey("ArrowRight")} />
            <KeyBtn label="⌫" onPress={() => fireKey("Backspace")} />
            <KeyBtn label="⏎" onPress={() => fireKey("Enter", "Enter")} />
            <KeyBtn label="Ctrl+Alt+Del" onPress={() => fireCombo(["Control", "Alt", "Delete"])} />
            <KeyBtn label={moreKeys ? "Az" : "Daha"} onPress={() => setMoreKeys((v) => !v)} />
          </ScrollView>
          {moreKeys && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.keysRow}>
              {["Home", "End", "PageUp", "PageDown", "Delete", "Insert"].map((k) => (
                <KeyBtn key={k} label={k} onPress={() => fireKey(k)} />
              ))}
              {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => (
                <KeyBtn key={n} label={`F${n}`} onPress={() => fireKey(`F${n}`, `F${n}`)} />
              ))}
              <KeyBtn label="📋→PC" onPress={pushClipboard} />
              <KeyBtn label="PC→📋" onPress={pullClipboard} />
            </ScrollView>
          )}
        </View>
      )}

      <View style={styles.toolbar}>
        <Text style={styles.peer} numberOfLines={1}>
          {st.peerName ?? "Cihaz"} · {active ? "canlı" : st.phase}
        </Text>
        <View style={{ flexDirection: "row", gap: 8 }}>
          {st.controlOffered && controlOn && (
            <TouchableOpacity style={[styles.tbBtn, keysBar && styles.tbBtnOn]} onPress={() => setKeysBar((v) => !v)}>
              <Text style={styles.tbBtnText}>Tuşlar</Text>
            </TouchableOpacity>
          )}
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
  toast: {
    position: "absolute",
    top: 16,
    alignSelf: "center",
    backgroundColor: "rgba(15,17,21,0.92)",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 8
  },
  toastText: { color: colors.text, fontSize: 13 },
  keysWrap: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 46,
    backgroundColor: "rgba(15,17,21,0.9)",
    paddingVertical: 6
  },
  keysRow: { flexDirection: "row", gap: 6, paddingHorizontal: 8, alignItems: "center" },
  key: {
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: "rgba(32,36,46,0.95)",
    minWidth: 36,
    alignItems: "center"
  },
  keyOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  keyText: { color: colors.text, fontSize: 13, fontWeight: "600" },
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
