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

async function getAuthRole(request, env) {
  try {
    const authorization = request.headers.get("Authorization") || "";
    if (!authorization.startsWith("Bearer ")) return null;
    const token = authorization.substring(7).trim();
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const payload = parts[0];
    const signature = parts[1];
    const expected = await makeSignature(payload, env.AUTH_PASSWORD);
    if (signature !== expected) return null;
    const data = JSON.parse(base64urlDecode(payload));
    if (!data.exp || data.exp < Math.floor(Date.now() / 1000)) return null;
    if (data.user === env.AUTH_USER) return "admin";
    if (data.role === "guest") return "guest";
    return null;
  } catch (error) {
    return null;
  }
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


// 다음달 근무표 AI 가져오기
function getSeoulNextMonthKey() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit"
  }).formatToParts(now);
  const y = Number(parts.find(p => p.type === "year").value);
  const m = Number(parts.find(p => p.type === "month").value);
  const next = m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 };
  return next.y + "-" + String(next.m).padStart(2, "0");
}
function normalizeDutyImport(value, month) {
  if (!value || !Array.isArray(value.staff)) throw new Error("AI가 근무자 표를 인식하지 못했습니다.");
  const days = new Date(Number(month.slice(0,4)), Number(month.slice(5,7)), 0).getDate();
  const staff = value.staff.filter(x => Array.isArray(x) && x.length >= 3 && String(x[1] || "").trim());
  if (!staff.length) throw new Error("근무자 이름을 찾지 못했습니다.");
  const cleanCodes = c => Array.isArray(c) ? c.slice(0, days).map(v => String(v ?? "").trim().toUpperCase()) : [];
  const normalized = staff.map(x => [String(x[0] || "n").toLowerCase() === "a" ? "a" : "n", String(x[1]).trim(), cleanCodes(x[2])]);
  for (const x of normalized) while (x[2].length < days) x[2].push("");
  const sourceDoctors = value.doctorData && typeof value.doctorData === "object" ? value.doctorData : {};
  const doctorData = {};
  for (const key of ["specialist", "resident", "intern"]) {
    doctorData[key] = Array.from({ length: days }, (_, i) => Array.isArray(sourceDoctors[key]?.[i]) ? sourceDoctors[key][i].map(v => String(v ?? "").trim()) : []);
  }
  return { staff: normalized, doctorData };
}
function extractJsonObject(text) {
  const s = String(text || "");
  const start = s.indexOf("{"), end = s.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("AI 응답에서 JSON을 찾지 못했습니다.");
  return JSON.parse(s.slice(start, end + 1));
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
          username: env.AUTH_USER,
          role: "admin"
        });
      }

      /*
       * GUEST LOGIN
       */
      if (
        url.pathname === "/api/guest" &&
        request.method === "POST"
      ) {
        const token = await createToken("guest", env.AUTH_PASSWORD);
        const payloadParts = token.split(".");
        const guestPayload = JSON.parse(base64urlDecode(payloadParts[0]));
        guestPayload.role = "guest";
        const payload = base64urlEncode(JSON.stringify(guestPayload));
        const signature = await makeSignature(payload, env.AUTH_PASSWORD);
        return jsonResponse({
          ok: true,
          token: payload + "." + signature,
          username: "guest",
          role: "guest"
        });
      }

      /*
       * ME
       */
      if (
        url.pathname === "/api/me" &&
        request.method === "GET"
      ) {
        const role = await getAuthRole(request, env);
        if (!role) {
          return errorResponse(
            "로그인이 필요합니다.",
            401
          );
        }

        return jsonResponse({
          authenticated: true,
          user: role === "admin" ? env.AUTH_USER : "guest",
          role: role
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
       * PUBLIC DUTY DATA
       * 근무표는 로그인 없이 조회할 수 있습니다.
       */
      const dutyMatch = url.pathname.match(/^\/api\/duty\/(\d{4}-\d{2})$/);
      if (dutyMatch && request.method === "GET") {
        const month = dutyMatch[1];
        const object = await env.FILES.get("duty/" + month + ".json");
        if (!object) return errorResponse("근무 데이터를 찾을 수 없습니다.", 404);
        return new Response(object.body, {
          status: 200,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store"
          }
        });
      }

      /*
       * PUBLIC NEXT-MONTH DUTY IMPORT
       * 로그인 없이 누구나 다음달 근무표를 올릴 수 있습니다.
       * 이미 해당 월 데이터가 있으면 AI를 호출하지 않습니다.
       */
      if (url.pathname === "/api/duty/import" && request.method === "POST") {
        try {
          if (!env.AI) return errorResponse("근무표 AI 기능이 아직 연결되지 않았습니다.", 503);
          if (Number(request.headers.get("Content-Length") || 0) > 8 * 1024 * 1024) {
            return errorResponse("파일이 너무 큽니다. 8MB 이하로 올려주세요.", 413);
          }
          const body = await request.json();
          const targetMonth = String(body.month || "");
          const expectedMonth = getSeoulNextMonthKey();
          if (!/^\d{4}-\d{2}$/.test(targetMonth) || targetMonth !== expectedMonth) {
            return errorResponse("현재 기준 다음달 근무표만 업로드할 수 있습니다.", 400);
          }
          const existing = await env.FILES.get("duty/" + targetMonth + ".json");
          if (existing) return errorResponse("이미 " + targetMonth + " 근무표가 등록되어 있습니다.", 409);

          const kind = body.kind === "image" ? "image" : "text";
          const data = String(body.data || "");
          if (!data || data.length > 180000) return errorResponse("업로드 내용이 없거나 너무 큽니다.", 413);

          const schema = `{
            "staff":[["n","간호사이름",["D","E","N","O"]],["a","보조원이름",["D","E","N","O"]]],
            "doctorData":{"specialist":[["07:00근무자"],["15:00근무자"]],"resident":[],"intern":[]}
          }`;
          const prompt = `너는 병원 간호사 근무표를 구조화하는 정확한 OCR/표 분석기다. 대상 월은 ${targetMonth}이다.
근무표에서 사람별 날짜 1일부터 말일까지 근무 코드를 읽어라.
간호사는 role "n", 보조원은 "a"로 넣는다. 근무 코드는 DAY=D, EVE=E, NIGHT=N, OFF/OFF근무없음=O로 통일한다. 애매한 칸은 추측하지 말고 빈 문자열로 둔다.
반드시 아래 JSON 하나만 출력한다. 설명, markdown, 코드블록을 출력하지 마라.
${schema}
staff의 각 사람은 [role,name,codes]이며 codes 길이는 해당 월 일수와 정확히 같아야 한다. 의사 정보가 확실하지 않으면 doctorData는 빈 객체로 둔다.`;
          let result;
          if (kind === "image") {
            result = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", {
              messages: [
                { role: "system", content: "You extract hospital duty rosters into exact JSON." },
                { role: "user", content: prompt }
              ],
              image: data,
              max_tokens: 7000
            });
          } else {
            result = await env.AI.run("@cf/meta/llama-3.2-3b-instruct", {
              messages: [
                { role: "system", content: "You extract hospital duty rosters into exact JSON." },
                { role: "user", content: prompt + "\n\n엑셀에서 추출한 표:\n" + data }
              ],
              max_tokens: 7000
            });
          }
          let raw = result && (result.response || result.result || result.text || "");
          let parsed;
          try {
            parsed = extractJsonObject(raw);
          } catch (firstError) {
            // Vision 모델이 JSON 대신 표/설명을 반환하는 경우 한 번 더 구조화합니다.
            const recoveryPrompt = `다음은 병원 근무표를 보고 AI가 추출한 원문이다.
대상 월은 ${targetMonth}이다. 원문에서 날짜별 근무를 다시 정리해서 아래 JSON만 출력하라.
설명이나 markdown 없이 JSON만 출력한다.
${schema}
규칙: staff 각 항목은 [role,name,codes], codes는 해당 월의 1일부터 말일까지 정확히 일수만큼. DAY=D, EVE=E, NIGHT=N, OFF=O. 확실하지 않은 값은 빈 문자열.
원문:
${String(raw).slice(0,120000)}`;
            const recovered = await env.AI.run("@cf/meta/llama-3.2-3b-instruct", {
              messages: [
                { role: "system", content: "Return only valid JSON. Never use markdown fences." },
                { role: "user", content: recoveryPrompt }
              ],
              max_tokens: 7000,
              temperature: 0
            });
            const recoveredRaw = recovered && (recovered.response || recovered.result || recovered.text || "");
            parsed = extractJsonObject(recoveredRaw);
          }
          const duty = normalizeDutyImport(parsed, targetMonth);
          await env.FILES.put("duty/" + targetMonth + ".json", JSON.stringify(duty), {
            httpMetadata: { contentType: "application/json; charset=utf-8" },
            customMetadata: { source: "ai-duty-import", importedAt: new Date().toISOString() }
          });
          return jsonResponse({ ok: true, month: targetMonth, duty });
        } catch (error) {
          console.error("duty import error", error);
          const message = String(error && error.message || error);
          if (message.includes("5016") || message.includes("agreement")) {
            return errorResponse("Cloudflare AI의 Llama 이용약관 동의가 필요합니다. Cloudflare Workers AI에서 한 번 동의한 뒤 다시 올려주세요.", 503);
          }
          return errorResponse("근무표 분석에 실패했습니다: " + message.slice(0, 180), 422);
        }
      }

      /*
       * 인증 확인
       */
      const authRole = await getAuthRole(request, env);

      if (!authRole) {
        return errorResponse(
          "로그인이 필요합니다.",
          401
        );
      }

      const requireAdmin = function() {
        if (authRole !== "admin") {
          return errorResponse("관리자 권한이 필요합니다.", 403);
        }
        return null;
      };

      /*
       * DREAM IMAGE
       * 예전 GitHub raw 이미지가 남아 있어도 실제 이미지는 R2에서 제공합니다.
       */
      const dreamImageMatch = url.pathname.match(/^\/api\/dream-image\/([^/]+)$/);
      if (dreamImageMatch && request.method === "GET") {
        const dreamId = decodeURIComponent(dreamImageMatch[1]);

        if (!validNoteId(dreamId)) {
          return errorResponse("잘못된 꿈 이미지 ID입니다.", 400);
        }

        const imagePrefix = "__dream-images__/";
        let imageObject = await env.FILES.get(
          imagePrefix + dreamId + ".jpg"
        );
        let contentType = "image/jpeg";

        if (!imageObject) {
          imageObject = await env.FILES.get(
            imagePrefix + dreamId + ".webp"
          );
          contentType = "image/webp";
        }

        if (!imageObject) {
          return errorResponse("꿈 이미지를 찾을 수 없습니다.", 404);
        }

        return new Response(imageObject.body, {
          status: 200,
          headers: {
            ...corsHeaders,
            "Content-Type": contentType,
            "Cache-Control": "private, max-age=3600"
          }
        });
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

        // 내부 전용 저장 영역은 업무 파일 목록에 노출하지 않습니다.
        if (!prefix) {
          result.delimitedPrefixes = result.delimitedPrefixes.filter(function(folder) {
            return folder !== DREAMS_PREFIX &&
                   folder !== NOTES_PREFIX &&
                   folder !== EVENTS_PREFIX;
          });
        }

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
        const adminError = requireAdmin();
        if (adminError) return adminError;
        const formData =
          await request.formData();

        const file =
          formData.get("file");

        const folder =
          formData.get("folder") || "";

        // 폴더 드롭 시 하위 경로를 유지합니다.
        // 클라이언트가 전달한 상대 경로에서 위험한 경로 요소는 제거합니다.
        const relativePath = String(formData.get("relativePath") || "");
        const safeRelativeParts = relativePath
          .replace(/\\/g, "/")
          .split("/")
          .filter(function(part) {
            return part && part !== "." && part !== "..";
          });
        const relativeFolder = safeRelativeParts
          .slice(0, -1)
          .join("/");

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
        const safeRelativeFolder =
          relativeFolder
            .split("/")
            .filter(function(part) {
              return part && part !== "." && part !== "..";
            })
            .join("/");

        let targetFolder = safeFolder;

        if (safeRelativeFolder) {
          targetFolder = targetFolder
            ? targetFolder + "/" + safeRelativeFolder
            : safeRelativeFolder;
        }

        let key;

        if (targetFolder) {
          key =
            targetFolder +
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
        const adminError = requireAdmin();
        if (adminError) return adminError;
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
        const adminError = requireAdmin();
        if (adminError) return adminError;
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
        const adminError = requireAdmin();
        if (adminError) return adminError;
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
        const adminError = requireAdmin();
        if (adminError) return adminError;
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

            if (
              typeof dream.image === "string" &&
              dream.image.indexOf(
                "https://raw.githubusercontent.com/ikjoo123/ikjoo123.github.io/main/dream-"
              ) === 0
            ) {
              dream.image =
                "/api/dream-image/" +
                encodeURIComponent(dream.id);
            }

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
        const adminError = requireAdmin();
        if (adminError) return adminError;
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
        const adminError = requireAdmin();
        if (adminError) return adminError;
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
        const adminError = requireAdmin();
        if (adminError) return adminError;
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
        const adminError = requireAdmin();
        if (adminError) return adminError;
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
        const adminError = requireAdmin();
        if (adminError) return adminError;
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
        const adminError = requireAdmin();
        if (adminError) return adminError;
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
