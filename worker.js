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


function jsonResponse(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status: status,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json; charset=utf-8"
      }
    }
  );
}


function errorResponse(message, status = 400) {
  return jsonResponse(
    {
      ok: false,
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

  while (value.length % 4) {
    value += "=";
  }

  return atob(value);
}


async function makeSignature(payload, secret) {
  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    {
      name: "HMAC",
      hash: "SHA-256"
    },
    false,
    ["sign"]
  );

  const signature =
    await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(payload)
    );

  let binary = "";

  const bytes =
    new Uint8Array(signature);

  for (
    let i = 0;
    i < bytes.length;
    i++
  ) {
    binary += String.fromCharCode(bytes[i]);
  }

  return base64urlEncode(binary);
}


async function createToken(username, secret) {
  const payload = JSON.stringify({
    sub: username,
    exp:
      Date.now() +
      1000 * 60 * 60 * 24 * 7
  });

  const encoded =
    base64urlEncode(payload);

  const signature =
    await makeSignature(
      encoded,
      secret
    );

  return (
    encoded +
    "." +
    signature
  );
}


async function verifyToken(token, secret) {
  try {
    if (!token) {
      return null;
    }

    const parts =
      token.split(".");

    if (parts.length !== 2) {
      return null;
    }

    const payload =
      parts[0];

    const signature =
      parts[1];

    const expected =
      await makeSignature(
        payload,
        secret
      );

    if (signature !== expected) {
      return null;
    }

    const decoded =
      JSON.parse(
        base64urlDecode(payload)
      );

    if (
      !decoded.exp ||
      Date.now() > decoded.exp
    ) {
      return null;
    }

    return decoded;
  } catch (error) {
    return null;
  }
}


function getTokenFromRequest(request) {
  const header =
    request.headers.get(
      "Authorization"
    );

  if (!header) {
    return null;
  }

  if (
    !header.startsWith("Bearer ")
  ) {
    return null;
  }

  return header.slice(7);
}


async function requireAuth(
  request,
  env
) {
  const token =
    getTokenFromRequest(request);

  if (!token) {
    return null;
  }

  return await verifyToken(
    token,
    env.AUTH_PASSWORD
  );
}


function cleanFolder(folder) {
  let value =
    String(folder || "");

  value =
    value.replace(
      /^\/+/g,
      ""
    );

  value =
    value.replace(
      /\/+$/g,
      ""
    );

  return value;
}


function getOriginalName(object) {
  if (
    object.customMetadata &&
    object.customMetadata.originalName
  ) {
    return (
      object.customMetadata
        .originalName
    );
  }

  const parts =
    object.key.split("/");

  const name =
    parts[parts.length - 1];

  return name.replace(
    /^\d+-/,
    ""
  );
}


