import { StyleSheet } from "react-native";

export const colors = {
  bg: "#0f1115",
  surface: "#181b22",
  surfaceAlt: "#20242e",
  border: "#2b303c",
  text: "#e8eaf0",
  textDim: "#9aa1b1",
  accent: "#ff4736",
  accentDim: "#c9372b",
  good: "#3ec96b",
  warn: "#e8b23e",
  bad: "#e8503e"
};

export const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  pad: { padding: 20 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  h1: { color: colors.text, fontSize: 26, fontWeight: "700" },
  h2: { color: colors.text, fontSize: 18, fontWeight: "600" },
  p: { color: colors.textDim, fontSize: 14, lineHeight: 20 },
  label: { color: colors.textDim, fontSize: 13, marginBottom: 6, marginTop: 14 },
  input: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: colors.text,
    fontSize: 16
  },
  button: {
    backgroundColor: colors.accent,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 20
  },
  buttonText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  buttonGhost: {
    backgroundColor: "transparent",
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: "center",
    marginTop: 12
  },
  buttonGhostText: { color: colors.text, fontSize: 15, fontWeight: "600" },
  link: { color: colors.accent, fontSize: 14, marginTop: 18, textAlign: "center" },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 14,
    padding: 16,
    marginBottom: 12
  },
  error: { color: colors.bad, fontSize: 13, marginTop: 12 },
  codeBig: { color: colors.text, fontSize: 30, fontWeight: "800", letterSpacing: 4, textAlign: "center" }
});
