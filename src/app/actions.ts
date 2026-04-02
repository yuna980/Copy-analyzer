"use server";

export const maxDuration = 60;

import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";

export async function processImageAndTranslate(base64Image: string, mimeType: string) {
  try {
    // 런타임 호출 시점에 API 키를 로드하여 캐싱/undefined 문제를 방지합니다.
    const apiKey = process.env.NEXT_PRIVATE_GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("API 키가 환경 변수에 설정되지 않았습니다.");
    }
    const genAI = new GoogleGenerativeAI(apiKey);
    
    // 현재 입력하신 API 키는 권한상 1.5-pro 호출이 막혀 있어 404 반환됨. 
    // 제공된 키에서 확실하게 지원되는 gemini-2.5-flash를 사용합니다.
    const model = genAI.getGenerativeModel({ 
      model: "gemini-2.5-flash",
      generationConfig: {
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
                  스페인어: { type: SchemaType.STRING },
                  프랑스어: { type: SchemaType.STRING },
                  독일어: { type: SchemaType.STRING },
                  러시아어: { type: SchemaType.STRING },
                  아랍어: { type: SchemaType.STRING },
                  포르투갈어: { type: SchemaType.STRING },
                  이탈리아어: { type: SchemaType.STRING },
                  네덜란드어: { type: SchemaType.STRING },
                  폴란드어: { type: SchemaType.STRING },
                  그리스어: { type: SchemaType.STRING },
                  튀르키예어: { type: SchemaType.STRING },
                  힌디어: { type: SchemaType.STRING },
                  베트남어: { type: SchemaType.STRING },
                  태국어: { type: SchemaType.STRING }
                }
              }
            },
            required: ["number", "text", "translations"]
          }
        }
      }
    });

    const prompt = `
You are an expert copywriter and translator. An image containing text is provided.
Your task is:
1. Extract the text for each numbered item in the image. 
   CRITICAL RULE: If a numbered label (like a box with "2" on it) contains multiple text icons or phrases inside it (for example, "Mobile", "Tablet", "Watch", etc.), you MUST assign the SAME number to all those text elements. For example: "2" for Mobile, "2" for Tablet.
2. For each extracted text, act as a professional copywriter to TRANSLATE it into EXACTLY ALL of the following target languages: Spanish, French, German, Russian, Arabic, Portuguese, Italian, Dutch, Polish, Greek, Turkish, Hindi, Vietnamese, Thai. Make sure the translations are highly intuitive, simple, highly readable, and natural per language.

Return the result STRICTLY as a JSON array of objects.
Each object must exactly have these 3 keys:
- "number": The item number found or assigned (e.g., "1", "2"). Group texts pointing to the same label under the same number.
- "text": The exact original text extracted from the image.
- "translations": An object storing the translated string mapped to its respective language name IN KOREAN as the key (e.g., "스페인어", "프랑스어", "이탈리아어", "독일어", etc.). Provide the translated string for ALL requested languages.
`;

    // 503 서비스 지연(High demand) 발생 시 최대 3번까지 자동 재시도하는 로직 적용
    const MAX_RETRIES = 3;
    let result;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        result = await model.generateContent([
          prompt,
          {
            inlineData: {
              data: base64Image,
              mimeType,
            },
          },
        ]);
        break; // 성공하면 루프 탈출
      } catch (err: any) {
        if (err.status === 503 || err.message?.includes("503") || err.message?.includes("High demand") || err.message?.includes("high demand")) {
          if (attempt === MAX_RETRIES) throw err;
          console.log(`[Google API 503 에러] 서버 지연으로 인해 재시도합니다... (${attempt}/${MAX_RETRIES})`);
          await new Promise((resolve) => setTimeout(resolve, 2000)); // 2초 대기 후 재시도
        } else {
          throw err;
        }
      }
    }

    if (!result || !result.response) {
       throw new Error("결과를 성공적으로 가져오지 못했습니다.");
    }

    const text = result.response.text();
    let data = JSON.parse(text);
    
    // AI의 고질적인 예측 한계를 극복하기 위해, 번역된 14개국 언어 문자열을 서버에서 직접 순회하여 가장 긴 텍스트를 수학적으로 찾아냅니다.
    if (Array.isArray(data)) {
      data = data.map((item: any) => {
        let longestLang = "";
        let longestText = "";
        
        if (item.translations && typeof item.translations === "object") {
           for (const [lang, trans] of Object.entries(item.translations)) {
             const str = String(trans);
             if (str.length > longestText.length) {
               longestText = str;
               longestLang = lang;
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
