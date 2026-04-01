"use server";

import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";

const apiKey = process.env.NEXT_PRIVATE_GEMINI_API_KEY!;
const genAI = new GoogleGenerativeAI(apiKey);

export async function processImageAndTranslate(base64Image: string, mimeType: string) {
  try {
    const model = genAI.getGenerativeModel({ 
      model: "gemini-1.5-pro",
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: SchemaType.ARRAY,
          items: {
            type: SchemaType.OBJECT,
            properties: {
              number: { type: SchemaType.STRING },
              example: { type: SchemaType.STRING },
              guide: { type: SchemaType.INTEGER },
              note: { type: SchemaType.STRING }
            },
            required: ["number", "example", "guide", "note"]
          }
        }
      }
    });

    const prompt = `
You are an expert copywriter and translator. An image containing text is provided.
Your task is:
1. Extract the text for each numbered item in the image. If there are no explicit numbers but distinct text elements, group they and number them yourself starting from 1.
2. For each extracted text, act as a professional copywriter to translate it into standard major broad languages worldwide (e.g., English, Spanish, French, German, Russian, Chinese, Japanese, Korean, Arabic, Portuguese, Hindi, etc.). Make sure the translations are highly intuitive, simple, highly readable, and natural in that language.
3. For each extracted text item, figure out which language yields the LONGEST translated string in terms of character count.
4. Count the number of characters of that longest translation.

Return the result STRICTLY as a JSON array of objects.
Each object must exactly have these 4 keys:
- "number": The item number found or assigned (e.g., "1", "2").
- "example": The exact original text extracted from the image.
- "guide": The character count of the longest translation (a number).
- "note": The name of the language that yielded the longest translation (e.g., "Russian", "Spanish").
`;

    const result = await model.generateContent([
      prompt,
      {
        inlineData: {
          data: base64Image,
          mimeType,
        },
      },
    ]);

    const text = result.response.text();
    const data = JSON.parse(text);
    
    return { success: true, data };
  } catch (error: any) {
    console.error("Gemini Translation Length Error:", error);
    return { success: false, error: error.message };
  }
}
