const corsHeaders = {
  "Access-Control-Allow-Origin": "https://ikjoo123.github.io",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Credentials": "true",
};

const MAX_STORAGE = 9 * 1024 * 1024 * 1024; // 9GB
const LARGE_FILE_SIZE = 100 * 1024 * 1024; // 100MB

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders,
      ...extraHeaders,
    },
  });
}

function errorResponse(message, status = 400) {
  return jsonResponse({ error: message }, status);
}

function base64urlEncode(data) {
  return btoa(data)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64urlDecode(data) {
  data = data.replace(/-/g, "+").replace(/_/g, "/");
  while (data.length % 4) data += "=";
  return atob(data);
}

async function makeSignature(payload, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload)
  );

  const bytes = new Uint8Array(signature);
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return base64urlEncode(binary);
}

async function createSession(username, secret) {
  const exp = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7;

  const payload = base64urlEncode(
    JSON.stringify({
      user: username,
      exp,
    })
  );

  const signature = await makeSignature(payload, secret);

  return `${payload}.${signature}`;
}

async function verifySession(request, env) {
  const cookie = request.headers.get("Cookie") || "";

  const match = cookie.match(/(?:^|;\s*)session=([^;]+)/);

  if (!match) {
    return false;
  }

  const token = match[1];
  const parts = token.split(".");

  if (parts.length !== 2) {
    return false;
  }

  const [payload, signature] = parts;

  try {
    const expected = await makeSignature(payload, env.AUTH_PASSWORD);

    if (signature !== expected) {
      return false;
    }

    const data = JSON.parse(base64urlDecode(payload));

    if (!data.exp || data.exp < Math.floor(Date.now() / 1000)) {
      return false;
    }

    return data.user === env.AUTH_USER;
  } catch {
    return false;
  }
}

function authCookie(token) {
  return `session=${token}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=604800`;
}

function clearAuthCookie() {
  return "session=; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=0";
}

async function getStorageUsage(env) {
  let cursor;
  let total = 0;

  do {
    const options = {
      limit: 1000,
    };

    if (cursor) {
      options.cursor = cursor;
    }

    const result = await env.FILES.list(options);

    for (const object of result.objects) {
      total += object.size || 0;
    }

    cursor = result.truncated ? result.cursor : undefined;
  } while (cursor);

  return total;
}

