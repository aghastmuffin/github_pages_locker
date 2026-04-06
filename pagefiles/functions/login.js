export async function onRequest(context) {
  const { request } = context;

  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const formData = await request.formData();
  const password = formData.get("password");

  if (password === "yourpassword") {
    return new Response(null, {
      status: 302,
      headers: {
        "Set-Cookie": "auth=valid; Path=/; HttpOnly; Secure; SameSite=Strict",
        "Location": "/"
      }
    });
  }

  return new Response("Wrong password", { status: 401 });
}
