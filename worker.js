const corsHeaders = {
"Access-Control-Allow-Origin": "https://ikjoo123.github.io",
"Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
"Access-Control-Allow-Headers": "Content-Type, Authorization",
"Access-Control-Max-Age": "86400"
};

const MAX_STORAGE = 9 * 1024 * 1024 * 1024;
const LARGE_FILE_SIZE = 100 * 1024 * 1024;
const NOTES_PREFIX = "**notes**/";

function jsonResponse(data, status, extraHeaders) {
if (status === undefined) status = 200;
if (!extraHeaders) extraHeaders = {};

return new Response(JSON.stringify(data), {
status: status,
headers: Object.assign(
{
"Content-Type": "application/json; charset=utf-8"
},
corsHeaders,
extraHeaders
)
});
}

function errorResponse(message, status) {
if (status === undefined) status = 400;
return jsonResponse({ error: message }, status);
}

function base64urlEncode(data) {
return btoa(data)
.replace(/+/g, "-")
.replace(///g, "_")
.replace(/=+$/, "");
}

function base64urlDecode(data) {
data = data.replace(/-/g, "+").replace(/_/g, "/");

while (data.length % 4) {
data += "=";
}

return atob(data);
}

async function makeSignature(payload, secret) {
const key = await crypto.subtle.importKey(
"raw",
new TextEncoder().encode(secret),
{
name: "HMAC",
hash: "SHA-256"
},
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

async function createToken(username, secret) {
const exp =
Math.floor(Date.now() / 1000) +
60 * 60 * 24 * 7;

const payload = base64urlEncode(
JSON.stringify({
user: username,
exp: exp
})
);

const signature = await makeSignature(
payload,
secret
);

return payload + "." + signature;
}

async function verifyToken(request, env) {
const auth =
request.headers.get("Authorization") || "";

if (!auth.startsWith("Bearer ")) {
return false;
}

const token = auth.slice(7).trim();

if (!token) {
return false;
}

const parts = token.split(".");

if (parts.length !== 2) {
return false;
}

const payload = parts[0];
const signature = parts[1];

try {
const expected = await makeSignature(
payload,
env.AUTH_PASSWORD
);

```
if (signature !== expected) {
  return false;
}

const data = JSON.parse(
  base64urlDecode(payload)
);

if (
  !data.exp ||
  data.exp < Math.floor(Date.now() / 1000)
) {
  return false;
}

return data.user === env.AUTH_USER;
```

} catch (error) {
return false;
}
}

async function getStorageUsage(env) {
let cursor;
let total = 0;

do {
const options = {
limit: 1000
};

```
if (cursor) {
  options.cursor = cursor;
}

const result =
  await env.FILES.list(options);

for (const object of result.objects) {
  if (!object.key.startsWith(NOTES_PREFIX)) {
    total += object.size || 0;
  }
}

cursor = result.truncated
  ? result.cursor
  : undefined;
```

} while (cursor);

return total;
}

function getOriginalName(object) {
if (
object.customMetadata &&
object.customMetadata.originalName
) {
return object.customMetadata.originalName;
}

const parts = object.key.split("/");
const name = parts[parts.length - 1];

return name.replace(/^\d+-/, "");
}

function cleanFolder(folder) {
return String(folder || "")
.replace(/^/+|/+$/g, "");
}

function cleanNoteText(value, maxLength) {
if (maxLength === undefined) {
maxLength = 20000;
}

return String(value || "")
.trim()
.slice(0, maxLength);
}

export default {
async fetch(request, env) {

```
if (request.method === "OPTIONS") {
  return new Response(null, {
    status: 204,
    headers: corsHeaders
  });
}

const url = new URL(request.url);

/*
 * 로그인
 */

if (
  url.pathname === "/api/login" &&
  request.method === "POST"
) {
  try {
    const body =
      await request.json();

    if (
      body.username !== env.AUTH_USER ||
      body.password !== env.AUTH_PASSWORD
    ) {
      return errorResponse(
        "아이디 또는 비밀번호가 틀렸습니다.",
        401
      );
    }

    const token =
      await createToken(
        env.AUTH_USER,
        env.AUTH_PASSWORD
      );

    return jsonResponse({
      ok: true,
      token: token,
      username: env.AUTH_USER
    });

  } catch (error) {
    return errorResponse(
      "로그인 요청이 잘못되었습니다.",
      400
    );
  }
}

/*
 * 로그아웃
 */

if (
  url.pathname === "/api/logout" &&
  request.method === "POST"
) {
  return jsonResponse({
    ok: true
  });
}

/*
 * 로그인 확인
 */

if (
  url.pathname === "/api/me" &&
  request.method === "GET"
) {
  const authenticated =
    await verifyToken(
      request,
      env
    );

  if (!authenticated) {
    return errorResponse(
      "로그인이 필요합니다.",
      401
    );
  }

  return jsonResponse({
    authenticated: true,
    user: env.AUTH_USER
  });
}

/*
 * 전체 API 인증
 */

const authenticated =
  await verifyToken(
    request,
    env
  );

if (!authenticated) {
  return errorResponse(
    "로그인이 필요합니다.",
    401
  );
}

/*
 * 메모 목록
 */

if (
  url.pathname === "/api/notes" &&
  request.method === "GET"
) {
  const result =
    await env.FILES.list({
      prefix: NOTES_PREFIX,
      limit: 1000
    });

  const notes = [];

  for (const object of result.objects) {
    try {
      const noteObject =
        await env.FILES.get(
          object.key
        );

      if (!noteObject) {
        continue;
      }

      const text =
        await noteObject.text();

      const note =
        JSON.parse(text);

      notes.push(note);

    } catch (error) {
      // 문제가 있는 메모는 건너뜀
    }
  }

  notes.sort(function(a, b) {
    return (
      new Date(
        b.updatedAt || b.createdAt
      ) -
      new Date(
        a.updatedAt || a.createdAt
      )
    );
  });

  return jsonResponse({
    notes: notes
  });
}

/*
 * 메모 추가 / 수정
 */

if (
  url.pathname === "/api/notes" &&
  request.method === "POST"
) {
  try {
    const body =
      await request.json();

    const id =
      String(body.id || "").trim();

    const title =
      cleanNoteText(
        body.title,
        200
      );

    const text =
      cleanNoteText(
        body.text,
        20000
      );

    const color =
      String(
        body.color || "yellow"
      );

    const allowedColors = [
      "yellow",
      "green",
      "blue",
      "purple",
      "pink",
      "gray"
    ];

    const safeColor =
      allowedColors.includes(color)
        ? color
        : "yellow";

    if (!title && !text) {
      return errorResponse(
        "메모 내용을 입력하세요."
      );
    }

    let noteId = id;
    let createdAt =
      new Date().toISOString();

    /*
     * 기존 메모 수정
     */

    if (id) {
      if (
        id.includes("/") ||
        id.includes("\\") ||
        id.includes("..")
      ) {
        return errorResponse(
          "잘못된 메모 ID입니다."
        );
      }

      const oldKey =
        NOTES_PREFIX +
        id +
        ".json";

      const oldObject =
        await env.FILES.get(
          oldKey
        );

      if (!oldObject) {
        return errorResponse(
          "메모를 찾을 수 없습니다.",
          404
        );
      }

      try {
        const oldNote =
          JSON.parse(
            await oldObject.text()
          );

        createdAt =
          oldNote.createdAt ||
          createdAt;

      } catch (error) {
        // 기존 날짜를 읽지 못하면 현재 날짜 사용
      }

    } else {
      noteId =
        Date.now() +
        "-" +
        crypto.randomUUID();
    }

    const note = {
      id: noteId,
      title: title,
      text: text,
      color: safeColor,
      createdAt: createdAt,
      updatedAt:
        new Date().toISOString()
    };

    const key =
      NOTES_PREFIX +
      noteId +
      ".json";

    await env.FILES.put(
      key,
      JSON.stringify(note),
      {
        httpMetadata: {
          contentType:
            "application/json; charset=utf-8"
        }
      }
    );

    return jsonResponse({
      ok: true,
      note: note
    });

  } catch (error) {
    return errorResponse(
      "메모 저장에 실패했습니다.",
      500
    );
  }
}

/*
 * 메모 삭제
 */

if (
  url.pathname === "/api/notes" &&
  request.method === "DELETE"
) {
  const id =
    url.searchParams.get("id");

  if (!id) {
    return errorResponse(
      "메모 ID가 없습니다."
    );
  }

  if (
    id.includes("/") ||
    id.includes("\\") ||
    id.includes("..")
  ) {
    return errorResponse(
      "잘못된 메모 ID입니다."
    );
  }

  const key =
    NOTES_PREFIX +
    id +
    ".json";

  await env.FILES.delete(key);

  return jsonResponse({
    ok: true
  });
}

/*
 * 파일 목록
 */

if (
  url.pathname === "/api/files" &&
  request.method === "GET"
) {
  const prefix =
    url.searchParams.get("prefix") || "";

  const result =
    await env.FILES.list({
      prefix: prefix,
      delimiter: "/",
      limit: 1000
    });

  const folders =
    result.delimitedPrefixes
      .filter(function(folder) {
        return !folder.startsWith(
          NOTES_PREFIX
        );
      })
      .map(function(folder) {
        return {
          type: "folder",
          name:
            folder
              .slice(prefix.length)
              .replace(/\/$/, ""),
          prefix: folder
        };
      });

  const files =
    result.objects
      .filter(function(object) {
        return (
          object.key !== prefix &&
          !object.key.startsWith(
            NOTES_PREFIX
          )
        );
      })
      .map(function(object) {
        return {
          type: "file",
          key: object.key,
          name:
            getOriginalName(object),
          size: object.size,
          uploaded:
            object.uploaded
        };
      });

  return jsonResponse({
    folders: folders,
    files: files
  });
}

/*
 * 저장공간
 */

if (
  url.pathname === "/api/usage" &&
  request.method === "GET"
) {
  const used =
    await getStorageUsage(env);

  return jsonResponse({
    used: used,
    max: MAX_STORAGE
  });
}

/*
 * 파일 업로드
 */

if (
  url.pathname === "/api/upload" &&
  request.method === "POST"
) {
  const formData =
    await request.formData();

  const file =
    formData.get("file");

  const folder =
    formData.get("folder") || "";

  const confirmedLarge =
    formData.get(
      "confirmedLarge"
    ) === "true";

  if (!(file instanceof File)) {
    return errorResponse(
      "파일이 없습니다."
    );
  }

  if (
    file.size >= LARGE_FILE_SIZE &&
    !confirmedLarge
  ) {
    return errorResponse(
      "100MB 이상 파일은 업로드 확인이 필요합니다.",
      413
    );
  }

  const currentUsage =
    await getStorageUsage(env);

  if (
    currentUsage >= MAX_STORAGE
  ) {
    return errorResponse(
      "저장공간이 9GB에 도달하여 더 이상 업로드할 수 없습니다.",
      413
    );
  }

  if (
    currentUsage + file.size >=
    MAX_STORAGE
  ) {
    return errorResponse(
      "이 파일을 업로드하면 저장공간 9GB를 초과하므로 업로드할 수 없습니다.",
      413
    );
  }

  const safeFolder =
    cleanFolder(folder);

  let key;

  if (safeFolder) {
    key =
      safeFolder +
      "/" +
      Date.now() +
      "-" +
      file.name;
  } else {
    key =
      Date.now() +
      "-" +
      file.name;
  }

  await env.FILES.put(
    key,
    file.stream(),
    {
      httpMetadata: {
        contentType:
          file.type ||
          "application/octet-stream"
      },
      customMetadata: {
        originalName:
          file.name
      }
    }
  );

  return jsonResponse({
    ok: true,
    key: key,
    name: file.name,
    size: file.size
  });
}

/*
 * 폴더 생성
 */

if (
  url.pathname === "/api/folder" &&
  request.method === "POST"
) {
  const body =
    await request.json();

  const parent =
    cleanFolder(
      body.parent
    );

  const name =
    String(
      body.name || ""
    ).trim();

  if (!name) {
    return errorResponse(
      "폴더 이름을 입력하세요."
    );
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

  let prefix;

  if (parent) {
    prefix =
      parent +
      "/" +
      name +
      "/";
  } else {
    prefix =
      name +
      "/";
  }

  await env.FILES.put(
    prefix,
    new Uint8Array(0),
    {
      customMetadata: {
        folder: "true"
      }
    }
  );

  return jsonResponse({
    ok: true,
    prefix: prefix
  });
}

/*
 * 파일 이동
 */

if (
  url.pathname === "/api/move" &&
  request.method === "POST"
) {
  try {
    const body =
      await request.json();

    const key =
      String(
        body.key || ""
      );

    const destinationFolder =
      cleanFolder(
        body.destinationFolder
      );

    if (!key) {
      return errorResponse(
        "파일 키가 없습니다."
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

    const filename =
      getOriginalName(object);

    let newKey;

    if (destinationFolder) {
      newKey =
        destinationFolder +
        "/" +
        Date.now() +
        "-" +
        filename;
    } else {
      newKey =
        Date.now() +
        "-" +
        filename;
    }

    if (newKey === key) {
      return errorResponse(
        "현재 폴더와 같은 위치입니다."
      );
    }

    await env.FILES.put(
      newKey,
      object.body,
      {
        httpMetadata:
          object.httpMetadata,
        customMetadata:
          object.customMetadata
      }
    );

    await env.FILES.delete(key);

    return jsonResponse({
      ok: true,
      oldKey: key,
      newKey: newKey
    });

  } catch (error) {
    console.error(error);

    return errorResponse(
      "파일 이동에 실패했습니다.",
      500
    );
  }
}

/*
 * 파일 삭제
 */

if (
  url.pathname === "/api/file" &&
  request.method === "DELETE"
) {
  const key =
    url.searchParams.get("key");

  const deletePassword =
    url.searchParams.get(
      "password"
    ) || "";

  if (!key) {
    return errorResponse(
      "파일 키가 없습니다."
    );
  }

  if (
    deletePassword !==
    env.AUTH_PASSWORD
  ) {
    return errorResponse(
      "DELETE_PASSWORD_INVALID",
      403
    );
  }

  await env.FILES.delete(key);

  return jsonResponse({
    ok: true
  });
}

/*
 * 폴더 삭제
 */

if (
  url.pathname === "/api/folder" &&
  request.method === "DELETE"
) {
  const prefix =
    url.searchParams.get(
      "prefix"
    );

  const deletePassword =
    url.searchParams.get(
      "password"
    ) || "";

  if (!prefix) {
    return errorResponse(
      "폴더 경로가 없습니다."
    );
  }

  if (
    deletePassword !==
    env.AUTH_PASSWORD
  ) {
    return errorResponse(
      "DELETE_PASSWORD_INVALID",
      403
    );
  }

  let cursor;

  do {
    const options = {
      prefix: prefix,
      limit: 1000
    };

    if (cursor) {
      options.cursor = cursor;
    }

    const result =
      await env.FILES.list(
        options
      );

    if (
      result.objects.length > 0
    ) {
      const keys =
        result.objects.map(
          function(object) {
            return object.key;
          }
        );

      await env.FILES.delete(
        keys
      );
    }

    cursor =
      result.truncated
        ? result.cursor
        : undefined;

  } while (cursor);

  return jsonResponse({
    ok: true
  });
}

/*
 * 다운로드
 */

if (
  url.pathname === "/api/download" &&
  request.method === "GET"
) {
  const key =
    url.searchParams.get("key");

  if (!key) {
    return errorResponse(
      "파일 키가 없습니다."
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

  const filename =
    getOriginalName(object);

  const contentType =
    object.httpMetadata &&
    object.httpMetadata.contentType
      ? object.httpMetadata.contentType
      : "application/octet-stream";

  const disposition =
    "attachment; filename*=UTF-8''" +
    encodeURIComponent(
      filename
    );

  return new Response(
    object.body,
    {
      headers: Object.assign(
        {},
        corsHeaders,
        {
          "Content-Type":
            contentType,
          "Content-Disposition":
            disposition
        }
      )
    }
  );
}

return jsonResponse({
  ok: true,
  message: "API OK"
});
```

}
};
