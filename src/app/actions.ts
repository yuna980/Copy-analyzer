"use server";

import { GoogleGenerativeAI, SchemaType, GenerationConfig } from "@google/generative-ai";
import { headers } from "next/headers";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

// =====================================================================
// 🔄 동적 모델 탐색 시스템 (Dynamic Model Discovery)
// Google API에서 실시간으로 사용 가능한 모델 목록을 가져와서
// 모델 폐기(deprecation)로 인한 404 에러를 영구적으로 방지합니다.
// =====================================================================

interface ModelInfo {
  name: string;        // e.g. "models/gemini-2.5-flash"
  displayName: string;
  supportedGenerationMethods: string[];
}

// 메모리 캐시: 서버 인스턴스 수명 동안 모델 목록을 캐싱 (5분 TTL)
let cachedModels: string[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5분

/**
 * Google의 listModels API를 호출해서 현재 사용 가능한 flash 계열 모델을 동적으로 가져옴.
 * - generateContent를 지원하는 모델만 필터링
 * - flash 계열만 선별 (비용 효율 극대화)
 * - 결과를 5분간 캐싱하여 매 요청마다 API를 때리지 않음
 */
async function getAvailableFlashModels(apiKey: string): Promise<string[]> {
  // 캐시가 유효하면 즉시 반환
  if (cachedModels && (Date.now() - cacheTimestamp) < CACHE_TTL_MS) {
    return cachedModels;
  }

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
      { next: { revalidate: 300 } } // Next.js fetch 캐시도 5분
    );

    if (!res.ok) {
      console.warn(`[모델 탐색] listModels API 실패 (${res.status}), 하드코딩 폴백 사용`);
      return getHardcodedFallback();
    }

    const json = await res.json();
    const allModels: ModelInfo[] = json.models || [];

    // 1단계: generateContent 지원 + flash 계열만 필터링
    const flashModels = allModels
      .filter((m) =>
        m.supportedGenerationMethods?.includes("generateContent") &&
        m.name.includes("flash")
      )
      .map((m) => m.name.replace("models/", "")); // "models/gemini-2.5-flash" → "gemini-2.5-flash"

    if (flashModels.length === 0) {
      console.warn("[모델 탐색] 사용 가능한 flash 모델이 없음, 하드코딩 폴백 사용");
      return getHardcodedFallback();
    }

    // 2단계: 우선순위 정렬 (최신 & 고성능 우선, lite는 후순위)
    const priorityOrder = [
      "gemini-2.5-flash",
      "gemini-2.0-flash",
      "gemini-2.5-flash-lite",
      "gemini-2.0-flash-lite",
    ];

    const sorted: string[] = [];
    // 먼저 우선순위에 매칭되는 모델을 순서대로 추가
    for (const preferred of priorityOrder) {
      const match = flashModels.find((m) => m === preferred);
      if (match) sorted.push(match);
    }
    // 우선순위에 없는 새로운 flash 모델도 자동으로 뒤에 추가 (미래 모델 자동 대응)
    for (const model of flashModels) {
      if (!sorted.includes(model) && !model.includes("preview") && !model.includes("exp")) {
        sorted.push(model);
      }
    }

    console.log(`[모델 탐색] 사용 가능한 flash 모델 ${sorted.length}개 발견: ${sorted.join(", ")}`);

    // 캐시 갱신
    cachedModels = sorted;
    cacheTimestamp = Date.now();

    return sorted;
  } catch (error) {
    console.warn("[모델 탐색] API 호출 실패, 하드코딩 폴백 사용:", error);
    return getHardcodedFallback();
  }
}

/**
 * listModels API 자체가 실패했을 때의 최후 방어선.
 * 이 목록도 시간이 지나면 폐기될 수 있지만,
 * 정상적인 경우 listModels가 항상 동적 목록을 제공하므로 여기까지 올 일은 거의 없음.
 */
function getHardcodedFallback(): string[] {
  return ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash-lite"];
}

