"use server";

import { createClient } from "@supabase/supabase-js";

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Supabase 환경변수가 설정되지 않았습니다.");
  return createClient(url, key);
}

// ===== 인증 =====
export async function verifyAdminPassword(password: string): Promise<boolean> {
  const supabase = getSupabase();
  const { data } = await supabase
    .from("admin_settings")
    .select("value")
    .eq("key", "admin_password")
    .single();
  const stored = data?.value ?? "0723";
  return password === stored;
}

// ===== 대시보드 데이터 =====
export async function getDashboardData() {
  const supabase = getSupabase();
  const now = new Date();
  const krTime = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const today = krTime.toISOString().split("T")[0];

  // 🧹 7일 이상 된 번역 로그 자동 삭제
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  await supabase
    .from("translation_logs")
    .delete()
    .lt("created_at", sevenDaysAgo.toISOString());

  // 한국 시간 기준 오늘 범위 (UTC 변환)
  const krMidnight = new Date(`${today}T00:00:00+09:00`);
  const krEndOfDay = new Date(`${today}T23:59:59.999+09:00`);

  // 성공 수
  const { count: successCount } = await supabase
    .from("translation_logs")
    .select("*", { count: "exact", head: true })
    .gte("created_at", krMidnight.toISOString())
    .lte("created_at", krEndOfDay.toISOString())
    .eq("success", true);

  // 실패 수
  const { count: failCount } = await supabase
    .from("translation_logs")
    .select("*", { count: "exact", head: true })
    .gte("created_at", krMidnight.toISOString())
    .lte("created_at", krEndOfDay.toISOString())
    .eq("success", false);

  // 모델별 사용 통계 + 텍스트 추출량 분석용 result_data까지 가져옴
  const { data: todayLogs } = await supabase
    .from("translation_logs")
    .select("model_used, result_data")
    .gte("created_at", krMidnight.toISOString())
    .lte("created_at", krEndOfDay.toISOString())
    .eq("success", true);

  const modelUsage: Record<string, number> = {};
  const charCounts: number[] = []; // 건별 총 글자수 저장

  if (todayLogs) {
    for (const log of todayLogs) {
      const model = log.model_used;
      modelUsage[model] = (modelUsage[model] || 0) + 1;

      // result_data에서 텍스트 글자수 합산
      if (Array.isArray(log.result_data)) {
        let totalChars = 0;
        for (const item of log.result_data) {
          if (item.text && typeof item.text === "string") {
            totalChars += item.text.length;
          }
        }
        if (totalChars > 0) {
          charCounts.push(totalChars);
        }
      }
    }
  }

  // 텍스트 추출량 통계 계산
  const textStats = {
    count: charCounts.length,
    avg: charCounts.length > 0 ? Math.round(charCounts.reduce((a, b) => a + b, 0) / charCounts.length) : 0,
    max: charCounts.length > 0 ? Math.max(...charCounts) : 0,
    min: charCounts.length > 0 ? Math.min(...charCounts) : 0,
    // 분포 구간: ~50자, 51~100자, 101~200자, 201자~
    distribution: {
      light: charCounts.filter(c => c <= 50).length,
      medium: charCounts.filter(c => c > 50 && c <= 100).length,
      heavy: charCounts.filter(c => c > 100 && c <= 200).length,
      extreme: charCounts.filter(c => c > 200).length,
    },
  };

  return {
    successCount: successCount || 0,
    failCount: failCount || 0,
    modelUsage,
    textStats,
    date: today,
  };
}

// ===== 번역 이력 조회 =====
export async function getTranslationHistory(page: number = 1, limit: number = 10) {
  const supabase = getSupabase();
  const start = (page - 1) * limit;

  const { data, count } = await supabase
    .from("translation_logs")
    .select("id, created_at, thumbnail, model_used, success, error_message, ip_address", {
      count: "exact",
    })
    .order("created_at", { ascending: false })
    .range(start, start + limit - 1);

  const translations = (data || []).map((row) => ({
    id: row.id,
    timestamp: row.created_at,
    thumbnail: row.thumbnail,
    modelUsed: row.model_used,
    success: row.success,
    errorMessage: row.error_message,
    ipAddress: row.ip_address,
  }));

  return { translations, total: count || 0, page, limit };
}

// ===== 개별 번역 결과 조회 (엑셀 다운로드용) =====
export async function getTranslationById(id: string) {
  const supabase = getSupabase();
  const { data } = await supabase
    .from("translation_logs")
    .select("result_data")
    .eq("id", id)
    .single();
  return data?.result_data || null;
}

// ===== 현재 비밀번호 확인 (비밀번호 설정 탭용) =====
export async function getCurrentPassword(password: string) {
  const supabase = getSupabase();
  const { data } = await supabase
    .from("admin_settings")
    .select("value")
    .eq("key", "admin_password")
    .single();
  const stored = data?.value ?? "0723";
  if (password !== stored) return { success: false as const, password: null };
  return { success: true as const, password: stored };
}

// ===== 비밀번호 변경 =====
export async function changeAdminPassword(currentPassword: string, newPassword: string) {
  const supabase = getSupabase();
  const { data } = await supabase
    .from("admin_settings")
    .select("value")
    .eq("key", "admin_password")
    .single();

  const stored = data?.value ?? "0723";

  if (currentPassword !== stored) {
    return { success: false, error: "현재 비밀번호가 일치하지 않습니다." };
  }
  if (!/^\d{4}$/.test(newPassword)) {
    return { success: false, error: "비밀번호는 4자리 숫자여야 합니다." };
  }

  await supabase.from("admin_settings").upsert({
    key: "admin_password",
    value: newPassword,
    updated_at: new Date().toISOString(),
  });

  return { success: true, error: null };
}
