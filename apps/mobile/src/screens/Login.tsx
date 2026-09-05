import { useState } from "react";
import { View, Text, TextInput, TouchableOpacity, ActivityIndicator, KeyboardAvoidingView, Platform } from "react-native";
import { login, register, verifyTotp } from "../core/auth";
import { colors, s } from "../theme";

type Mode = "login" | "register" | "totp";

export function Login() {
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [pendingToken, setPendingToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      if (mode === "register") {
        await register(email.trim(), password);
      } else if (mode === "totp") {
        await verifyTotp(pendingToken, code.trim());
      } else {
        const challenge = await login(email.trim(), password);
        if (challenge) {
          setPendingToken(challenge.pendingToken);
          setMode("totp");
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Bir hata oluştu.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={s.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={[s.center]}>
        <View style={{ width: "100%", maxWidth: 380 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <View
              style={{
                width: 40,
                height: 40,
                borderRadius: 10,
                backgroundColor: colors.accent,
                alignItems: "center",
                justifyContent: "center"
              }}
            >
              <Text style={{ color: "#fff", fontWeight: "800", fontSize: 20 }}>K</Text>
            </View>
            <Text style={s.h1}>Kenet</Text>
          </View>
          <Text style={s.p}>
            {mode === "register"
              ? "Yeni bir hesap oluştur."
              : mode === "totp"
                ? "Kimlik doğrulama uygulamasındaki 6 haneli kodu gir."
                : "Hesabınla giriş yap ve bilgisayarına bağlan."}
          </Text>

          {mode === "totp" ? (
            <>
              <Text style={s.label}>Doğrulama kodu</Text>
              <TextInput
                style={s.input}
                value={code}
                onChangeText={setCode}
                keyboardType="number-pad"
                placeholder="123456"
                placeholderTextColor={colors.textDim}
                maxLength={6}
                autoFocus
              />
            </>
          ) : (
            <>
              <Text style={s.label}>E-posta</Text>
              <TextInput
                style={s.input}
                value={email}
                onChangeText={setEmail}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                placeholder="ornek@eposta.com"
                placeholderTextColor={colors.textDim}
              />
              <Text style={s.label}>Şifre</Text>
              <TextInput
                style={s.input}
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                placeholder="••••••••"
                placeholderTextColor={colors.textDim}
              />
            </>
          )}

          {error && <Text style={s.error}>{error}</Text>}

          <TouchableOpacity style={s.button} onPress={submit} disabled={busy}>
            {busy ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={s.buttonText}>
                {mode === "register" ? "Kayıt ol" : mode === "totp" ? "Doğrula" : "Giriş yap"}
              </Text>
            )}
          </TouchableOpacity>

          {mode !== "totp" && (
            <TouchableOpacity onPress={() => setMode(mode === "register" ? "login" : "register")}>
              <Text style={s.link}>
                {mode === "register" ? "Zaten hesabın var mı? Giriş yap" : "Hesabın yok mu? Kayıt ol"}
              </Text>
            </TouchableOpacity>
          )}
          {mode === "totp" && (
            <TouchableOpacity onPress={() => setMode("login")}>
              <Text style={s.link}>Geri dön</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}
