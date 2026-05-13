import { ImageResponse } from "next/og";

export const dynamic = "force-static";

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 32,
          height: 32,
          borderRadius: 8,
          background: "linear-gradient(135deg, #1a1528 0%, #0c0a13 100%)",
        }}
      >
        <span
          style={{
            fontSize: 18,
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
