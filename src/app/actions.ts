"use server";

import { GoogleGenerativeAI, SchemaType, GenerationConfig } from "@google/generative-ai";
import { headers } from "next/headers";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

export async function processImageAndTranslate(base64Image: string, mimeType: string, turnstileToken?: string | null) {
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

    // ===== Upstash Redis 연동 구역 (Rate Limit & 일일 모델 폴백) =====
    const redisUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
    const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
    
    let modelName = "gemini-2.5-flash"; // 기본 할당 모델 설정
    
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
      
      // 2. 전체 유저 대상 하루 20회 초과 시 다른 Gemini 모델로 자동 스위칭 (과금/리밋 방어)
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
      if (dailyCount <= 20) {
        modelName = "gemini-2.5-flash";
      } else if (dailyCount <= 40) {
        modelName = "gemini-2.0-flash";
      } else if (dailyCount <= 60) {
        modelName = "gemini-1.5-flash";
      } else if (dailyCount <= 80) {
        modelName = "gemini-1.5-flash-8b"; // 가장 가볍고 할당량이 많은 모델을 마지막 방어선으로 배치
      } else {
        // 총 80회를 넘기면 깔끔하게 사용자에게 안내하고 서버를 보호합니다.
        throw new Error("오늘의 AI 무료 분석 한도(총 80회)가 완전히 소진되었습니다. 서버 비용 보호를 위해 내일 다시 이용해주세요.");
      }
    }
    // 런타임 호출 시점에 API 키를 로드하여 캐싱/undefined 문제를 방지합니다.
    const apiKey = process.env.NEXT_PRIVATE_GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("API 키가 환경 변수에 설정되지 않았습니다.");
    }
    const genAI = new GoogleGenerativeAI(apiKey);
    
    // 할당된 modelName(20회 초과 시 우회 모델)을 기반으로 배열 생성
    const fallbackModels = [modelName, "gemini-2.0-flash", "gemini-1.5-flash", "gemini-1.5-flash-8b"];
    
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

    // 503 서비스 지연(High demand) 발생 시 실시간으로 더 안정적인 이전 모델로 갈아타는 스마트 폴백 전략
    let result;
    let lastError;
    
    for (let attempt = 0; attempt < fallbackModels.length; attempt++) {
      try {
        const currentModelName = fallbackModels[attempt];
        
        // 이전 루프와 동일한 모델이면 스킵(중복 호출 방지)
        if (attempt > 0 && currentModelName === fallbackModels[attempt - 1]) continue;
        
        console.log(`[분석 시도] 사용 모델: ${currentModelName}`);
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
        break; // 성공하면 즉시 루프 탈출
      } catch (err: any) {
        lastError = err;
        if (err.status === 503 || err.status === 429 || err.message?.includes("503") || err.message?.includes("429") || err.message?.includes("high demand") || err.message?.includes("High demand") || err.message?.includes("Quota")) {
          console.log(`[Google API 에러] ${fallbackModels[attempt]} 서버 지연 또는 할당량(Quota/429) 초과 감지. 즉시 다음 모델로 우회합니다... | 에러: ${err.message?.split('\\n')[0]}`);
          // 다음 모델 루프로 넘어가기 전에 약간의 쿨다운 타임
          await new Promise((resolve) => setTimeout(resolve, 500)); 
          continue; // 실패 시 다음 모델로 바로 루프 재배정
        } else {
          // 503/429가 아닌 치명적 에러(예: API키 오류 등)는 즉시 중단
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
          guide: longestText.length,
          note: longestLang || "알 수 없음",
          translateText: longestText
        };
      });
    }
    
    return { success: true, data };
  } catch (error: any) {
    console.error("Gemini Translation Length Error:", error);
    return { success: false, error: error.message };
  }
}
