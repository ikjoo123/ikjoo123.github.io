const corsHeaders = {
  "Access-Control-Allow-Origin": "https://ikjoo123.github.io",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
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

function errorResponse(message, status = 400) {
  return new Response(message, {
    status,
    headers: corsHeaders,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: corsHeaders,
      });
    }

    // ==========================================
    // 파일 업로드
    // ==========================================
    if (
      request.method === "POST" &&
      url.pathname === "/api/upload"
    ) {
      const formData = await request.formData();

      const file = formData.get("file");
      const folder = formData.get("folder") || "";

      if (!file || typeof file === "string") {
        return errorResponse("파일이 없습니다.");
      }

      // 폴더 경로 정리
      const cleanFolder = String(folder)
        .replace(/^\/+|\/+$/g, "");

      const key =
        cleanFolder
          ? `${cleanFolder}/${Date.now()}-${file.name}`
          : `${Date.now()}-${file.name}`;

      await env.FILES.put(key, file.stream(), {
        httpMetadata: {
          contentType:
            file.type || "application/octet-stream",
        },

        customMetadata: {
          originalName: file.name,
        },
      });

      return jsonResponse({
        success: true,
        name: file.name,
        key: key,
      });
    }

    // ==========================================
    // 파일 / 폴더 목록
    // ==========================================
    if (
      request.method === "GET" &&
      url.pathname === "/api/files"
    ) {
      const prefix = url.searchParams.get("prefix") || "";
      const cursor = url.searchParams.get("cursor") || "";

      const list = await env.FILES.list({
        prefix,
        delimiter: "/",
        limit: 1000,
        ...(cursor ? { cursor } : {}),
      });

      const folders = list.delimitedPrefixes.map(
        (folder) => ({
          key: folder,
          name: folder
            .slice(prefix.length)
            .replace(/\/$/, ""),
        })
      );

      const files = list.objects
        .filter((file) => !file.key.endsWith("/"))
        .map((file) => {

          let name =
            file.customMetadata?.originalName;

          // 기존 파일
          if (!name) {
            name = file.key
              .slice(prefix.length)
              .replace(/^\d+-/, "");
          }

          return {
            key: file.key,
            name,
            size: file.size,
            uploaded: file.uploaded,
          };
        });

      return jsonResponse({
        files,
        folders,
        truncated: list.truncated,
        cursor: list.cursor || null,
      });
    }

    // ==========================================
    // 폴더 생성
    // ==========================================
    if (
      request.method === "POST" &&
      url.pathname === "/api/folder"
    ) {
      const body = await request.json();

      const parent =
        String(body.parent || "")
          .replace(/^\/+|\/+$/g, "");

      const name =
        String(body.name || "").trim();

      if (!name) {
        return errorResponse("폴더 이름이 없습니다.");
      }

      if (
        name.includes("/") ||
        name.includes("\\") ||
        name === "." ||
        name === ".."
      ) {
        return errorResponse(
          "사용할 수 없는 폴더 이름입니다."
        );
      }

      const key =
        parent
          ? `${parent}/${name}/`
          : `${name}/`;

      await env.FILES.put(key, new Uint8Array(0), {
        customMetadata: {
          folder: "true",
        },
      });

      return jsonResponse({
        success: true,
        key,
        name,
      });
    }

    // ==========================================
    // 파일 삭제
    // ==========================================
    if (
      request.method === "DELETE" &&
      url.pathname === "/api/file"
    ) {
      const key = url.searchParams.get("key");

      if (!key) {
        return errorResponse("파일 키가 없습니다.");
      }

      await env.FILES.delete(key);

      return jsonResponse({
        success: true,
      });
    }

    // ==========================================
    // 폴더 삭제
    // 하위 파일/폴더까지 전부 삭제
    // ==========================================
    if (
      request.method === "DELETE" &&
      url.pathname === "/api/folder"
    ) {
      const prefix =
        url.searchParams.get("prefix");

      if (!prefix) {
        return errorResponse(
          "삭제할 폴더가 없습니다."
        );
      }

      let cursor = undefined;
      let deleted = 0;

      do {
        const list = await env.FILES.list({
          prefix,
          limit: 1000,
          ...(cursor ? { cursor } : {}),
        });

        const keys =
          list.objects.map((object) => object.key);

        if (keys.length) {
          await env.FILES.delete(keys);
          deleted += keys.length;
        }

        cursor =
          list.truncated
            ? list.cursor
            : undefined;

      } while (cursor);

      return jsonResponse({
        success: true,
        deleted,
      });
    }

    // ==========================================
    // 파일 다운로드
    // ==========================================
    if (
      request.method === "GET" &&
      url.pathname === "/api/download"
    ) {
      const key =
        url.searchParams.get("key");

      if (!key) {
        return errorResponse(
          "파일명이 없습니다."
        );
      }

      const object =
        await env.FILES.get(key);

      if (!object) {
        return errorResponse(
          "파일을 찾을 수 없습니다.",
          404
        );
      }

      let fileName =
        object.customMetadata?.originalName;

      // 기존 파일
      if (!fileName) {
        const lastName =
          key.split("/").pop();

        fileName =
          lastName.replace(/^\d+-/, "");
      }

      const headers =
        new Headers(corsHeaders);

      object.writeHttpMetadata(headers);

      headers.set(
        "etag",
        object.httpEtag
      );

      headers.set(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`
      );

      return new Response(
        object.body,
        { headers }
      );
    }

    return new Response("API OK", {
      headers: corsHeaders,
    });
  },
};