async function getStorageUsage(env) {
  let cursor =
    undefined;

  let total = 0;

  do {
    const options = {
      limit: 1000
    };

    if (cursor) {
      options.cursor =
        cursor;
    }

    const result =
      await env.FILES.list(
        options
      );

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
        ) &&
        !object.key.startsWith(
          EVENTS_PREFIX
        )
      ) {
        total +=
          object.size || 0;
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


function cleanText(
  value,
  maxLength
) {
  return String(value || "")
    .trim()
    .slice(0, maxLength);
}


export default {

  async fetch(request, env) {

    /*
     * CORS PREFLIGHT
     */
    if (
      request.method ===
      "OPTIONS"
    ) {
      return new Response(
        null,
        {
          status: 204,
          headers: corsHeaders
        }
      );
    }


    try {

      const url =
        new URL(
          request.url
        );


      /*
       * LOGIN
       */
      if (
        url.pathname ===
          "/api/login" &&
        request.method ===
          "POST"
      ) {

        let body;

        try {
          body =
            await request.json();
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
          token: token
        });
      }


      /*
       * AUTHENTICATION
       */
      const auth =
        await requireAuth(
          request,
          env
        );

      if (!auth) {
        return errorResponse(
          "로그인이 필요합니다.",
          401
        );
      }


      /*
       * ME
       */
      if (
        url.pathname ===
          "/api/me" &&
        request.method ===
          "GET"
      ) {
        return jsonResponse({
          ok: true,
          username: auth.sub
        });
      }


      /*
       * LOGOUT
       */
      if (
        url.pathname ===
          "/api/logout" &&
        request.method ===
          "POST"
      ) {
        return jsonResponse({
          ok: true
        });
      }


      /*
       * FILE LIST
       */
      if (
        url.pathname ===
          "/api/files" &&
        request.method ===
          "GET"
      ) {

        const prefix =
          cleanFolder(
            url.searchParams.get(
              "prefix"
            )
          );

        const normalizedPrefix =
          prefix
            ? prefix + "/"
            : "";

        const page =
          parseInt(
            url.searchParams.get(
              "page"
            ) || "1",
            10
          );

        const limit = 30;

        let cursor =
          url.searchParams.get(
            "cursor"
          ) || undefined;

        const result =
          await env.FILES.list({
            prefix:
              normalizedPrefix,
            delimiter: "/",
            limit: 1000,
            cursor:
              cursor
          });

        const rawFolders =
  result.delimitedPrefixes || [];

const folders =
  rawFolders.map(function(prefix) {
    const cleanPrefix =
      prefix.replace(/\/+$/, "");

    const parts =
      cleanPrefix
        .split("/")
        .filter(Boolean);

    return {
      name:
        parts[parts.length - 1] || "",
      prefix:
        prefix
    };
  });

        const objects =
          result.objects || [];

        const files =
          objects.filter(
            function(object) {
              return (
                !object.key.startsWith(
                  NOTES_PREFIX
                ) &&
                !object.key.startsWith(
                  EVENTS_PREFIX
                )
              );
            }
          );

        files.sort(
          function(a, b) {
            return (
              b.uploaded -
              a.uploaded
            );
          }
        );

        const start =
          (page - 1) *
          limit;

        const pageFiles =
          files.slice(
            start,
            start + limit
          );

        return jsonResponse({
          ok: true,
          prefix:
            normalizedPrefix,
          folders:
            folders,
          files:
            pageFiles,
          page:
            page,
          totalFiles:
            files.length,
          hasMore:
            start + limit <
            files.length,
          cursor:
            result.truncated
              ? result.cursor
              : null
        });
      }


      /*
       * STORAGE USAGE
       */
      if (
        url.pathname ===
          "/api/usage" &&
        request.method ===
          "GET"
      ) {

        const usage =
          await getStorageUsage(
            env
          );

        return jsonResponse({
          ok: true,
          used: usage,
          max:
            MAX_STORAGE
        });
      }


      /*
       * UPLOAD
       */
      if (
        url.pathname ===
          "/api/upload" &&
        request.method ===
          "POST"
      ) {

        const filename =
          url.searchParams.get(
            "filename"
          );

        const folder =
          cleanFolder(
            url.searchParams.get(
              "folder"
            )
          );

        if (!filename) {
          return errorResponse(
            "파일명이 없습니다.",
            400
          );
        }

        const contentLength =
          parseInt(
            request.headers.get(
              "Content-Length"
            ) || "0",
            10
          );

        if (
          contentLength >
          LARGE_FILE_SIZE
        ) {

          const confirmed =
            url.searchParams.get(
              "confirmed"
            );

          if (
            confirmed !== "1"
          ) {
            return errorResponse(
              "100MB 이상 파일은 확인이 필요합니다.",
              413
            );
          }
        }

        const usage =
          await getStorageUsage(
            env
          );

        if (
          usage +
            contentLength >
          MAX_STORAGE
        ) {
          return errorResponse(
            "저장공간 9GB를 초과합니다.",
            413
          );
        }

        const safeFilename =
          filename
            .replace(
              /[\\\/]/g,
              "_"
            );

        const key =
          (
            folder
              ? folder + "/"
              : ""
          ) +
          Date.now() +
          "-" +
          safeFilename;

        await env.FILES.put(
          key,
          request.body,
          {
            httpMetadata: {
              contentType:
                request.headers.get(
                  "Content-Type"
                ) ||
                "application/octet-stream"
            },
            customMetadata: {
              originalName:
                filename
            }
          }
        );

        return jsonResponse({
          ok: true,
          key: key,
          filename:
            filename
        });
      }


      /*
       * CREATE FOLDER
       */
      if (
        url.pathname ===
          "/api/folder" &&
        request.method ===
          "POST"
      ) {

        const body =
          await request.json();

        const name =
          String(
            body.name || ""
          ).trim();

        const parent =
          cleanFolder(
            body.parent
          );

        if (
          !name ||
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
              folder:
                "true"
            }
          }
        );

        return jsonResponse({
          ok: true,
          prefix:
            prefix
        });
      }


      /*
       * MOVE FILE
       */
      if (
        url.pathname ===
          "/api/move" &&
        request.method ===
          "POST"
      ) {

        const body =
          await request.json();

        const oldKey =
          String(
            body.key || ""
          );

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
          await env.FILES.get(
            oldKey
          );

        if (!object) {
          return errorResponse(
            "파일을 찾을 수 없습니다.",
            404
          );
        }

        const filename =
          getOriginalName(
            object
          );

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
          oldKey:
            oldKey,
          newKey:
            newKey
        });
      }


      /*
       * MOVE FOLDER
       */
      if (
        url.pathname ===
          "/api/move-folder" &&
        request.method ===
          "POST"
      ) {

        const body =
          await request.json();

        const source =
          cleanFolder(
            body.sourceFolder
          );

        const destination =
          cleanFolder(
            body.destinationFolder
          );

        if (!source) {
          return errorResponse(
            "이동할 폴더가 없습니다.",
            400
          );
        }

        const sourcePrefix =
          source + "/";

        const folderName =
          source
            .split("/")
            .filter(Boolean)
            .pop();

        const destinationPrefix =
          destination
            ? destination +
              "/" +
              folderName +
              "/"
            : folderName + "/";

        if (
          destinationPrefix ===
            sourcePrefix ||
          destinationPrefix.startsWith(
            sourcePrefix
          )
        ) {
          return errorResponse(
            "폴더를 자기 자신이나 하위 폴더로 이동할 수 없습니다.",
            400
          );
        }

        const result =
          await env.FILES.list({
            prefix:
              sourcePrefix
          });

        for (
          let i = 0;
          i < result.objects.length;
          i++
        ) {

          const object =
            result.objects[i];

          const relativeKey =
            object.key.slice(
              sourcePrefix.length
            );

          const newKey =
            destinationPrefix +
            relativeKey;

          const sourceObject =
            await env.FILES.get(
              object.key
            );

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

          const nextResult =
            await env.FILES.list({
              prefix:
                sourcePrefix,
              cursor:
                cursor
            });

          for (
            let i = 0;
            i <
              nextResult.objects.length;
            i++
          ) {

            const object =
              nextResult.objects[i];

            const relativeKey =
              object.key.slice(
                sourcePrefix.length
              );

            const newKey =
              destinationPrefix +
              relativeKey;

            const sourceObject =
              await env.FILES.get(
                object.key
              );

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

        const deleteResult =
          await env.FILES.list({
            prefix:
              sourcePrefix
          });

        for (
          let i = 0;
          i <
            deleteResult.objects.length;
          i++
        ) {

          await env.FILES.delete(
            deleteResult.objects[i].key
          );
        }

        let deleteCursor =
          deleteResult.truncated
            ? deleteResult.cursor
            : undefined;

        while (deleteCursor) {

          const nextDelete =
            await env.FILES.list({
              prefix:
                sourcePrefix,
              cursor:
                deleteCursor
            });

          for (
            let i = 0;
            i <
              nextDelete.objects.length;
            i++
          ) {

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
          sourceFolder:
            source,
          destinationFolder:
            destination
        });
      }


      /*
       * RENAME FOLDER
       */
      if (
        url.pathname ===
          "/api/rename-folder" &&
        request.method ===
          "POST"
      ) {

        const body =
          await request.json();

        const source =
          cleanFolder(
            body.sourceFolder
          );

        const newName =
          String(
            body.newName || ""
          ).trim();

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
          source
            .split("/")
            .filter(Boolean);

        parts.pop();

        const parent =
          parts.length
            ? parts.join("/") +
              "/"
            : "";

        const destination =
          parent +
          newName;

        const sourcePrefix =
          source + "/";

        const destinationPrefix =
          destination + "/";

        if (
          sourcePrefix ===
            destinationPrefix ||
          destinationPrefix.startsWith(
            sourcePrefix
          )
        ) {
          return errorResponse(
            "잘못된 폴더 이름입니다.",
            400
          );
        }

        const result =
          await env.FILES.list({
            prefix:
              sourcePrefix
          });

        for (
          let i = 0;
          i <
            result.objects.length;
          i++
        ) {

          const object =
            result.objects[i];

          const relativeKey =
            object.key.slice(
              sourcePrefix.length
            );

          const newKey =
            destinationPrefix +
            relativeKey;

          const sourceObject =
            await env.FILES.get(
              object.key
            );

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

          const nextResult =
            await env.FILES.list({
              prefix:
                sourcePrefix,
              cursor:
                cursor
            });

          for (
            let i = 0;
            i <
              nextResult.objects.length;
            i++
          ) {

            const object =
              nextResult.objects[i];

            const relativeKey =
              object.key.slice(
                sourcePrefix.length
              );

            const newKey =
              destinationPrefix +
              relativeKey;

            const sourceObject =
              await env.FILES.get(
                object.key
              );

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

        const deleteResult =
          await env.FILES.list({
            prefix:
              sourcePrefix
          });

        for (
          let i = 0;
          i <
            deleteResult.objects.length;
          i++
        ) {

          await env.FILES.delete(
            deleteResult.objects[i].key
          );
        }

        let deleteCursor =
          deleteResult.truncated
            ? deleteResult.cursor
            : undefined;

        while (deleteCursor) {

          const nextDelete =
            await env.FILES.list({
              prefix:
                sourcePrefix,
              cursor:
                deleteCursor
            });

          for (
            let i = 0;
            i <
              nextDelete.objects.length;
            i++
          ) {

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
              folder:
                "true"
            }
          }
        );

        return jsonResponse({
          ok: true,
          sourceFolder:
            source,
          destinationFolder:
            destination
        });
      }


      /*
       * DOWNLOAD
       */
      if (
        url.pathname ===
          "/api/download" &&
        request.method ===
          "GET"
      ) {

        const key =
          url.searchParams.get(
            "key"
          );

        if (!key) {
          return errorResponse(
            "파일 키가 없습니다.",
            400
          );
        }

        const object =
          await env.FILES.get(
            key
          );

        if (!object) {
          return errorResponse(
            "파일을 찾을 수 없습니다.",
            404
          );
        }

        const filename =
          getOriginalName(
            object
          );

        let contentType =
          "application/octet-stream";

        if (
          object.httpMetadata &&
          object.httpMetadata
            .contentType
        ) {
          contentType =
            object.httpMetadata
              .contentType;
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
                encodeURIComponent(
                  filename
                )
            }
          }
        );
      }


      /*
       * DELETE FILE
       */
      if (
        url.pathname ===
          "/api/file" &&
        request.method ===
          "DELETE"
      ) {

        const key =
          url.searchParams.get(
            "key"
          );

        const password =
          url.searchParams.get(
            "password"
          );

        if (
          password !==
          env.AUTH_PASSWORD
        ) {
          return errorResponse(
            "비밀번호가 틀렸습니다.",
            401
          );
        }

        if (!key) {
          return errorResponse(
            "파일 키가 없습니다.",
            400
          );
        }

        await env.FILES.delete(
          key
        );

        return jsonResponse({
          ok: true
        });
      }


      /*
       * DELETE FOLDER
       */
      if (
        url.pathname ===
          "/api/folder" &&
        request.method ===
          "DELETE"
      ) {

        const prefix =
          cleanFolder(
            url.searchParams.get(
              "prefix"
            )
          );

        const password =
          url.searchParams.get(
            "password"
          );

        if (
          password !==
          env.AUTH_PASSWORD
        ) {
          return errorResponse(
            "비밀번호가 틀렸습니다.",
            401
          );
        }

        if (!prefix) {
          return errorResponse(
            "폴더가 없습니다.",
            400
          );
        }

        const folderPrefix =
          prefix + "/";

        let cursor =
          undefined;

        do {

          const options = {
            prefix:
              folderPrefix,
            limit: 1000
          };

          if (cursor) {
            options.cursor =
              cursor;
          }

          const result =
            await env.FILES.list(
              options
            );

          for (
            let i = 0;
            i <
              result.objects.length;
            i++
          ) {

            await env.FILES.delete(
              result.objects[i].key
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
       * CALENDAR EVENTS LIST
       */
      if (
        url.pathname ===
          "/api/events" &&
        request.method ===
          "GET"
      ) {

        const result =
          await env.FILES.list({
            prefix:
              EVENTS_PREFIX,
            limit: 1000
          });

        const events = [];

        for (
          let i = 0;
          i <
            result.objects.length;
          i++
        ) {

          const object =
            result.objects[i];

          try {

            const eventObject =
              await env.FILES.get(
                object.key
              );

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

            const aValue =
              String(
                a.date || ""
              ) +
              " " +
              String(
                a.time || ""
              );

            const bValue =
              String(
                b.date || ""
              ) +
              " " +
              String(
                b.time || ""
              );

            return aValue.localeCompare(
              bValue
            );
          }
        );

        return jsonResponse({
          ok: true,
          events:
            events
        });
      }


      /*
       * SAVE CALENDAR EVENT
       */
      if (
        url.pathname ===
          "/api/events" &&
        request.method ===
          "POST"
      ) {

        const body =
          await request.json();

        const id =
          String(
            body.id || ""
          ).trim();

        const date =
          String(
            body.date || ""
          ).trim();

        const time =
          String(
            body.time || ""
          ).trim();

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
            : "blue";

        if (!date) {
          return errorResponse(
            "일정 날짜를 입력하세요.",
            400
          );
        }

        if (!title) {
          return errorResponse(
            "일정 제목을 입력하세요.",
            400
          );
        }

        let eventId =
          id;

        let createdAt =
          new Date().toISOString();

        if (id) {

          if (
            !validNoteId(id)
          ) {
            return errorResponse(
              "잘못된 일정 ID입니다.",
              400
            );
          }

          const oldObject =
            await env.FILES.get(
              EVENTS_PREFIX +
                id +
                ".json"
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
            crypto.randomUUID();

        }

        const event = {
          id:
            eventId,

          date:
            date,

          time:
            time,

          title:
            title,

          text:
            text,

          color:
            color,

          createdAt:
            createdAt,

          updatedAt:
            new Date().toISOString()
        };

        await env.FILES.put(
          EVENTS_PREFIX +
            eventId +
            ".json",

          JSON.stringify(
            event
          ),

          {
            httpMetadata: {
              contentType:
                "application/json; charset=utf-8"
            }
          }
        );

        return jsonResponse({
          ok: true,
          event:
            event
        });
      }


      /*
       * DELETE CALENDAR EVENT
       */
      if (
        url.pathname ===
          "/api/events" &&
        request.method ===
          "DELETE"
      ) {

        const id =
          url.searchParams.get(
            "id"
          );

        if (
          !validNoteId(id)
        ) {
          return errorResponse(
            "잘못된 일정 ID입니다.",
            400
          );
        }

        await env.FILES.delete(
          EVENTS_PREFIX +
            id +
            ".json"
        );

        return jsonResponse({
          ok: true
        });
      }


      /*
       * NOTES LIST
       */
      if (
        url.pathname ===
          "/api/notes" &&
        request.method ===
          "GET"
      ) {

        const result =
          await env.FILES.list({
            prefix:
              NOTES_PREFIX,
            limit: 1000
          });

        const notes = [];

        for (
          let i = 0;
          i <
            result.objects.length;
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
              note.color =
                "yellow";
            }

            if (!note.title) {
              note.title =
                "";
            }

            notes.push(
              note
            );

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
          notes:
            notes
        });
      }


      /*
       * SAVE NOTE
       */
      if (
        url.pathname ===
          "/api/notes" &&
        request.method ===
          "POST"
      ) {

        const body =
          await request.json();

        const id =
          String(
            body.id || ""
          ).trim();

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

        if (
          !title &&
          !text
        ) {
          return errorResponse(
            "메모 내용을 입력하세요.",
            400
          );
        }

        let noteId =
          id;

        let createdAt =
          new Date().toISOString();

        if (id) {

          if (
            !validNoteId(id)
          ) {
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
            crypto.randomUUID();

        }

        const note = {

          id:
            noteId,

          title:
            title,

          text:
            text,

          color:
            color,

          createdAt:
            createdAt,

          updatedAt:
            new Date().toISOString()

        };

        await env.FILES.put(
          NOTES_PREFIX +
            noteId +
            ".json",

          JSON.stringify(
            note
          ),

          {
            httpMetadata: {
              contentType:
                "application/json; charset=utf-8"
            }
          }
        );

        return jsonResponse({
          ok: true,
          note:
            note
        });
      }


      /*
       * DELETE NOTE
       */
      if (
        url.pathname ===
          "/api/notes" &&
        request.method ===
          "DELETE"
      ) {

        const id =
          url.searchParams.get(
            "id"
          );

        if (
          !validNoteId(id)
        ) {
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


      return errorResponse(
        "요청한 API를 찾을 수 없습니다.",
        404
      );


    } catch (error) {

      console.error(
        error
      );

      return errorResponse(
        "서버 오류: " +
          String(
            error &&
            error.message
              ? error.message
              : error
          ),
        500
      );
    }
  }
};
