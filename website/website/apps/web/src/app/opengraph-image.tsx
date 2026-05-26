import { siteUrlForDisplay } from "@ai-site/content";
import { ImageResponse } from "next/og";

export const dynamic = "force-static";

export const alt = "EvoFlow — super-agent orchestration";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OGImage() {
  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          width: "100%",
          height: "100%",
          background: "linear-gradient(135deg, #0c0a13 0%, #141020 40%, #0c0a13 100%)",
          color: "#fff",
          fontFamily: "sans-serif",
        }}
      >
        <div
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            width: 500,
            height: 500,
            borderRadius: "50%",
            background: "radial-gradient(circle, rgba(208,188,255,0.12) 0%, transparent 70%)",
          }}
        />

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            marginBottom: 24,
          }}
        >
          <div
            style={{
              width: 10,
              height: 10,
              borderRadius: "50%",
              background: "#d0bcff",
              boxShadow: "0 0 16px rgba(208,188,255,0.6)",
            }}
          />
          <span
            style={{
              fontSize: 14,
              letterSpacing: "0.3em",
              textTransform: "uppercase" as const,
              color: "rgba(208,188,255,0.7)",
            }}
          >
            Living Open Source
          </span>
        </div>

        <h1
          style={{
            fontSize: 72,
            fontWeight: 700,
            letterSpacing: "-0.06em",
            lineHeight: 1,
            margin: 0,
            background: "linear-gradient(180deg, #fff 30%, rgba(255,255,255,0.6) 100%)",
            backgroundClip: "text",
            color: "transparent",
          }}
        >
          EvoFlow
        </h1>

        <p
          style={{
            fontSize: 20,
            color: "rgba(255,255,255,0.5)",
            marginTop: 20,
            letterSpacing: "0.06em",
          }}
        >
          Super-agent orchestration framework
        </p>

        <div
          style={{
            display: "flex",
            gap: 32,
            marginTop: 48,
            fontSize: 13,
            letterSpacing: "0.18em",
            textTransform: "uppercase" as const,
            color: "rgba(208,188,255,0.5)",
          }}
        >
          <span>Agents</span>
          <span>·</span>
          <span>Skills</span>
          <span>·</span>
          <span>Sandbox</span>
          <span>·</span>
          <span>Memory</span>
        </div>

        <div
          style={{
            position: "absolute",
            bottom: 40,
            fontSize: 13,
            color: "rgba(255,255,255,0.25)",
            letterSpacing: "0.15em",
          }}
        >
          {siteUrlForDisplay()}
        </div>
      </div>
    ),
    { ...size },
  );
}