export async function processImageAndTranslate(base64Image: string, mimeType: string, turnstileToken?: string | null, thumbnail?: string | null) {
  try {
    // 1단계: Cloudflare Turnstile 봇(스크립트) 접근 검증
    const turnstileSecret = process.env.TURNSTILE_SECRET_KEY;
    if (turnstileSecret) {
      if (!turnstileToken) throw new Error("봇 방어 토큰이 없습니다. 버튼을 다시 눌러주세요.");
      const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `secret=${turnstileSecret}&response=${turnstileToken}`
      });
      const data = await res.json();
      if (!data.success) throw new Error("자동화 봇으로 의심되어 차단되었습니다.");
    }

    // 런타임 호출 시점에 API 키를 로드하여 캐싱/undefined 문제를 방지합니다.
    const apiKey = process.env.NEXT_PRIVATE_GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("API 키가 환경 변수에 설정되지 않았습니다.");
    }

    // ===== 🔄 동적 모델 목록 로딩 (Google API에서 실시간 조회) =====
    const availableModels = await getAvailableFlashModels(apiKey);

    // ===== Upstash Redis 연동 구역 (Rate Limit & 일일 모델 폴백) =====
    const redisUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
    const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
    
    // 기본 모델은 동적 목록의 첫 번째 (가장 고성능)
    let primaryModelIndex = 0;
    
    if (redisUrl && redisToken) {
      const redis = new Redis({ url: redisUrl, token: redisToken });
      
      // 1. IP 기반 무한 호출 방어 (Rate Limiting) - 스크립트 테러 방지용
      const ratelimit = new Ratelimit({
        redis: redis,
        limiter: Ratelimit.slidingWindow(20, "1 h"),
      });
      
      const reqHeaders = await headers();
      const ip = reqHeaders.get("x-forwarded-for") || "127.0.0.1";
      const { success } = await ratelimit.limit(`ratelimit_${ip}`);
      
      if (!success) {
        throw new Error("API 호출 한도를 초과했습니다. 잠시 후 다시 시도해주세요 (1시간 당 제한).");
      }
      
      // 2. 전체 유저 대상 하루 N회 초과 시 다른 Gemini 모델로 자동 스위칭 (과금/리밋 방어)
      // 한국 시간 기준으로 날짜 가져오기 (YYYY-MM-DD 형식)
      const now = new Date();
      const krTime = new Date(now.getTime() + (9 * 60 * 60 * 1000));
      const today = krTime.toISOString().split("T")[0];
      const dailyKey = `daily_global_clicks_${today}`;
      
      const dailyCount = await redis.incr(dailyKey);
      if (dailyCount === 1) {
        await redis.expire(dailyKey, 86400 * 2); // 넉넉하게 48시간 후 자동 소멸
      }
      
      // 구간별로 모델을 순차적으로 우회 (모델별 무료 할당량을 영혼까지 끌어쓰기)
      // 동적으로 가져온 모델 수에 맞춰 자동으로 구간을 나눔
      const REQUESTS_PER_MODEL = 20;
      const maxRequests = availableModels.length * REQUESTS_PER_MODEL;
      
      if (dailyCount > maxRequests) {
        throw new Error(`오늘의 AI 무료 분석 한도(총 ${maxRequests}회)가 완전히 소진되었습니다. 서버 비용 보호를 위해 내일 다시 이용해주세요.`);
      }
      
      // 20회 단위로 다음 모델로 자동 스위칭
      primaryModelIndex = Math.min(
        Math.floor((dailyCount - 1) / REQUESTS_PER_MODEL),
        availableModels.length - 1
      );
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    
    // 폴백 모델 배열: 현재 할당 모델부터 시작해서 나머지 모델 순서대로 (중복 제거)
    const fallbackModels: string[] = [];
    // 현재 모델부터 끝까지 추가
    for (let i = primaryModelIndex; i < availableModels.length; i++) {
      fallbackModels.push(availableModels[i]);
    }
    // 현재 모델 이전의 모델도 마지막 방어선으로 추가 (역순으로 전부 시도)
    for (let i = primaryModelIndex - 1; i >= 0; i--) {
      if (!fallbackModels.includes(availableModels[i])) {
        fallbackModels.push(availableModels[i]);
      }
    }
    
    console.log(`[모델 선택] 우선 모델: ${fallbackModels[0]} | 폴백 순서: ${fallbackModels.join(" → ")}`);
    
    // 세대 구성(Config)은 모든 모델이 동일하게 공유합니다.
    const generationConfig: GenerationConfig = {
      responseMimeType: "application/json",
      responseSchema: {
        type: SchemaType.ARRAY,
        items: {
          type: SchemaType.OBJECT,
          properties: {
            number: { type: SchemaType.STRING },
            text: { type: SchemaType.STRING },
            translations: {
              type: SchemaType.OBJECT,
              properties: {
                스페인어: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
                프랑스어: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
                독일어: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
                러시아어: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
                아랍어: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
                포르투갈어: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
                이탈리아어: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
                네덜란드어: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
                폴란드어: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
                그리스어: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
                튀르키예어: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
                힌디어: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
                베트남어: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
                태국어: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } }
              }
            }
          },
          required: ["number", "text", "translations"]
        }
      }
    };

    const prompt = `
You are an expert copywriter and translator. An image containing text is provided.
Your task is:
1. Extract the text for each numbered item in the image. 
   CRITICAL RULE ON EXPLICIT WIREFRAME ANNOTATIONS VS INTERNAL UI ELEMENTS: 
   The user has manually drawn external wireframe annotation boxes (usually bright colored outlines/badges with hierarchical identifiers like "1", "2", "2-1", "3-1a") ON TOP OF the UI design to explicitly group sections.
   You MUST map each extracted text ONLY to these external wireframe annotation box identifiers.
   - Do NOT confuse the UI's internal graphic labels (e.g., black/gray step indicator circles like ❶, ❷, ❸ inside a progress bar) with the user's external annotation identifiers. Internal UI numbers are NOT annotation labels. 
   - STRICT FILTER: Never extract or translate standalone numerals that represent graphical progress steps (like a solitary "1" or "3" inside a dark circle). Only extract real translatable copy/words.
   - HIERARCHICAL MATCHING: For any real text (e.g., "Device details" or "Confirm IMEI"):
     * Check if a specific sub-annotation box (e.g., "2-2") points directly to or surrounds this specific text. If yes, assign it that specific identifier ("2-2").
     * If the text does NOT have its own specific sub-annotation box, BUT it is encapsulated within a larger parent annotation box (e.g., a massive box labeled "2"), assign it the parent's identifier ("2"). For example, "Confirm IMEI" sits inside the massive "2" box and has no specific sub-box, so it MUST be assigned "2", absolutely ignoring the UI's internal ❸ circle sitting above it.
2. For each extracted text, act as a professional copywriter to TRANSLATE it into EXACTLY ALL of the following target languages: Spanish, French, German, Russian, Arabic, Portuguese, Italian, Dutch, Polish, Greek, Turkish, Hindi, Vietnamese, Thai. 
   CRITICAL REQUIREMENT: For EVERY single language, you MUST provide an array of exactly 2 different NATURAL UI variations. 
     - Variation 1: Direct & Concise (e.g., extremely short literal translation commonly used in small UI buttons).
     - Variation 2: Standard & Natural (e.g., standard phrasing used in software interfaces).
     STRICT PROHIBITION: DO NOT add polite filler words. DO NOT add extra semantic meaning. For example, translating "See more" to something like "Click here for more information" is STRICTLY FORBIDDEN. Keep the exact semantic meaning and intent of the original text.
   Return these 2 string variations inside the array for every language.

Return the result STRICTLY as a JSON array of objects.
Each object must exactly have these 3 keys:
- "number": The item number found or assigned (e.g., "1", "2"). Group texts pointing to the same label under the same number.
- "text": The exact original text extracted from the image.
- "translations": An object storing the translated string mapped to its respective language name IN KOREAN as the key (e.g., "스페인어", "프랑스어", "이탈리아어", "독일어", etc.). Provide the translated string for ALL requested languages.
`;

    // 모든 에러(404/429/503)에 자동 대응하는 스마트 폴백 전략
    let result;
    let lastError;
    let usedModelName = "unknown";
    
    for (let attempt = 0; attempt < fallbackModels.length; attempt++) {
      try {
        const currentModelName = fallbackModels[attempt];
        
        console.log(`[분석 시도 ${attempt + 1}/${fallbackModels.length}] 사용 모델: ${currentModelName}`);
        const currentModel = genAI.getGenerativeModel({
          model: currentModelName,
          generationConfig
        });
        
        result = await currentModel.generateContent([
          prompt,
          {
            inlineData: {
              data: base64Image,
              mimeType,
            },
          },
        ]);
        usedModelName = currentModelName; // 성공한 모델명 기록
        break; // 성공하면 즉시 루프 탈출
      } catch (err: any) {
        lastError = err;
        const errMsg = err.message || "";
        const errStatus = err.status || 0;
        
        // 복구 가능한 에러: 모델 폐기(404), 할당량 초과(429), 서버 과부하(503)
        const isRecoverable = 
          [404, 429, 503].includes(errStatus) ||
          /404|429|503|not found|high demand|quota/i.test(errMsg);
        
        if (isRecoverable) {
          console.log(`[폴백] ${fallbackModels[attempt]} 실패 (${errStatus || "unknown"}). 다음 모델로 우회... | ${errMsg.split("\n")[0]}`);
          // 폐기된 모델이 감지되면 캐시를 무효화하여 다음 요청에서 최신 목록을 받아옴
          if (errStatus === 404 || /not found/i.test(errMsg)) {
            cachedModels = null;
            cacheTimestamp = 0;
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
          continue;
        } else {
          // 복구 불가능한 치명적 에러(예: API키 오류 등)는 즉시 중단
          throw err;
        }
      }
    }

    if (!result || !result.response) {
       throw lastError || new Error("서버 폭주로 인해 모든 백업 AI 모델이 응답하지 않습니다. 잠시 후 1분 뒤에 다시 시도해주세요.");
    }

    const text = result.response.text();
    let data = JSON.parse(text);
    
    // AI의 고질적인 예측 한계를 극복하기 위해, 번역된 14개국 언어 문자열을 서버에서 직접 순회하여 가장 긴 텍스트를 수학적으로 찾아냅니다.
    if (Array.isArray(data)) {
      data = data.map((item: any) => {
        let longestLang = "";
        let longestText = "";
        
        if (item.translations && typeof item.translations === "object") {
           for (const [lang, transArray] of Object.entries(item.translations)) {
             if (Array.isArray(transArray)) {
               for (const trans of transArray) {
                 const str = String(trans);
                 if (str.length > longestText.length) {
                   longestText = str;
                   longestLang = lang;
                 }
               }
             }
           }
        }
        
        return {
          number: item.number || "",
          text: item.text || "",
          textCharCount: (item.text || "").length,
          guide: longestText.length,
          note: longestLang || "알 수 없음",
          translateText: longestText
        };
      });
    }
    
    // ===== 📊 백오피스용 번역 로그 기록 =====
    try {
      const logRedisUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
      const logRedisToken = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
      if (logRedisUrl && logRedisToken) {
        const logRedis = new Redis({ url: logRedisUrl, token: logRedisToken });
        const recordId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const krNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
        const todayStr = krNow.toISOString().split("T")[0];

        const record = {
          id: recordId,
          timestamp: new Date().toISOString(),
          thumbnail: thumbnail || null,
          modelUsed: usedModelName,
          success: true,
        };

        await logRedis.lpush("translation_log", JSON.stringify(record));
        await logRedis.ltrim("translation_log", 0, 499); // 최근 500건만 보관
        await logRedis.set(`translation:${recordId}`, JSON.stringify(data), { ex: 7 * 86400 }); // 7일 TTL
        await logRedis.hincrby(`model_usage:${todayStr}`, usedModelName, 1);
        await logRedis.expire(`model_usage:${todayStr}`, 86400 * 2);
        // 대시보드용 성공 카운터
        await logRedis.incr(`daily_success:${todayStr}`);
        await logRedis.expire(`daily_success:${todayStr}`, 86400 * 2);
      }
    } catch (logErr) {
      console.error("[번역 로그 기록 실패]", logErr);
    }

    return { success: true, data };
  } catch (error: any) {
    console.error("Gemini Translation Length Error:", error);

    // ===== 📊 실패 로그도 기록 =====
    try {
      const logRedisUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
      const logRedisToken = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
      if (logRedisUrl && logRedisToken) {
        const logRedis = new Redis({ url: logRedisUrl, token: logRedisToken });
        const recordId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const record = {
          id: recordId,
          timestamp: new Date().toISOString(),
          thumbnail: thumbnail || null,
          modelUsed: "N/A",
          success: false,
          errorMessage: error.message,
        };
        await logRedis.lpush("translation_log", JSON.stringify(record));
        await logRedis.ltrim("translation_log", 0, 499);
        // 대시보드용 실패 카운터
        const krNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
        const todayStr = krNow.toISOString().split("T")[0];
        await logRedis.incr(`daily_fail:${todayStr}`);
        await logRedis.expire(`daily_fail:${todayStr}`, 86400 * 2);
      }
    } catch (logErr) {
      console.error("[실패 로그 기록 실패]", logErr);
    }

    return { success: false, error: error.message };
  }
}