function getOriginalName(object) {
  if (object.customMetadata?.originalName) {
    return object.customMetadata.originalName;
  }

  const name = object.key.split("/").pop();

  return name.replace(/^\d+-/, "");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    // 로그인
    if (url.pathname === "/api/login" && request.method === "POST") {
      try {
        const body = await request.json();

        if (
          body.username !== env.AUTH_USER ||
          body.password !== env.AUTH_PASSWORD
        ) {
          return errorResponse("아이디 또는 비밀번호가 틀렸습니다.", 401);
        }

        const token = await createSession(
          env.AUTH_USER,
          env.AUTH_PASSWORD
        );

        return jsonResponse(
          { ok: true },
          200,
          {
            "Set-Cookie": authCookie(token),
          }
        );
      } catch {
        return errorResponse("로그인 요청이 잘못되었습니다.", 400);
      }
    }

    // 로그아웃
    if (url.pathname === "/api/logout" && request.method === "POST") {
      return jsonResponse(
        { ok: true },
        200,
        {
          "Set-Cookie": clearAuthCookie(),
        }
      );
    }
// 임시 인증 진단
if (url.pathname === "/api/debug-auth" && request.method === "GET") {
  return jsonResponse({
    authUserExists: !!env.AUTH_USER,
    authUserLength: env.AUTH_USER ? env.AUTH_USER.length : 0,
    authPasswordExists: !!env.AUTH_PASSWORD,
    authPasswordLength: env.AUTH_PASSWORD ? env.AUTH_PASSWORD.length : 0,
  });
}
    // 로그인 상태 확인
    if (url.pathname === "/api/me" && request.method === "GET") {
      const authenticated = await verifySession(request, env);

      if (!authenticated) {
        return errorResponse("로그인이 필요합니다.", 401);
      }

      return jsonResponse({
        authenticated: true,
        user: env.AUTH_USER,
      });
    }

    // 여기부터 모든 파일 관련 API는 로그인 필요
    const authenticated = await verifySession(request, env);

    if (!authenticated) {
      return errorResponse("로그인이 필요합니다.", 401);
    }

    // 파일 목록
    if (url.pathname === "/api/files" && request.method === "GET") {
      const prefix = url.searchParams.get("prefix") || "";

      const result = await env.FILES.list({
        prefix,
        delimiter: "/",
        limit: 1000,
      });

      const folders = result.delimitedPrefixes.map((folder) => ({
        type: "folder",
        name: folder
          .slice(prefix.length)
          .replace(/\/$/, ""),
        prefix: folder,
      }));

      const files = result.objects
        .filter((object) => object.key !== prefix)
        .map((object) => ({
          type: "file",
          key: object.key,
          name: getOriginalName(object),
          size: object.size,
          uploaded: object.uploaded,
        }));

      return jsonResponse({
        folders,
        files,
      });
    }

    // 파일 업로드
    if (url.pathname === "/api/upload" && request.method === "POST") {
      const formData = await request.formData();

      const file = formData.get("file");
      const folder = formData.get("folder") || "";
      const confirmedLarge =
        formData.get("confirmedLarge") === "true";

      if (!(file instanceof File)) {
        return errorResponse("파일이 없습니다.");
      }

      // 100MB 이상 파일
      if (file.size >= LARGE_FILE_SIZE && !confirmedLarge) {
        return errorResponse(
          "100MB 이상 파일은 업로드 확인이 필요합니다.",
          413
        );
      }

      // 현재 저장공간 확인
      const currentUsage = await getStorageUsage(env);

      // 9GB 도달 또는 초과 방지
      if (currentUsage >= MAX_STORAGE) {
        return errorResponse(
          "저장공간이 9GB에 도달하여 더 이상 업로드할 수 없습니다.",
          413
        );
      }

      if (currentUsage + file.size >= MAX_STORAGE) {
        return errorResponse(
          "이 파일을 업로드하면 저장공간 9GB를 초과하므로 업로드할 수 없습니다.",
          413
        );
      }

      let safeFolder = String(folder).replace(/^\/+|\/+$/g, "");

      const key = safeFolder
        ? `${safeFolder}/${Date.now()}-${file.name}`
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
        ok: true,
        key,
        name: file.name,
        size: file.size,
      });
    }

    // 폴더 생성
    if (url.pathname === "/api/folder" && request.method === "POST") {
      const body = await request.json();

      const parent = String(body.parent || "").replace(
        /^\/+|\/+$/g,
        ""
      );

      const name = String(body.name || "").trim();

      if (!name) {
        return errorResponse("폴더 이름을 입력하세요.");
      }

      if (
        name.includes("/") ||
        name.includes("\\") ||
        name === "." ||
        name === ".."
      ) {
        return errorResponse("사용할 수 없는 폴더 이름입니다.");
      }

      const prefix = parent
        ? `${parent}/${name}/`
        : `${name}/`;

      await env.FILES.put(prefix, new Uint8Array(0), {
        customMetadata: {
          folder: "true",
        },
      });

      return jsonResponse({
        ok: true,
        prefix,
      });
    }

    // 파일 삭제
    if (url.pathname === "/api/file" && request.method === "DELETE") {
      const key = url.searchParams.get("key");

      if (!key) {
        return errorResponse("파일 키가 없습니다.");
      }

      await env.FILES.delete(key);

      return jsonResponse({
        ok: true,
      });
    }

    // 폴더 삭제
    if (url.pathname === "/api/folder" && request.method === "DELETE") {
      const prefix = url.searchParams.get("prefix");

      if (!prefix) {
        return errorResponse("폴더 경로가 없습니다.");
      }

      let cursor;

      do {
        const options = {
          prefix,
          limit: 1000,
        };

        if (cursor) {
          options.cursor = cursor;
        }

        const result = await env.FILES.list(options);

        if (result.objects.length > 0) {
          await env.FILES.delete(
            result.objects.map((object) => object.key)
          );
        }

        cursor = result.truncated
          ? result.cursor
          : undefined;
      } while (cursor);

      return jsonResponse({
        ok: true,
      });
    }

    // 파일 다운로드
    if (
      url.pathname === "/api/download" &&
      request.method === "GET"
    ) {
      const key = url.searchParams.get("key");

      if (!key) {
        return errorResponse("파일 키가 없습니다.");
      }

      const object = await env.FILES.get(key);

      if (!object) {
        return errorResponse("파일을 찾을 수 없습니다.", 404);
      }

      const filename = getOriginalName(object);

      return new Response(object.body, {
        headers: {
          ...corsHeaders,
          "Content-Type":
            object.httpMetadata?.contentType ||
            "application/octet-stream",
          "Content-Disposition":
            `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        },
      });
    }

    return jsonResponse({
      ok: true,
      message: "API OK",
    });
  },
};
