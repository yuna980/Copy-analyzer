"use server";

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
              guide: { type: SchemaType.INTEGER },
              note: { type: SchemaType.STRING },
              translateText: { type: SchemaType.STRING }
            },
            required: ["number", "text", "guide", "note", "translateText"]
          }
        }
      }
    });

    const prompt = `
You are an expert copywriter and translator. An image containing text is provided.
Your task is:
1. Extract the text for each numbered item in the image. 
   CRITICAL RULE: If a numbered label (like a box with "2" on it) contains multiple text icons or phrases inside it (for example, "Mobile", "Tablet", "Watch", etc.), you MUST assign the SAME number to all those text elements. For example: "2" for Mobile, "2" for Tablet.
2. For each extracted text, act as a professional copywriter to translate it into standard major broad languages worldwide (e.g., English, Spanish, French, German, Russian, Chinese, Japanese, Korean, Arabic, Portuguese, Hindi, etc.). Make sure the translations are highly intuitive, simple, highly readable, and natural in that language.
3. For each extracted text item, figure out which language yields the LONGEST translated string in terms of character count.
4. Count the number of characters of that longest translation.

Return the result STRICTLY as a JSON array of objects.
Each object must exactly have these 5 keys:
- "number": The item number found or assigned (e.g., "1", "2"). Group texts pointing to the same label under the same number.
- "text": The exact original text extracted from the image.
- "guide": The character count of the longest translation (an integer).
- "note": The name of the language that yielded the longest translation, WRITTEN IN KOREAN ONLY (e.g., "스페인어", "러시아어", "프랑스어", "독일어").
- "translateText": The actual translated string in that longest language.
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
    const data = JSON.parse(text);
    
    return { success: true, data };
  } catch (error: any) {
    console.error("Gemini Translation Length Error:", error);
    return { success: false, error: error.message };
  }
}
