const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Expose-Headers": "Content-Disposition, X-Download-Filename",
  "Access-Control-Max-Age": "86400"
};

const MAX_STORAGE = 9 * 1024 * 1024 * 1024;
const LARGE_FILE_SIZE = 100 * 1024 * 1024;
const NOTES_PREFIX = "__notes__/";
const EVENTS_PREFIX = "__calendar__/";
const DREAMS_PREFIX = "__dreams__/";

function jsonResponse(data, status) {
  if (status === undefined) {
    status = 200;
  }

  return new Response(JSON.stringify(data), {
    status: status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders
    }
  });
}

function errorResponse(message, status) {
  if (status === undefined) {
    status = 400;
  }

  return jsonResponse(
    {
      error: message
    },
    status
  );
}

function base64urlEncode(data) {
  let result = btoa(data);

  result = result.replace(/\+/g, "-");
  result = result.replace(/\//g, "_");
  result = result.replace(/=+$/, "");

  return result;
}

function base64urlDecode(data) {
  let value = data;

  value = value.replace(/-/g, "+");
  value = value.replace(/_/g, "/");

  while (value.length % 4 !== 0) {
    value += "=";
  }

  return atob(value);
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

  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }

  return base64urlEncode(binary);
}

async function createToken(username, password) {
  const payloadObject = {
    user: username,
    exp: Math.floor(Date.now() / 1000) + 604800
  };

  const payload = base64urlEncode(
    JSON.stringify(payloadObject)
  );

  const signature = await makeSignature(
    payload,
    password
  );

  return payload + "." + signature;
}

async function verifyToken(request, env) {
  try {
    const authorization =
      request.headers.get("Authorization") || "";

    if (!authorization.startsWith("Bearer ")) {
      return false;
    }

    const token =
      authorization.substring(7).trim();

    const parts = token.split(".");

    if (parts.length !== 2) {
      return false;
    }

    const payload = parts[0];
    const signature = parts[1];

    const expected =
      await makeSignature(
        payload,
        env.AUTH_PASSWORD
      );

    if (signature !== expected) {
      return false;
    }

    const data =
      JSON.parse(
        base64urlDecode(payload)
      );

    if (!data.exp) {
      return false;
    }

    if (
      data.exp <
      Math.floor(Date.now() / 1000)
    ) {
      return false;
    }

    return data.user === env.AUTH_USER;
  } catch (error) {
    return false;
  }
}

function cleanFolder(folder) {
  let value = String(folder || "");

  value = value.replace(/^\/+/g, "");
  value = value.replace(/\/+$/g, "");

  return value;
}

function getOriginalName(object) {
  const metadata = object && object.customMetadata;

  if (metadata && metadata.originalName) {
    return String(metadata.originalName);
  }

  const key = String((object && object.key) || "");
  const parts = key.split("/").filter(Boolean);
  let name = parts.length ? parts[parts.length - 1] : "";

  // 예전 업로드 방식의 타임스탬프 접두사를 제거합니다.
  name = name.replace(/^\d+-/, "");

  try {
    name = decodeURIComponent(name);
  } catch (error) {
    // 이미 일반 문자열이면 그대로 사용합니다.
  }

  return name || "이름 없는 파일";
}

async function getStorageUsage(env) {
  let cursor = undefined;
  let total = 0;

  do {
    const options = {
      limit: 1000
    };

    if (cursor) {
      options.cursor = cursor;
    }

    const result =
      await env.FILES.list(options);

    for (
      let i = 0;
      i < result.objects.length;
      i++
    ) {
      const object =
        result.objects[i];

      if (
        !object.key.startsWith(
          NOTES_PREFIX
        )
      ) {
        total += object.size || 0;
      }
    }

    cursor =
      result.truncated
        ? result.cursor
        : undefined;

  } while (cursor);

  return total;
}

function validNoteId(id) {
  return (
    id &&
    !id.includes("/") &&
    !id.includes("\\") &&
    !id.includes("..")
  );
}

function cleanText(value, maxLength) {
  return String(value || "")
    .trim()
    .slice(0, maxLength);
}

