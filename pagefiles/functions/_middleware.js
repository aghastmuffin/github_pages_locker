export async function onRequest(context) {
  const { request, next } = context;
  const url = new URL(request.url);

  // Debug log
  console.log("Path:", url.pathname);

  // Allow login page
  if (url.pathname === "/login") {
    return next();
  }

  const cookie = request.headers.get("Cookie") || "";

  // STRICT check (important)
  const isAuthed = cookie.includes("auth=valid");

  if (!isAuthed) {
    return Response.redirect(`${url.origin}/login`, 302);
  }

  return next();
}
