"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import * as XLSX from "xlsx";
import {
  verifyAdminPassword,
  getDashboardData,
  getTranslationHistory,
  getTranslationById,
  getCurrentPassword,
  changeAdminPassword,
} from "./actions";
import styles from "./page.module.css";

// ===== 타입 정의 =====
interface TranslationRecord {
  id: string;
  timestamp: string;
  thumbnail: string | null;
  modelUsed: string;
  success: boolean;
  errorMessage?: string;
  ipAddress?: string;
}

interface DashboardData {
  successCount: number;
  failCount: number;
  modelUsage: Record<string, number>;
  textStats: {
    count: number;
    avg: number;
    max: number;
    min: number;
    distribution: {
      light: number;
      medium: number;
      heavy: number;
      extreme: number;
    };
  };
  date: string;
}

// ===== 메인 컴포넌트 =====
export default function AdminPage() {
  // 인증 상태
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [pin, setPin] = useState(["", "", "", ""]);
  const [loginError, setLoginError] = useState("");
  const pinRefs = useRef<(HTMLInputElement | null)[]>([]);

  // 대시보드 & 탭
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [activeTab, setActiveTab] = useState<"history" | "password">("history");

  // 번역 이력
  const [translations, setTranslations] = useState<TranslationRecord[]>([]);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyTotal, setHistoryTotal] = useState(0);

  // 비밀번호 설정 탭
  const [pwTabUnlocked, setPwTabUnlocked] = useState(false);
  const [pwTabPin, setPwTabPin] = useState(["", "", "", ""]);
  const pwTabPinRefs = useRef<(HTMLInputElement | null)[]>([]);
  const [pwTabError, setPwTabError] = useState("");
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [pwChangeMsg, setPwChangeMsg] = useState("");
  const [pwChangeError, setPwChangeError] = useState("");

  // 상세 이미지 더블클릭 모달
  const [selectedImage, setSelectedImage] = useState<string | null>(null);

  // 로딩 상태
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [isLoadingDashboard, setIsLoadingDashboard] = useState(false);

  // ===== 핀 입력 핸들러 (재사용) =====
  const handlePinChange = useCallback(
    (
      index: number,
      value: string,
      setter: React.Dispatch<React.SetStateAction<string[]>>,
      refs: React.MutableRefObject<(HTMLInputElement | null)[]>
    ) => {
      if (!/^\d*$/.test(value)) return;
      const digit = value.slice(-1);
      setter((prev) => {
        const next = [...prev];
        next[index] = digit;
        return next;
      });
      if (digit && index < 3) {
        refs.current[index + 1]?.focus();
      }
    },
    []
  );

  const handlePinKeyDown = useCallback(
    (
      e: React.KeyboardEvent<HTMLInputElement>,
      index: number,
      getter: string[],
      refs: React.MutableRefObject<(HTMLInputElement | null)[]>
    ) => {
      if (e.key === "Backspace" && !getter[index] && index > 0) {
        refs.current[index - 1]?.focus();
      }
    },
    []
  );

  // ===== 로그인 =====
  const handleLogin = async () => {
    const password = pin.join("");
    if (password.length !== 4) return;
    setLoginError("");
    const valid = await verifyAdminPassword(password);
    if (valid) {
      setIsAuthenticated(true);
    } else {
      setLoginError("비밀번호가 일치하지 않습니다.");
      setPin(["", "", "", ""]);
      pinRefs.current[0]?.focus();
    }
  };

  // ===== 대시보드 & 이력 로드 =====
  const loadDashboard = useCallback(async () => {
    try {
      setIsLoadingDashboard(true);
      const data = await getDashboardData();
      setDashboard(data);
    } catch (err) {
      console.error("대시보드 로드 실패:", err);
    } finally {
      setIsLoadingDashboard(false);
    }
  }, []);

  const loadHistory = useCallback(async (page: number) => {
    try {
      setIsLoadingHistory(true);
      const data = await getTranslationHistory(page, 10);
      setTranslations(data.translations);
      setHistoryTotal(data.total);
      setHistoryPage(page);
    } catch (err) {
      console.error("이력 로드 실패:", err);
    } finally {
      setIsLoadingHistory(false);
    }
  }, []);

  useEffect(() => {
    if (isAuthenticated) {
      loadDashboard();
      loadHistory(1);
    }
  }, [isAuthenticated, loadDashboard, loadHistory]);

  // ===== 엑셀 다운로드 =====
  const handleDownloadResult = async (id: string, timestamp: string) => {
    try {
      const data = await getTranslationById(id);
      if (!data || !Array.isArray(data)) {
        alert("번역 데이터가 만료되었거나 존재하지 않습니다. (7일 보관)");
        return;
      }
      const excelData = data.map((row: any) => ({
        Number: row.number,
        Text: row.text,
        "MAX CHAR": row.textCharCount,
        Note: row.note,
        "Translate Text": row.translateText,
        "TRANSLATE MAX CHAR": row.guide,
      }));
      const ws = XLSX.utils.json_to_sheet(excelData);
      ws["!cols"] = [
        { wch: 10 },
        { wch: 40 },
        { wch: 12 },
        { wch: 15 },
        { wch: 50 },
        { wch: 20 },
      ];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Translation");
      const dateStr = timestamp.split("T")[0];
      XLSX.writeFile(wb, `translation_${dateStr}_${id.slice(0, 8)}.xlsx`);
    } catch (err) {
      console.error("다운로드 실패:", err);
      alert("다운로드에 실패했습니다.");
    }
  };

  // ===== 비밀번호 탭 잠금해제 =====
  const handlePwTabUnlock = async () => {
    const password = pwTabPin.join("");
    if (password.length !== 4) return;
    setPwTabError("");
    const res = await getCurrentPassword(password);
    if (res.success && res.password) {
      setPwTabUnlocked(true);
      setCurrentPw(res.password);
    } else {
      setPwTabError("비밀번호가 일치하지 않습니다.");
      setPwTabPin(["", "", "", ""]);
      pwTabPinRefs.current[0]?.focus();
    }
  };

  // ===== 비밀번호 변경 =====
  const handleChangePassword = async () => {
    setPwChangeMsg("");
    setPwChangeError("");

    if (!/^\d{4}$/.test(newPw)) {
      setPwChangeError("새 비밀번호는 4자리 숫자여야 합니다.");
      return;
    }
    if (newPw !== confirmPw) {
      setPwChangeError("새 비밀번호가 일치하지 않습니다.");
      return;
    }

    const res = await changeAdminPassword(currentPw, newPw);
    if (res.success) {
      setCurrentPw(newPw);
      setNewPw("");
      setConfirmPw("");
      setPwChangeMsg("비밀번호가 성공적으로 변경되었습니다.");
    } else {
      setPwChangeError(res.error || "변경에 실패했습니다.");
    }
  };

  // ===== 시간 포맷 =====
  const formatTime = (iso: string) => {
    const d = new Date(iso);
    const kr = new Date(d.getTime() + 9 * 60 * 60 * 1000);
    const mm = String(kr.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(kr.getUTCDate()).padStart(2, "0");
    const hh = String(kr.getUTCHours()).padStart(2, "0");
    const mi = String(kr.getUTCMinutes()).padStart(2, "0");
    return `${mm}/${dd} ${hh}:${mi}`;
  };

  // ===== 렌더: 로그인 화면 =====
  if (!isAuthenticated) {
    return (
      <div className={styles.container}>
        <div className={styles.loginWrapper}>
          <div className={styles.loginCard}>
            <div className={styles.loginIcon}>🔐</div>
            <h1 className={styles.loginTitle}>Admin Access</h1>
            <p className={styles.loginSubtitle}>
              백오피스 접근을 위해 비밀번호를 입력하세요
            </p>
            <div className={styles.pinInputRow}>
              {pin.map((digit, i) => (
                <input
                  key={i}
                  ref={(el) => { pinRefs.current[i] = el; }}
                  type="password"
                  inputMode="numeric"
                  maxLength={1}
                  value={digit}
                  className={styles.pinDigit}
                  onChange={(e) =>
                    handlePinChange(i, e.target.value, setPin, pinRefs)
                  }
                  onKeyDown={(e) => handlePinKeyDown(e, i, pin, pinRefs)}
                  onKeyUp={(e) => {
                    if (e.key === "Enter" && pin.every((d) => d)) handleLogin();
                  }}
                />
              ))}
            </div>
            <button className={styles.loginButton} onClick={handleLogin}>
              접속하기
            </button>
            {loginError && (
              <div className={styles.loginError}>{loginError}</div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ===== 렌더: 대시보드 =====
  const totalPages = Math.ceil(historyTotal / 10);

  return (
    <div className={styles.container}>
      <div className={styles.content}>
        {/* 헤더 */}
        <div className={styles.header}>
          <h1 className={styles.pageTitle}>📊 Copy Analyzer Admin</h1>
        </div>

        {/* 대시보드 카드 */}
        {dashboard && (
          <div className={styles.dashboardGrid}>
            <div className={styles.statCard}>
              <div className={styles.statLabel}>오늘 번역 수</div>
              <div className={styles.statValue}>
                {dashboard.successCount}
                {dashboard.failCount > 0 && (
                  <span style={{ fontSize: '0.9rem', fontWeight: 600, color: '#f87171', marginLeft: '0.5rem' }}>
                    (오류발생 : {dashboard.failCount})
                  </span>
                )}
              </div>
              <div className={styles.statDate}>{dashboard.date}</div>
            </div>
            <div className={styles.statCard}>
              <div className={styles.statLabel}>
                AI 모델별 일일 사용량 (모델당 20회)
              </div>
              <div className={styles.modelList}>
                {Object.keys(dashboard.modelUsage).length > 0 ? (() => {
                  const entries = Object.entries(dashboard.modelUsage).sort(([, a], [, b]) => b - a);
                  const QUOTA = 20;
                  const totalUsed = entries.reduce((sum, [, count]) => sum + count, 0);
                  const totalQuota = entries.length * QUOTA;
                  return (
                    <>
                      <div className={styles.modelTotal}>
                        총 사용량 <strong>{totalUsed}</strong> / {totalQuota}회
                      </div>
                      {entries.map(([model, count]) => {
                        const pct = Math.min(Math.round((count / QUOTA) * 100), 100);
                        const color = pct >= 90 ? '#ef4444' : pct >= 60 ? '#fbbf24' : '#34d399';
                        return (
                          <div key={model} className={styles.modelRow}>
                            <div className={styles.modelRowTop}>
                              <span className={styles.modelDot} style={{ backgroundColor: color }}></span>
                              <span className={styles.modelName}>{model}</span>
                              <span className={styles.modelCount}>
                                <strong>{count}</strong>
                                <span className={styles.modelPct}> / {QUOTA}회</span>
                              </span>
                            </div>
                            <div className={styles.modelBarBg}>
                              <div className={styles.modelBarFill} style={{ width: `${pct}%`, backgroundColor: color }}></div>
                            </div>
                          </div>
                        );
                      })}
                    </>
                  );
                })() : (
                  <div className={styles.emptyModelText}>
                    오늘 사용된 모델이 없습니다
                  </div>
                )}
              </div>
            </div>

            {/* 텍스트 추출량 분석 카드 */}
            <div className={styles.statCard}>
              <div className={styles.statLabel}>텍스트 추출량 분석</div>
              {dashboard.textStats.count > 0 ? (
                <>
                  <div className={styles.textStatsGrid}>
                    <div className={styles.textStatItem}>
                      <div className={styles.textStatValue}>{dashboard.textStats.avg}</div>
                      <div className={styles.textStatLabel}>평균 글자</div>
                    </div>
                    <div className={styles.textStatItem}>
                      <div className={styles.textStatValue}>{dashboard.textStats.max}</div>
                      <div className={styles.textStatLabel}>최대 글자</div>
                    </div>
                    <div className={styles.textStatItem}>
                      <div className={styles.textStatValue}>{dashboard.textStats.min}</div>
                      <div className={styles.textStatLabel}>최소 글자</div>
                    </div>
                    <div className={styles.textStatItem}>
                      <div className={styles.textStatValue}>{dashboard.textStats.count}</div>
                      <div className={styles.textStatLabel}>분석 건수</div>
                    </div>
                  </div>
                  <div className={styles.distTitle}>건수별 글자 분포</div>
                  <div className={styles.distList}>
                    {[
                      { label: '~50자 (가벼움)', count: dashboard.textStats.distribution.light, color: '#34d399' },
                      { label: '51~100자', count: dashboard.textStats.distribution.medium, color: '#38bdf8' },
                      { label: '101~200자', count: dashboard.textStats.distribution.heavy, color: '#fbbf24' },
                      { label: '200자+ (고부하)', count: dashboard.textStats.distribution.extreme, color: '#ef4444' },
                    ].map((d) => {
                      const distTotal = dashboard.textStats.count;
                      const pct = distTotal > 0 ? Math.round((d.count / distTotal) * 100) : 0;
                      return (
                        <div key={d.label} className={styles.distRow}>
                          <div className={styles.distRowTop}>
                            <span className={styles.modelDot} style={{ backgroundColor: d.color }}></span>
                            <span className={styles.distLabel}>{d.label}</span>
                            <span className={styles.distCount}>{d.count}건 <span className={styles.modelPct}>({pct}%)</span></span>
                          </div>
                          <div className={styles.modelBarBg}>
                            <div className={styles.modelBarFill} style={{ width: `${pct}%`, backgroundColor: d.color }}></div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              ) : (
                <div className={styles.emptyModelText}>오늘 추출 데이터가 없습니다</div>
              )}
            </div>
          </div>
        )}

        {/* 탭 바 */}
        <div className={styles.tabBar}>
          <button
            className={
              activeTab === "history" ? styles.tabActive : styles.tab
            }
            onClick={() => setActiveTab("history")}
          >
            📋 번역 조회
          </button>
          <button
            className={
              activeTab === "password" ? styles.tabActive : styles.tab
            }
            onClick={() => setActiveTab("password")}
          >
            🔑 비밀번호 설정
          </button>
        </div>

        {/* 탭 내용: 번역 조회 */}
        {activeTab === "history" && (
          <>
            <table className={styles.historyTable}>
              <thead>
                <tr>
                  <th>시간</th>
                  <th>IP</th>
                  <th>이미지</th>
                  <th>번역 데이터</th>
                  <th>사용 모델</th>
                  <th>성공 여부</th>
                </tr>
              </thead>
              <tbody>
                {isLoadingHistory ? (
                  <tr>
                    <td colSpan={6} className={styles.emptyRow}>
                      <div className={styles.loadingSpinner}></div>
                      <div style={{ marginTop: '0.75rem', color: '#64748b' }}>데이터를 불러오는 중...</div>
                    </td>
                  </tr>
                ) : translations.length > 0 ? (
                  translations.map((t) => (
                    <tr key={t.id}>
                      <td>{formatTime(t.timestamp)}</td>
                      <td><span style={{ fontSize: '0.8rem', color: '#64748b', fontFamily: 'monospace' }}>{t.ipAddress || '-'}</span></td>
                      <td>
                        {t.thumbnail ? (
                          <img
                            src={t.thumbnail}
                            alt="thumb"
                            className={styles.thumbImage}
                            style={{ cursor: 'zoom-in' }}
                            onDoubleClick={() => setSelectedImage(t.thumbnail)}
                          />
                        ) : (
                          <div className={styles.noThumb}>🖼️</div>
                        )}
                      </td>
                      <td>
                        {t.success ? (
                          <button
                            className={styles.downloadLink}
                            onClick={() =>
                              handleDownloadResult(t.id, t.timestamp)
                            }
                          >
                            📥 엑셀 다운로드
                          </button>
                        ) : (
                          <span className={styles.expiredText}>
                            {t.errorMessage || "데이터 없음"}
                          </span>
                        )}
                      </td>
                      <td>
                        <span className={styles.modelTag}>{t.modelUsed}</span>
                      </td>
                      <td>
                        {t.success ? (
                          <span className={styles.badgeSuccess}>성공</span>
                        ) : (
                          <span className={styles.badgeFail}>실패</span>
                        )}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={6} className={styles.emptyRow}>
                      번역 기록이 없습니다.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>

            {/* 페이지네이션 */}
            {totalPages > 1 && (
              <div className={styles.pagination}>
                <button
                  className={styles.pageButton}
                  disabled={historyPage <= 1}
                  onClick={() => loadHistory(historyPage - 1)}
                >
                  ← 이전
                </button>
                <span className={styles.pageInfo}>
                  {historyPage} / {totalPages}
                </span>
                <button
                  className={styles.pageButton}
                  disabled={historyPage >= totalPages}
                  onClick={() => loadHistory(historyPage + 1)}
                >
                  다음 →
                </button>
              </div>
            )}
          </>
        )}

        {/* 탭 내용: 비밀번호 설정 */}
        {activeTab === "password" && (
          <div className={styles.passwordSection}>
            {!pwTabUnlocked ? (
              <div className={styles.passwordCard}>
                <div className={styles.loginIcon}>🔑</div>
                <h2
                  className={styles.loginTitle}
                  style={{ fontSize: "1.2rem", marginBottom: "0.3rem" }}
                >
                  비밀번호 확인
                </h2>
                <p
                  className={styles.loginSubtitle}
                  style={{ marginBottom: "1.5rem" }}
                >
                  설정 변경을 위해 현재 비밀번호를 입력하세요
                </p>
                <div className={styles.pinInputRow}>
                  {pwTabPin.map((digit, i) => (
                    <input
                      key={i}
                      ref={(el) => { pwTabPinRefs.current[i] = el; }}
                      type="password"
                      inputMode="numeric"
                      maxLength={1}
                      value={digit}
                      className={styles.pinDigit}
                      onChange={(e) =>
                        handlePinChange(
                          i,
                          e.target.value,
                          setPwTabPin,
                          pwTabPinRefs
                        )
                      }
                      onKeyDown={(e) =>
                        handlePinKeyDown(e, i, pwTabPin, pwTabPinRefs)
                      }
                      onKeyUp={(e) => {
                        if (e.key === "Enter" && pwTabPin.every((d) => d))
                          handlePwTabUnlock();
                      }}
                    />
                  ))}
                </div>
                <button
                  className={styles.loginButton}
                  onClick={handlePwTabUnlock}
                >
                  확인
                </button>
                {pwTabError && (
                  <div className={styles.loginError}>{pwTabError}</div>
                )}
              </div>
            ) : (
              <div className={styles.passwordCard}>
                <div className={styles.passwordLabel}>현재 비밀번호</div>
                <div className={styles.passwordDisplay}>{currentPw}</div>

                <div className={styles.fieldGroup}>
                  <div className={styles.fieldLabel}>새 비밀번호 (4자리 숫자)</div>
                  <input
                    type="password"
                    inputMode="numeric"
                    maxLength={4}
                    value={newPw}
                    onChange={(e) => {
                      if (/^\d*$/.test(e.target.value)) setNewPw(e.target.value);
                    }}
                    className={styles.passwordInput}
                    placeholder="••••"
                  />
                </div>

                <div className={styles.fieldGroup}>
                  <div className={styles.fieldLabel}>새 비밀번호 확인</div>
                  <input
                    type="password"
                    inputMode="numeric"
                    maxLength={4}
                    value={confirmPw}
                    onChange={(e) => {
                      if (/^\d*$/.test(e.target.value))
                        setConfirmPw(e.target.value);
                    }}
                    className={styles.passwordInput}
                    placeholder="••••"
                  />
                </div>

                <button
                  className={styles.saveButton}
                  onClick={handleChangePassword}
                >
                  비밀번호 변경
                </button>

                {pwChangeMsg && (
                  <div className={styles.successMsg}>{pwChangeMsg}</div>
                )}
                {pwChangeError && (
                  <div className={styles.errorMsg}>{pwChangeError}</div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 🖼️ 이미지 확대 모달 */}
      {selectedImage && (
        <div 
          className={styles.imageModalOverlay} 
          onClick={() => setSelectedImage(null)}
        >
          <div className={styles.imageModalClose}>&times;</div>
          <img src={selectedImage} alt="Expanded preview" className={styles.imageModalImg} />
        </div>
      )}
    </div>
  );
}