export default {
  async fetch(request, env) {

    /*
     * CORS preflight
     * 반드시 가장 먼저 처리
     */
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    try {
      const url =
        new URL(request.url);

      /*
       * LOGIN
       */
      if (
        url.pathname === "/api/login" &&
        request.method === "POST"
      ) {
        let body;

        try {
          body = await request.json();
        } catch (error) {
          return errorResponse(
            "잘못된 로그인 요청입니다.",
            400
          );
        }

        if (
          body.username !==
            env.AUTH_USER ||
          body.password !==
            env.AUTH_PASSWORD
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
      }

      /*
       * ME
       */
      if (
        url.pathname === "/api/me" &&
        request.method === "GET"
      ) {
        const ok =
          await verifyToken(
            request,
            env
          );

        if (!ok) {
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
       * LOGOUT
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
       * 인증 확인
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
       * FILE LIST
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

        const folders = [];

        for (
          let i = 0;
          i < result.delimitedPrefixes.length;
          i++
        ) {
          const folder =
            result.delimitedPrefixes[i];

          const folderName =
            folder
              .slice(prefix.length)
              .replace(/\/$/, "");

          const hiddenFolderNames = [
            "__notes__",
            "__calendar__",
            "notes",
            "note",
            "calendar"
          ];

          if (
            folder.startsWith(NOTES_PREFIX) ||
            folder.startsWith(EVENTS_PREFIX) ||
            hiddenFolderNames.indexOf(folderName.toLowerCase()) !== -1
          ) {
            continue;
          }

          folders.push({
            type: "folder",
            name: folderName,
            prefix: folder
          });
        }

        const files = [];

        for (
          let i = 0;
          i < result.objects.length;
          i++
        ) {
          const object =
            result.objects[i];

          const relativeKey = object.key.slice(prefix.length);
          const firstPart = relativeKey.split("/")[0].toLowerCase();
          const hiddenFolderNames = [
            "__notes__",
            "__calendar__",
            "notes",
            "note",
            "calendar"
          ];

          if (
            object.key === prefix ||
            object.key.startsWith(NOTES_PREFIX) ||
            object.key.startsWith(EVENTS_PREFIX) ||
            hiddenFolderNames.indexOf(firstPart) !== -1
          ) {
            continue;
          }
                    files.push({
            type: "file",
            key: object.key,
            name: getOriginalName(object),
            size: object.size || 0,
            uploaded: object.uploaded
          });
        }

        return jsonResponse({
          folders: folders,
          files: files
        });
      }

      /*
       * STORAGE
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
       * UPLOAD
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
            "파일이 없습니다.",
            400
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
          currentUsage + file.size >
          MAX_STORAGE
        ) {
          return errorResponse(
            "저장공간 9GB를 초과합니다.",
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
              originalName: file.name
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
       * CREATE FOLDER
       */
      if (
        url.pathname === "/api/folder" &&
        request.method === "POST"
      ) {
        const body =
          await request.json();

        const parent =
          cleanFolder(body.parent);

        const name =
          String(body.name || "")
            .trim();

        if (!name) {
          return errorResponse(
            "폴더 이름을 입력하세요.",
            400
          );
        }

        if (
          name.includes("/") ||
          name.includes("\\") ||
          name === "." ||
          name === ".."
        ) {
          return errorResponse(
            "사용할 수 없는 폴더 이름입니다.",
            400
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
       * MOVE FILE
       */
      if (
        url.pathname === "/api/move" &&
        request.method === "POST"
      ) {
        const body =
          await request.json();

        const oldKey =
          String(body.key || "");

        const destination =
          cleanFolder(
            body.destinationFolder
          );

        if (!oldKey) {
          return errorResponse(
            "파일 키가 없습니다.",
            400
          );
        }

        const object =
          await env.FILES.get(oldKey);

        if (!object) {
          return errorResponse(
            "파일을 찾을 수 없습니다.",
            404
          );
        }

        const filename =
          getOriginalName(object);

        let newKey;

        if (destination) {
          newKey =
            destination +
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

        await env.FILES.delete(
          oldKey
        );

        return jsonResponse({
          ok: true,
          oldKey: oldKey,
          newKey: newKey
        });
      }

      /*
       * MOVE FOLDER
       * 폴더 전체를 다른 폴더로 이동
       */
      if (
        url.pathname === "/api/move-folder" &&
        request.method === "POST"
      ) {
        const body = await request.json();

        const source = cleanFolder(body.sourceFolder);
        const destination = cleanFolder(body.destinationFolder);

        if (!source) {
          return errorResponse(
            "이동할 폴더가 없습니다.",
            400
          );
        }

        const sourcePrefix = source + "/";
        const destinationPrefix =
          destination ? destination + "/" + source.split("/").pop() + "/" : source.split("/").pop() + "/";

        if (
          destinationPrefix === sourcePrefix ||
          destinationPrefix.startsWith(sourcePrefix)
        ) {
          return errorResponse(
            "폴더를 자기 자신이나 하위 폴더로 이동할 수 없습니다.",
            400
          );
        }

        const result = await env.FILES.list({
          prefix: sourcePrefix
        });

        for (let i = 0; i < result.objects.length; i++) {
          const object = result.objects[i];

          const relativeKey =
            object.key.slice(sourcePrefix.length);

          const newKey =
            destinationPrefix + relativeKey;

          const sourceObject =
            await env.FILES.get(object.key);

          if (!sourceObject) {
            continue;
          }

          await env.FILES.put(
            newKey,
            sourceObject.body,
            {
              httpMetadata:
                sourceObject.httpMetadata,
              customMetadata:
                sourceObject.customMetadata
            }
          );
        }

        let cursor =
          result.truncated
            ? result.cursor
            : undefined;

        while (cursor) {
          const nextResult = await env.FILES.list({
            prefix: sourcePrefix,
            cursor: cursor
          });

          for (let i = 0; i < nextResult.objects.length; i++) {
            const object = nextResult.objects[i];

            const relativeKey =
              object.key.slice(sourcePrefix.length);

            const newKey =
              destinationPrefix + relativeKey;

            const sourceObject =
              await env.FILES.get(object.key);

            if (!sourceObject) {
              continue;
            }

            await env.FILES.put(
              newKey,
              sourceObject.body,
              {
                httpMetadata:
                  sourceObject.httpMetadata,
                customMetadata:
                  sourceObject.customMetadata
              }
            );
          }

          cursor =
            nextResult.truncated
              ? nextResult.cursor
              : undefined;
        }

        const deleteResult = await env.FILES.list({
          prefix: sourcePrefix
        });

        for (let i = 0; i < deleteResult.objects.length; i++) {
          await env.FILES.delete(
            deleteResult.objects[i].key
          );
        }

        let deleteCursor =
          deleteResult.truncated
            ? deleteResult.cursor
            : undefined;

        while (deleteCursor) {
          const nextDelete = await env.FILES.list({
            prefix: sourcePrefix,
            cursor: deleteCursor
          });

          for (let i = 0; i < nextDelete.objects.length; i++) {
            await env.FILES.delete(
              nextDelete.objects[i].key
            );
          }

          deleteCursor =
            nextDelete.truncated
              ? nextDelete.cursor
              : undefined;
        }

        return jsonResponse({
          ok: true,
          sourceFolder: source,
          destinationFolder: destination
        });
      }
            /*
       * RENAME FOLDER
       */
      if (
        url.pathname === "/api/rename-folder" &&
        request.method === "POST"
      ) {
        const body = await request.json();

        const source = cleanFolder(body.sourceFolder);
        const newName = String(body.newName || "").trim();

        if (!source) {
          return errorResponse(
            "이름을 변경할 폴더가 없습니다.",
            400
          );
        }

        if (
          !newName ||
          newName.includes("/") ||
          newName.includes("\\") ||
          newName === "." ||
          newName === ".."
        ) {
          return errorResponse(
            "사용할 수 없는 폴더 이름입니다.",
            400
          );
        }

        const parts =
          source.split("/").filter(Boolean);

        parts.pop();

        const parent =
          parts.length
            ? parts.join("/") + "/"
            : "";

        const destination =
          parent + newName;

        const sourcePrefix = source + "/";
        const destinationPrefix = destination + "/";

        if (
          sourcePrefix === destinationPrefix ||
          destinationPrefix.startsWith(sourcePrefix)
        ) {
          return errorResponse(
            "잘못된 폴더 이름입니다.",
            400
          );
        }

        const result = await env.FILES.list({
          prefix: sourcePrefix
        });

        for (let i = 0; i < result.objects.length; i++) {
          const object = result.objects[i];

          const relativeKey =
            object.key.slice(sourcePrefix.length);

          const newKey =
            destinationPrefix + relativeKey;

          const sourceObject =
            await env.FILES.get(object.key);

          if (!sourceObject) {
            continue;
          }

          await env.FILES.put(
            newKey,
            sourceObject.body,
            {
              httpMetadata:
                sourceObject.httpMetadata,
              customMetadata:
                sourceObject.customMetadata
            }
          );
        }

        let cursor =
          result.truncated
            ? result.cursor
            : undefined;

        while (cursor) {
          const nextResult = await env.FILES.list({
            prefix: sourcePrefix,
            cursor: cursor
          });

          for (let i = 0; i < nextResult.objects.length; i++) {
            const object = nextResult.objects[i];

            const relativeKey =
              object.key.slice(sourcePrefix.length);

            const newKey =
              destinationPrefix + relativeKey;

            const sourceObject =
              await env.FILES.get(object.key);

            if (!sourceObject) {
              continue;
            }

            await env.FILES.put(
              newKey,
              sourceObject.body,
              {
                httpMetadata:
                  sourceObject.httpMetadata,
                customMetadata:
                  sourceObject.customMetadata
              }
            );
          }

          cursor =
            nextResult.truncated
              ? nextResult.cursor
              : undefined;
        }

        const deleteResult = await env.FILES.list({
          prefix: sourcePrefix
        });

        for (let i = 0; i < deleteResult.objects.length; i++) {
          await env.FILES.delete(
            deleteResult.objects[i].key
          );
        }

        let deleteCursor =
          deleteResult.truncated
            ? deleteResult.cursor
            : undefined;

        while (deleteCursor) {
          const nextDelete = await env.FILES.list({
            prefix: sourcePrefix,
            cursor: deleteCursor
          });

          for (let i = 0; i < nextDelete.objects.length; i++) {
            await env.FILES.delete(
              nextDelete.objects[i].key
            );
          }

          deleteCursor =
            nextDelete.truncated
              ? nextDelete.cursor
              : undefined;
        }

        await env.FILES.put(
          destinationPrefix,
          new Uint8Array(0),
          {
            customMetadata: {
              folder: "true"
            }
          }
        );

        return jsonResponse({
          ok: true,
          sourceFolder: source,
          destinationFolder: destination
        });
      }

      /*
       * DOWNLOAD
       */
      if (
        url.pathname === "/api/download" &&
        request.method === "GET"
      ) {
        const key =
          url.searchParams.get("key");

        if (!key) {
          return errorResponse(
            "파일 키가 없습니다.",
            400
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

        let contentType =
          "application/octet-stream";

        if (
          object.httpMetadata &&
          object.httpMetadata.contentType
        ) {
          contentType =
            object.httpMetadata.contentType;
        }

        return new Response(
          object.body,
          {
            status: 200,
            headers: {
              ...corsHeaders,
              "Content-Type":
                contentType,
              "Content-Disposition":
                "attachment; filename*=UTF-8''" +
                encodeURIComponent(
                  filename
                ),
              "X-Download-Filename":
                encodeURIComponent(filename)
            }
          }
        );
      }

      /*
       * DELETE FILE
       */
      if (
        url.pathname === "/api/file" &&
        request.method === "DELETE"
      ) {
        const key =
          url.searchParams.get("key");

        const password =
          url.searchParams.get(
            "password"
          ) || "";

        if (!key) {
          return errorResponse(
            "파일 키가 없습니다.",
            400
          );
        }

        if (
          password !==
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
       * DELETE FOLDER
       */
      if (
        url.pathname === "/api/folder" &&
        request.method === "DELETE"
      ) {
        const prefix =
          url.searchParams.get(
            "prefix"
          );

        const password =
          url.searchParams.get(
            "password"
          ) || "";

        if (!prefix) {
          return errorResponse(
            "폴더 경로가 없습니다.",
            400
          );
        }

        if (
          password !==
          env.AUTH_PASSWORD
        ) {
          return errorResponse(
            "DELETE_PASSWORD_INVALID",
            403
          );
        }

        let cursor = undefined;

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
       * DREAM RECORDS LIST
       */
      if (
        url.pathname === "/api/dreams" &&
        request.method === "GET"
      ) {
        const result = await env.FILES.list({
          prefix: DREAMS_PREFIX,
          limit: 1000
        });

        const dreams = [];

        for (let i = 0; i < result.objects.length; i++) {
          const object = result.objects[i];

          try {
            const dreamObject = await env.FILES.get(object.key);
            if (!dreamObject) continue;

            const dream = JSON.parse(await dreamObject.text());
            dreams.push(dream);
          } catch (error) {
          }
        }

        dreams.sort(function(a, b) {
          return String(b.date || "").localeCompare(String(a.date || ""));
        });

        return jsonResponse({
          dreams: dreams
        });
      }

      /*
       * SAVE DREAM RECORD
       */
      if (
        url.pathname === "/api/dreams" &&
        request.method === "POST"
      ) {
        const body = await request.json();

        const id = String(body.id || "").trim();
        const date = String(body.date || "").trim();
        const title = cleanText(body.title, 200);
        const content = cleanText(body.content, 30000);
        const image = String(body.image || "");

        if (!/^\d{4}\.\d{2}\.\d{2}$/.test(date)) {
          return errorResponse("잘못된 날짜입니다.", 400);
        }

        if (!title) {
          return errorResponse("꿈 제목을 입력하세요.", 400);
        }

        if (!content) {
          return errorResponse("꿈 내용을 입력하세요.", 400);
        }

        if (image.length > 6 * 1024 * 1024) {
          return errorResponse("꿈 이미지가 너무 큽니다.", 413);
        }

        let dreamId = id;
        let createdAt = new Date().toISOString();

        if (id) {
          if (!validNoteId(id)) {
            return errorResponse("잘못된 꿈 기록 ID입니다.", 400);
          }

          const oldObject = await env.FILES.get(
            DREAMS_PREFIX + id + ".json"
          );

          if (oldObject) {
            try {
              const oldDream = JSON.parse(await oldObject.text());
              createdAt = oldDream.createdAt || createdAt;
            } catch (error) {
            }
          }
        } else {
          dreamId = Date.now() + "-" + crypto.randomUUID();
        }

        const dream = {
          id: dreamId,
          date: date,
          title: title,
          content: content,
          image: image,
          createdAt: createdAt,
          updatedAt: new Date().toISOString()
        };

        await env.FILES.put(
          DREAMS_PREFIX + dreamId + ".json",
          JSON.stringify(dream),
          {
            httpMetadata: {
              contentType: "application/json; charset=utf-8"
            }
          }
        );

        return jsonResponse({
          ok: true,
          dream: dream
        });
      }

      /*
       * DELETE DREAM RECORD
       */
      if (
        url.pathname === "/api/dreams" &&
        request.method === "DELETE"
      ) {
        const id = url.searchParams.get("id");

        if (!validNoteId(id)) {
          return errorResponse("잘못된 꿈 기록 ID입니다.", 400);
        }

        await env.FILES.delete(
          DREAMS_PREFIX + id + ".json"
        );

        return jsonResponse({
          ok: true
        });
      }

      /*
       * CALENDAR EVENTS LIST
       */
      if (
        url.pathname === "/api/events" &&
        request.method === "GET"
      ) {
        const result =
          await env.FILES.list({
            prefix: EVENTS_PREFIX,
            limit: 1000
          });

        const events = [];

        for (
          let i = 0;
          i < result.objects.length;
          i++
        ) {
          const object =
            result.objects[i];

          try {
            const eventObject =
              await env.FILES.get(object.key);

            if (!eventObject) {
              continue;
            }

            const event =
              JSON.parse(
                await eventObject.text()
              );

            events.push(event);
          } catch (error) {
          }
        }

        events.sort(
          function(a, b) {
            return (
              String(a.date || "") + String(a.time || "")
            ).localeCompare(
              String(b.date || "") + String(b.time || "")
            );
          }
        );

        return jsonResponse({
          events: events
        });
      }

      /*
       * SAVE CALENDAR EVENT
       */
      if (
        url.pathname === "/api/events" &&
        request.method === "POST"
      ) {
        const body =
          await request.json();

        const id =
          String(body.id || "").trim();

        const date =
          String(body.date || "").trim();

        const time =
          String(body.time || "").trim();

        const title =
          cleanText(body.title, 200);

        const text =
          cleanText(body.text, 5000);

        const colors = [
          "yellow",
          "green",
          "blue",
          "purple",
          "pink",
          "gray"
        ];

        const color =
          colors.includes(body.color)
            ? body.color
            : "yellow";

        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          return errorResponse(
            "잘못된 날짜입니다.",
            400
          );
        }

        if (time && !/^\d{2}:\d{2}$/.test(time)) {
          return errorResponse(
            "잘못된 시간입니다.",
            400
          );
        }

        if (!title) {
          return errorResponse(
            "일정 제목을 입력하세요.",
            400
          );
        }

        let eventId = id;
        let createdAt =
          new Date().toISOString();

        if (id) {
          if (!validNoteId(id)) {
            return errorResponse(
              "잘못된 일정 ID입니다.",
              400
            );
          }

          const oldObject =
            await env.FILES.get(
              EVENTS_PREFIX + id + ".json"
            );

          if (oldObject) {
            try {
              const oldEvent =
                JSON.parse(
                  await oldObject.text()
                );

              createdAt =
                oldEvent.createdAt ||
                createdAt;
            } catch (error) {
            }
          }
        } else {
          eventId =
            Date.now() +
            "-" +
            crypto.randomUUID();
        }

        const event = {
          id: eventId,
          date: date,
          time: time,
          title: title,
          text: text,
          color: color,
          createdAt: createdAt,
          updatedAt:
            new Date().toISOString()
        };

        await env.FILES.put(
          EVENTS_PREFIX + eventId + ".json",
          JSON.stringify(event),
          {
            httpMetadata: {
              contentType:
                "application/json; charset=utf-8"
            }
          }
        );

        return jsonResponse({
          ok: true,
          event: event
        });
      }

          /*
       * DELETE CALENDAR EVENT
       */
      if (
        url.pathname === "/api/events" &&
        request.method === "DELETE"
      ) {
        const id =
          url.searchParams.get("id");

        if (!validNoteId(id)) {
          return errorResponse(
            "잘못된 일정 ID입니다.",
            400
          );
        }

        await env.FILES.delete(
          EVENTS_PREFIX + id + ".json"
        );

        return jsonResponse({
          ok: true
        });
      }

      /*
       * NOTES LIST
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

        for (
          let i = 0;
          i < result.objects.length;
          i++
        ) {
          const object =
            result.objects[i];

          try {
            const noteObject =
              await env.FILES.get(
                object.key
              );

            if (!noteObject) {
              continue;
            }

            const note =
              JSON.parse(
                await noteObject.text()
              );

            if (!note.color) {
              note.color = "yellow";
            }

            if (!note.title) {
              note.title = "";
            }

            notes.push(note);
          } catch (error) {
          }
        }

        notes.sort(
          function(a, b) {
            return (
              new Date(
                b.updatedAt ||
                b.createdAt
              ) -
              new Date(
                a.updatedAt ||
                a.createdAt
              )
            );
          }
        );

        return jsonResponse({
          notes: notes
        });
      }

      /*
       * SAVE NOTE
       */
      if (
        url.pathname === "/api/notes" &&
        request.method === "POST"
      ) {
        const body =
          await request.json();

        const id =
          String(body.id || "")
            .trim();

        const title =
          cleanText(
            body.title,
            200
          );

        const text =
          cleanText(
            body.text,
            20000
          );

        const colors = [
          "yellow",
          "green",
          "blue",
          "purple",
          "pink",
          "gray"
        ];

        const color =
          colors.includes(
            body.color
          )
            ? body.color
            : "yellow";

        if (!title && !text) {
          return errorResponse(
            "메모 내용을 입력하세요.",
            400
          );
        }

        let noteId = id;
        let createdAt =
          new Date().toISOString();

        if (id) {
          if (!validNoteId(id)) {
            return errorResponse(
              "잘못된 메모 ID입니다.",
              400
            );
          }

          const oldObject =
            await env.FILES.get(
              NOTES_PREFIX +
              id +
              ".json"
            );

          if (oldObject) {
            try {
              const oldNote =
                JSON.parse(
                  await oldObject.text()
                );

              createdAt =
                oldNote.createdAt ||
                createdAt;
            } catch (error) {
            }
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
          color: color,
          createdAt: createdAt,
          updatedAt:
            new Date().toISOString()
        };

        await env.FILES.put(
          NOTES_PREFIX +
          noteId +
          ".json",
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
      }

      /*
       * DELETE NOTE
       */
      if (
        url.pathname === "/api/notes" &&
        request.method === "DELETE"
      ) {
        const id =
          url.searchParams.get("id");

        if (!validNoteId(id)) {
          return errorResponse(
            "잘못된 메모 ID입니다.",
            400
          );
        }

        await env.FILES.delete(
          NOTES_PREFIX +
          id +
          ".json"
        );

        return jsonResponse({
          ok: true
        });
      }

      return jsonResponse({
        ok: true,
        message: "API OK"
      });

    } catch (error) {
      console.error(
        "WORKER ERROR:",
        error
      );

      return errorResponse(
        "Worker 내부 오류가 발생했습니다.",
        500
      );
    }
  }
};
