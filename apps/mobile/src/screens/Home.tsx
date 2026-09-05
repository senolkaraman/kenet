import { useEffect, useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  RefreshControl,
  ActivityIndicator
} from "react-native";
import type { DeviceRecord } from "../core/protocol";
import { authStore, logout } from "../core/auth";
import { devicesStore, refreshDevices, requestUnattendedTicket } from "../core/devices";
import { session } from "../core/session";
import { useStore } from "../core/store";
import { colors, s } from "../theme";

export function Home() {
  const user = useStore(authStore, (a) => a.user);
  const { devices, loading, error } = useStore(devicesStore, (d) => d);
  const registered = useStore(session.store, (x) => x.registered);
  const message = useStore(session.store, (x) => x.message);
  const [code, setCode] = useState("");

  useEffect(() => {
    void refreshDevices();
  }, []);

  const connectCode = () => {
    session.connectTo(code);
  };

  const connectDevice = async (d: DeviceRecord) => {
    if (!d.online) return;
    session.connectTo(d.id);
  };

  const connectUnattended = async (d: DeviceRecord) => {
    // Minimal prompt-free path: mobile v1 asks for the password inline on the device row.
    // For now just kick off a normal (approval) connection; unattended UI comes next.
    session.connectTo(d.id);
    void requestUnattendedTicket; // referenced — full unattended UI lands in a follow-up
  };

  return (
    <ScrollView
      style={s.screen}
      contentContainerStyle={s.pad}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={refreshDevices} tintColor={colors.textDim} />}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <Text style={s.h1}>Cihazlar</Text>
        <TouchableOpacity onPress={logout}>
          <Text style={{ color: colors.textDim, fontSize: 14 }}>Çıkış</Text>
        </TouchableOpacity>
      </View>
      <Text style={s.p}>{user?.email}</Text>
      <Text style={[s.p, { marginTop: 4, color: registered ? colors.good : colors.warn }]}>
        {registered ? "● Sunucuya bağlı" : "○ Sunucuya bağlanılıyor…"}
      </Text>

      <Text style={s.label}>Cihaz koduyla bağlan</Text>
      <View style={{ flexDirection: "row", gap: 10 }}>
        <TextInput
          style={[s.input, { flex: 1, letterSpacing: 3, fontWeight: "700" }]}
          value={code}
          onChangeText={(t) => setCode(t.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6))}
          autoCapitalize="characters"
          autoCorrect={false}
          placeholder="ABC123"
          placeholderTextColor={colors.textDim}
          maxLength={6}
        />
        <TouchableOpacity
          style={[s.button, { marginTop: 0, justifyContent: "center", paddingHorizontal: 20 }]}
          onPress={connectCode}
        >
          <Text style={s.buttonText}>Bağlan</Text>
        </TouchableOpacity>
      </View>

      {message ? <Text style={[s.p, { marginTop: 12 }]}>{message}</Text> : null}

      <Text style={[s.label, { marginTop: 24 }]}>Kayıtlı cihazlar</Text>
      {loading && devices.length === 0 && <ActivityIndicator color={colors.textDim} style={{ marginTop: 16 }} />}
      {error && <Text style={s.error}>{error}</Text>}
      {!loading && devices.length === 0 && !error && (
        <Text style={s.p}>Henüz cihaz yok. Bilgisayarına Kenet uygulamasını kur.</Text>
      )}

      {devices.map((d) => (
        <View key={d.id} style={s.card}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
            <View style={{ flex: 1 }}>
              <Text style={s.h2}>{d.name || d.id}</Text>
              <Text style={[s.p, { marginTop: 2 }]}>
                {d.id} · {d.online ? "çevrimiçi" : "çevrimdışı"}
              </Text>
            </View>
            <View
              style={{
                width: 10,
                height: 10,
                borderRadius: 5,
                backgroundColor: d.online ? colors.good : colors.border
              }}
            />
          </View>
          <TouchableOpacity
            style={[d.online ? s.button : s.buttonGhost, { marginTop: 12 }]}
            onPress={() => (d.unattendedEnabled ? connectUnattended(d) : connectDevice(d))}
            disabled={!d.online}
          >
            <Text style={d.online ? s.buttonText : s.buttonGhostText}>
              {d.online ? "Bağlan" : "Çevrimdışı"}
            </Text>
          </TouchableOpacity>
        </View>
      ))}
    </ScrollView>
  );
}
