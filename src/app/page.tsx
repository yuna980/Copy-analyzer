"use client";

import { useState, useEffect } from "react";
import { Turnstile } from '@marsidev/react-turnstile';
import * as XLSX from 'xlsx';
import { processImageAndTranslate } from "./actions";
import styles from "./page.module.css";

interface TranslationResult {
  number: string | number;
  text: string;
  textCharCount: number;
  guide: number;
  note: string;
  translateText: string;
}

const compressImage = async (dataUrl: string, maxWidth = 1600): Promise<string> => {
  return new Promise((resolve) => {
    const img = new Image();
    img.src = dataUrl;
    img.onload = () => {
      const canvas = document.createElement("canvas");
      let width = img.width;
      let height = img.height;

      if (width > maxWidth) {
        height = Math.round((height * maxWidth) / width);
        width = maxWidth;
      }

      canvas.width = width;
      canvas.height = height;

      const ctx = canvas.getContext("2d");
      ctx?.drawImage(img, 0, 0, width, height);

      // 이미지를 약 80% 수준의 webp/jpeg로 압축하여 base64 용량을 극적으로 줄임
      resolve(canvas.toDataURL("image/jpeg", 0.8));
    };
    img.onerror = () => resolve(dataUrl); // 실패 시 원본 유출
  });
};

