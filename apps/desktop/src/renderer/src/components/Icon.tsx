import type { SVGProps } from "react";

const paths: Record<string, string> = {
  link: "M9 15L15 9M10.5 6.5L12 5a4.95 4.95 0 017 7l-1.5 1.5M13.5 17.5L12 19a4.95 4.95 0 01-7-7l1.5-1.5",
  copy: "M9 9h10v10H9zM5 15H4a1 1 0 01-1-1V4a1 1 0 011-1h10a1 1 0 011 1v1",
  monitor: "M3 4h18v12H3zM8 20h8M12 16v4",
  fullscreen: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
  minimize: "M8 4v4H4M16 4v4h4M8 20v-4H4M16 20v-4h4",
  keyboard: "M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10",
  clipboard: "M9 4h6v3H9zM7 5H5v15h14V5h-2M9 12h6M9 16h4",
  chat: "M4 5h16v10H9l-5 4z",
  file: "M13 3H6v18h12V8zM13 3v5h5",
  gear: "M12 9a3 3 0 100 6 3 3 0 000-6zM19.4 13a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-2.7 1.1V21a2 2 0 01-4 0v-.2A1.6 1.6 0 006 19.4l-.1.1a2 2 0 11-2.8-2.8l.1-.1A1.6 1.6 0 003 13H2.8a2 2 0 010-4H3a1.6 1.6 0 001.5-2.7l-.1-.1a2 2 0 112.8-2.8l.1.1A1.6 1.6 0 0011 3.8V3a2 2 0 014 0v.2A1.6 1.6 0 0021 5.5l-.1.1A1.6 1.6 0 0021.2 11H21a2 2 0 010 4z",
  power: "M12 4v8M7.5 7a7 7 0 109 0",
  star: "M12 3l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.6 9.1l5.8-.8z",
  x: "M6 6l12 12M18 6L6 18",
  send: "M4 12l16-7-7 16-2-7z",
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z",
  cursor: "M5 3l14 7-6 2-2 6z",
  bolt: "M13 3L4 14h7l-1 7 9-11h-7z",
  wifi: "M5 12a10 10 0 0114 0M8.5 15.5a5 5 0 017 0M12 19h.01",
  refresh: "M4 10a8 8 0 0114-4l2 2M20 14a8 8 0 01-14 4l-2-2M20 4v4h-4M4 20v-4h4",
  sun: "M12 7a5 5 0 100 10 5 5 0 000-10zM12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19",
  moon: "M20 14a8 8 0 01-10-10 8 8 0 100 16 8 8 0 0010-6z",
  plus: "M12 5v14M5 12h14",
  arrowRight: "M5 12h14M13 6l6 6-6 6",
  arrowLeft: "M19 12H5M11 6l-6 6 6 6",
  folder: "M3 6h6l2 2h10v11H3z",
  download: "M12 3v12M7 10l5 5 5-5M5 21h14",
  upload: "M12 21V9M7 14l5-5 5 5M5 3h14",
  pencil: "M4 20l1-4L16 5l3 3L8 19l-4 1z M14 7l3 3",
  record: "M12 12m-8 0a8 8 0 1016 0 8 8 0 10-16 0"
};

interface IconProps extends SVGProps<SVGSVGElement> {
  name: keyof typeof paths | string;
  size?: number;
}

export function Icon({ name, size = 18, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      <path d={paths[name] ?? ""} />
    </svg>
  );
}
