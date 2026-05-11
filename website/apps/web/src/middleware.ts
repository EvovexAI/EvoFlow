import { NextResponse, type NextRequest } from "next/server";
import { verifyAdminCookie, COOKIE_NAME } from "@/lib/admin-auth";

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname === "/admin/login") {
    return NextResponse.next();
  }

  if (pathname.startsWith("/admin")) {
    const cookieValue = request.cookies.get(COOKIE_NAME)?.value;
    const valid = await verifyAdminCookie(cookieValue);

    if (!valid) {
      const loginUrl = new URL("/admin/login", request.url);
      loginUrl.searchParams.set("from", pathname);
      return NextResponse.redirect(loginUrl);
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/admin/:path*"],
};
