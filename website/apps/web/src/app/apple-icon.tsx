import { ImageResponse } from "next/og";

export const dynamic = "force-static";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 180,
          height: 180,
          borderRadius: 40,
          background: "linear-gradient(135deg, #1a1528 0%, #0c0a13 100%)",
        }}
      >
        <span
          style={{
            fontSize: 100,
            fontWeight: 800,
            color: "#d0bcff",
            letterSpacing: "-0.04em",
          }}
        >
          C
        </span>
      </div>
    ),
    { ...size },
  );
}