export default function Home() {
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [results, setResults] = useState<TranslationResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);

  // 팝업 로직
  const [showWelcome, setShowWelcome] = useState(false);
  const [hideWelcomeChecked, setHideWelcomeChecked] = useState(false);

  useEffect(() => {
    // 클라이언트 마운트 시 로컬스토리지 확인
    const isHidden = localStorage.getItem("hide_welcome_popup") === "true";
    if (!isHidden) {
      setShowWelcome(true);
    }
  }, []);

  const closeWelcome = () => {
    if (hideWelcomeChecked) {
      localStorage.setItem("hide_welcome_popup", "true");
    }
    setShowWelcome(false);
  };

  const turnstileSiteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const file = e.target.files[0];
      setImageFile(file);
      const reader = new FileReader();
      reader.onload = (event) => {
        setImagePreview(event.target?.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleStartProcess = async () => {
    if (!imageFile) return;

    setIsProcessing(true);
    setResults(null);
    setError(null);

    try {
      if (!imagePreview) throw new Error("이미지를 읽을 수 없습니다.");

      // Vercel Serverless Function 페이로드 제한(4.5MB)과 500 에러를 방지하기 위해 클라이언트에서 먼저 압축 진행
      const compressedImageFull = await compressImage(imagePreview);
      const pureBase64Data = compressedImageFull.split(",")[1];
      const mimeType = compressedImageFull.substring(compressedImageFull.indexOf(":") + 1, compressedImageFull.indexOf(";"));

      // 백오피스 미리보기용 소형 썸네일 생성 (150px, Redis 저장용)
      const thumbnailDataUrl = await compressImage(imagePreview, 150);

      const response = await processImageAndTranslate(pureBase64Data, mimeType, turnstileToken, thumbnailDataUrl);
      if (response.success) {
        setResults(response.data);
      } else {
        setError(response.error || "알 수 없는 오류가 발생했습니다.");
      }
    } catch (err: any) {
      setError(err.message || "오류가 발생했습니다.");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleDownloadExcel = () => {
    if (!results || results.length === 0) return;

    // 테이블과 동일한 컬럼 구조로 엑셀 데이터 생성
    const excelData = results.map((row) => ({
      'Number': row.number,
      'Text': row.text,
      'MAX CHAR': row.textCharCount,
      'Note': row.note,
      'Translate Text': row.translateText,
      'TRANSLATE MAX CHAR': row.guide,
    }));

    const worksheet = XLSX.utils.json_to_sheet(excelData);

    // 컬럼 너비 자동 조절
    worksheet['!cols'] = [
      { wch: 10 },  // Number
      { wch: 40 },  // Text
      { wch: 12 },  // MAX CHAR
      { wch: 15 },  // Note
      { wch: 50 },  // Translate Text
      { wch: 20 },  // TRANSLATE MAX CHAR
    ];

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Translation Results');

    // 파일명에 날짜 포함 (YYYY-MM-DD 형식)
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    XLSX.writeFile(workbook, `copy-analysis_${dateStr}.xlsx`);
  };

  return (
    <div className={styles.container}>
      <div className={styles.content}>
        <h1 className={styles.title}>번역을 도와드립니다</h1>
        <p className={styles.subtitle}>
          이미지 안의 텍스트가 번역될 때, 전 세계 어느 언어로 번역해야 가장 길어질지 확인해 보세요
        </p>

        <div className={styles.glassCard}>
          {/* 이미지 업로드 영역 */}
          <div className={styles.uploadWrapper}>
            <div className={styles.uploadArea}>
              <input
                type="file"
                accept="image/*"
                onChange={handleImageChange}
                className={styles.uploadInput}
                title="Click or drag an image here"
              />
              {imagePreview ? (
                <img src={imagePreview} alt="Preview" className={styles.previewImage} />
              ) : (
                <div className={styles.uploadPlaceholder}>
                  <div className={styles.icon}>📷</div>
                  <div className={styles.uploadText}>이미지 분석 시작하기</div>
                  <div className={styles.uploadSubtext}>클릭하거나 이미지를 드래그 앤 드롭 하세요</div>
                </div>
              )}
            </div>
            {imagePreview && (
              <p className={styles.outsideDescription}>
                * 영역을 클릭하거나 이미지를 드래그하여 교체할 수 있습니다.
              </p>
            )}
          </div>

          {/* CTA 버튼 및 진행 상태 */}
          <div className={styles.actionRow}>
            {/* 턴스타일 (봇 방어) 영역 */}
            {turnstileSiteKey && (
              <div style={{ marginTop: '1rem', display: 'flex', justifyContent: 'center' }}>
                <Turnstile 
                  siteKey={turnstileSiteKey} 
                  onSuccess={(token) => setTurnstileToken(token)} 
                />
              </div>
            )}

            <button
              onClick={handleStartProcess}
              className={styles.ctaButton}
              disabled={!imageFile || isProcessing || (turnstileSiteKey && !turnstileToken) ? true : false}
            >
              {isProcessing ? '번역 중입니다...' : '번역 시작'}
            </button>
            {results && results.length > 0 && (
              <button
                onClick={handleDownloadExcel}
                className={styles.downloadButton}
              >
                📥 엑셀로 내려받기
              </button>
            )}
            {isProcessing && (
              <div className={styles.processingText}>
                <div className={styles.spinner}></div>
                작업 중입니다...
              </div>
            )}
          </div>

          {/* 컬럼 안내 - 결과 있을 때만 버튼 아래에 노출 */}
          {results && (
            <div style={{ marginTop: '1rem', marginBottom: '1.5rem', padding: '1rem', backgroundColor: 'rgba(255, 255, 255, 0.03)', borderRadius: '8px', fontSize: '0.85rem', color: '#94a3b8', lineHeight: '1.5', border: '1px solid rgba(255, 255, 255, 0.05)' }}>
              <strong style={{ color: '#e2e8f0' }}>💡 컬럼 안내</strong><br />
              <strong>MAX CHAR</strong>: 원문(Text)의 글자 수입니다. 대문자 A 기준으로 카운트합니다.<br />
              <strong>TRANSLATE MAX CHAR</strong>: 14개 언어별 2가지 번역 시뮬레이션(간결한 UI 텍스트, 자연스러운 UI 텍스트) 중 <strong>가장 긴 글자 수</strong>를 산출한 값입니다. 디자인 레이아웃 검토 시 이 값을 기준으로 여유 공간을 확보하세요.
            </div>
          )}

          {/* 에러 메시지 */}
          {error && (
            <div className={styles.errorBox}>
              ⚠ {error}
            </div>
          )}

          {/* 완료 후 테이블 형태 데이터 노출 */}
          {results && (
            <div className={styles.tableContainer}>
              <table className={styles.dataTable}>
                <thead>
                <tr>
                    <th className={styles.centerAlign} style={{ width: '6%' }}>number</th>
                    <th style={{ width: '25%' }}>Text</th>
                    <th className={styles.centerAlign} style={{ width: '8%' }}>MAX CHAR</th>
                    <th style={{ width: '12%' }}>note</th>
                    <th style={{ width: '33%' }}>Translate Text</th>
                    <th className={styles.centerAlign} style={{ width: '16%' }}>TRANSLATE MAX CHAR</th>
                  </tr>
                </thead>
                <tbody>
                  {results.length > 0 ? (
                    results.map((row, idx) => (
                      <tr key={idx}>
                        <td className={styles.centerAlign}><span className={styles.cellNumber}>{row.number}</span></td>
                        <td><div className={styles.cellExample}>{row.text}</div></td>
                        <td className={styles.centerAlign}><span className={styles.cellGuide}>{row.textCharCount}</span></td>
                        <td><span className={styles.cellNote}>{row.note}</span></td>
                        <td><div className={styles.cellExample}>{row.translateText}</div></td>
                        <td className={styles.centerAlign}><span className={styles.cellGuide}>{row.guide}</span></td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={6} style={{ textAlign: 'center', padding: '3rem', color: '#64748b' }}>
                        추출된 텍스트가 없습니다.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
        </div>
      </div>

      {/* 웰컴 팝업 모달 */}
      {showWelcome && (
        <div className={styles.modalOverlay}>
          <div className={styles.modalContent}>
            <div className={styles.modalHeader}>
              <h2 className={styles.modalTitle}>👋 Copy Analyzer에 오신 것을 환영합니다!</h2>
            </div>
            
            <div className={styles.modalBody}>
              <p className={styles.modalText}>
                넘버링 한 이미지를 올리면 <strong>각 텍스트 단위로 글자수</strong>를 세어주고,<br />
                해외 14개 언어로 번역했을 때 <strong>가장 긴 글자 수</strong>를 산출해 알려주는 서비스입니다.
              </p>
              
              <div className={styles.modalNotice}>
                다만, 번역이라는 게 어투나 상황에 따라 달라질 수 있기 때문에 결과가 <strong>무조건 완벽한 것은 아닙니다. 😅</strong><br />
                디자인 작업을 위한 <span style={{ color: '#60a5fa' }}>여백 확보 참고용</span>으로 사용해주시면 감사하겠습니다!
              </div>

              <div className={styles.modalWarning}>
                🚨 <strong>주의:</strong> 서비스 안정을 위해 여러분의 번역 시도 결과와 IP 정보는 모니터링됩니다.
              </div>
            </div>

            <div className={styles.modalFooter}>
              <label className={styles.checkboxLabel}>
                <input 
                  type="checkbox" 
                  checked={hideWelcomeChecked} 
                  onChange={(e) => setHideWelcomeChecked(e.target.checked)} 
                />
                <span className={styles.checkboxText}>다시 보지 않기</span>
              </label>
              
              <button className={styles.modalBtn} onClick={closeWelcome}>
                확인했습니다
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

