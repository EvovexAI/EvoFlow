import { NextResponse } from "next/server";

export function notImplementedJson(endpoint: string) {
  return NextResponse.json(
    {
      endpoint,
      status: "not_implemented",
      message: "This API route is scaffolded and ready for implementation.",
    },
    { status: 501 },
  );
}
