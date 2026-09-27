const corsHeaders = {
  "Access-Control-Allow-Origin": "https://ikjoo123.github.io",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS 사전 요청
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: corsHeaders,
      });
    }

    // 파일 업로드
    if (request.method === "POST" && url.pathname === "/api/upload") {
      const formData = await request.formData();
      const file = formData.get("file");

      if (!file || typeof file === "string") {
        return new Response("파일이 없습니다.", {
          status: 400,
          headers: corsHeaders,
        });
      }

      const key = `${Date.now()}-${file.name}`;

      await env.FILES.put(key, file.stream(), {
        httpMetadata: {
          contentType: file.type || "application/octet-stream",
        },
      });

      return jsonResponse({
        success: true,
        name: file.name,
        key: key,
      });
    }

    // 파일 목록
    if (request.method === "GET" && url.pathname === "/api/files") {
      const list = await env.FILES.list();

      return jsonResponse({
        files: list.objects.map((file) => ({
          key: file.key,
          size: file.size,
          uploaded: file.uploaded,
        })),
      });
    }

    // 파일 다운로드
    if (request.method === "GET" && url.pathname === "/api/download") {
      const key = url.searchParams.get("key");

      if (!key) {
        return new Response("파일명이 없습니다.", {
          status: 400,
          headers: corsHeaders,
        });
      }

      const object = await env.FILES.get(key);

      if (!object) {
        return new Response("파일을 찾을 수 없습니다.", {
          status: 404,
          headers: corsHeaders,
        });
      }

      const headers = new Headers(corsHeaders);

      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);
      headers.set(
        "Content-Disposition",
        `attachment; filename="${encodeURIComponent(key)}"`
      );

      return new Response(object.body, { headers });
    }

    return new Response("API OK", {
      headers: corsHeaders,
    });
  },
};
