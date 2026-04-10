"use server";

import { Redis } from "@upstash/redis";

function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error("Redis가 설정되지 않았습니다.");
  return new Redis({ url, token });
}

// ===== 인증 =====
export async function verifyAdminPassword(password: string): Promise<boolean> {
  const redis = getRedis();
  const stored = (await redis.get<string>("admin_password")) ?? "0723";
  return password === stored;
}

// ===== 대시보드 데이터 =====
export async function getDashboardData() {
  const redis = getRedis();
  const now = new Date();
  const krTime = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const today = krTime.toISOString().split("T")[0];

  // 일일 번역 수
  const dailyCount = (await redis.get<number>(`daily_global_clicks_${today}`)) || 0;

  // 모델별 사용 통계 (Redis Hash)
  const rawModelUsage = await redis.hgetall<Record<string, string>>(`model_usage:${today}`);
  const modelUsage: Record<string, number> = {};
  if (rawModelUsage) {
    for (const [model, count] of Object.entries(rawModelUsage)) {
      modelUsage[model] = Number(count) || 0;
    }
  }

  return { dailyCount, modelUsage, date: today };
}

// ===== 번역 이력 조회 =====
export async function getTranslationHistory(page: number = 1, limit: number = 20) {
  const redis = getRedis();
  const start = (page - 1) * limit;
  const end = start + limit - 1;

  const rawList = await redis.lrange("translation_log", start, end);
  const total = await redis.llen("translation_log");

  const translations = rawList.map((item: any) => {
    if (typeof item === "string") {
      try { return JSON.parse(item); } catch { return item; }
    }
    return item;
  });

  return { translations, total, page, limit };
}

// ===== 개별 번역 결과 조회 (엑셀 다운로드용) =====
export async function getTranslationById(id: string) {
  const redis = getRedis();
  const raw = await redis.get<string>(`translation:${id}`);
  if (!raw) return null;
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return raw; }
  }
  return raw;
}

// ===== 현재 비밀번호 확인 (비밀번호 설정 탭용) =====
export async function getCurrentPassword(password: string) {
  const redis = getRedis();
  const stored = (await redis.get<string>("admin_password")) ?? "0723";
  if (password !== stored) return { success: false as const, password: null };
  return { success: true as const, password: stored };
}

// ===== 비밀번호 변경 =====
export async function changeAdminPassword(currentPassword: string, newPassword: string) {
  const redis = getRedis();
  const stored = (await redis.get<string>("admin_password")) ?? "0723";

  if (currentPassword !== stored) {
    return { success: false, error: "현재 비밀번호가 일치하지 않습니다." };
  }
  if (!/^\d{4}$/.test(newPassword)) {
    return { success: false, error: "비밀번호는 4자리 숫자여야 합니다." };
  }

  await redis.set("admin_password", newPassword);
  return { success: true, error: null };
}
