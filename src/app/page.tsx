"use client";

import { useState } from "react";
import { processImageAndTranslate } from "./actions";
import styles from "./page.module.css";

interface TranslationResult {
  number: string | number;
  text: string;
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
      
      const response = await processImageAndTranslate(pureBase64Data, mimeType);
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

  return (
    <div className={styles.container}>
      <div className={styles.content}>
        <h1 className={styles.title}>Copy Analyzer</h1>
        <p className={styles.subtitle}>
          이미지 안의 텍스트가 번역될 때, 전 세계 어느 언어로 번역해야 가장 길어질지 확인해 보세요.
          전문 카피라이터처럼 깔끔하고 직관적으로 번역한 결과를 바탕으로 복잡도를 분석합니다.
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
            <button 
              onClick={handleStartProcess}
              disabled={!imageFile || isProcessing}
              className={styles.ctaButton}
            >
              번역 분석 시작하기
            </button>
            {isProcessing && (
              <div className={styles.processingText}>
                <div className={styles.spinner}></div>
                작업 중입니다...
              </div>
            )}
          </div>

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
                    <th className={styles.centerAlign} style={{ width: '10%' }}>number</th>
                    <th style={{ width: '30%' }}>Text</th>
                    <th className={styles.centerAlign} style={{ width: '15%' }}>MAX CHAR</th>
                    <th style={{ width: '15%' }}>note</th>
                    <th style={{ width: '30%' }}>Translate Text</th>
                  </tr>
                </thead>
                <tbody>
                  {results.length > 0 ? (
                    results.map((row, idx) => (
                      <tr key={idx}>
                        <td className={styles.centerAlign}><span className={styles.cellNumber}>{row.number}</span></td>
                        <td><div className={styles.cellExample}>{row.text}</div></td>
                        <td className={styles.centerAlign}><span className={styles.cellGuide}>{row.guide}</span></td>
                        <td><span className={styles.cellNote}>{row.note}</span></td>
                        <td><div className={styles.cellExample}>{row.translateText}</div></td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={5} style={{ textAlign: 'center', padding: '3rem', color: '#64748b' }}>
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
  );
}
