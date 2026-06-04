import { backendUnavailableResponse, proxyJsonResponse, resolveBackendBase } from "@/lib/backendProxy";

export async function GET(req: Request) {
  const base = resolveBackendBase();
  const { search } = new URL(req.url);
  try {
    const response = await fetch(`${base}/chat/sessions${search}`, { cache: "no-store" });
    return proxyJsonResponse(response);
  } catch (error) {
    return backendUnavailableResponse(error, "GET /chat/sessions");
  }
}

export async function POST(req: Request) {
  const base = resolveBackendBase();
  try {
    const body = await req.json();
    const response = await fetch(`${base}/chat/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return proxyJsonResponse(response);
  } catch (error) {
    return backendUnavailableResponse(error, "POST /chat/sessions");
  }
}
