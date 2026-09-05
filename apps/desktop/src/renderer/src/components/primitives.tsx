import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "subtle" | "ghost" | "danger" | "default";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: "sm" | "md";
  block?: boolean;
  icon?: boolean;
}

export function Button({ variant = "default", size = "md", block, icon, className = "", ...rest }: ButtonProps) {
  const classes = ["btn"];
  if (variant !== "default") classes.push(variant);
  if (size === "sm") classes.push("sm");
  if (block) classes.push("block");
  if (icon) classes.push("icon");
  if (className) classes.push(className);
  return <button className={classes.join(" ")} {...rest} />;
}

interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
}

export function TextField({ label, hint, className = "", id, ...rest }: TextFieldProps) {
  return (
    <div className="field">
      {label && <label htmlFor={id}>{label}</label>}
      <input id={id} className={`input ${className}`} {...rest} />
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

interface SwitchProps {
  checked: boolean;
  onChange: (value: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
}

export function Switch({ checked, onChange, label, disabled }: SwitchProps) {
  return (
    <label className="switch" data-disabled={disabled || undefined}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="track" />
      <span className="thumb" />
      {label && <span>{label}</span>}
    </label>
  );
}

export function Badge({ tone, children }: { tone?: "ok" | "warn" | "bad"; children: ReactNode }) {
  return <span className={`badge ${tone ?? ""}`}>{children}</span>;
}
