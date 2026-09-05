import { useEffect } from "react";
import { View, Text, ActivityIndicator, StatusBar } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { authStore, bootstrapAuth } from "./src/core/auth";
import { loadConfig } from "./src/core/config";
import { session } from "./src/core/session";
import { useStore } from "./src/core/store";
import { Login } from "./src/screens/Login";
import { Home } from "./src/screens/Home";
import { Session } from "./src/screens/Session";
import { colors } from "./src/theme";

export default function App() {
  const status = useStore(authStore, (a) => a.status);
  const phase = useStore(session.store, (x) => x.phase);

  useEffect(() => {
    void (async () => {
      await loadConfig();
      await bootstrapAuth();
    })();
  }, []);

  useEffect(() => {
    if (status === "signedIn") session.start();
  }, [status]);

  const inSession = ["requesting", "connecting", "reconnecting", "active"].includes(phase);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StatusBar barStyle="light-content" backgroundColor={colors.bg} hidden={inSession} />
        <SafeAreaView
          style={{ flex: 1, backgroundColor: inSession ? "#000" : colors.bg }}
          edges={inSession ? ["bottom"] : ["top", "bottom"]}
        >
          {status === "loading" ? (
            <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
              <ActivityIndicator color={colors.accent} size="large" />
              <Text style={{ color: colors.textDim, marginTop: 12 }}>Yükleniyor…</Text>
            </View>
          ) : status !== "signedIn" ? (
            <Login />
          ) : inSession ? (
            <Session />
          ) : (
            <Home />
          )}
        </SafeAreaView>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
