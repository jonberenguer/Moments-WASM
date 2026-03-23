import { X, Download, Loader, CheckCircle, AlertCircle } from 'lucide-react'
import styles from './ExportModal.module.css'

export default function ExportModal({
  state, progress, logs, outputUrl, outputName,
  quality, aspectRatio, onClose,
}) {
  const isVertical = aspectRatio === '9:16'
  const dims = {
    '480p':  isVertical ? '480×854'  : '854×480',
    '720p':  isVertical ? '720×1280' : '1280×720',
    '1080p': isVertical ? '1080×1920' : '1920×1080',
  }
  const canClose = state === 'done' || state === 'error'

  return (
    <div className={styles.overlay}>
      <div className={styles.modal}>
        <div className={styles.header}>
          <span className={styles.title}>Export Moment</span>
          <button className={styles.closeBtn} onClick={canClose ? onClose : undefined} disabled={!canClose} style={!canClose ? {opacity:0.35, cursor:'not-allowed'} : {}}>
            <X size={14} strokeWidth={2} />
          </button>
        </div>

        <div className={styles.body}>

          {/* ── Loading FFmpeg ── */}
          {state === 'loading-ffmpeg' && (
            <div className={styles.centeredState}>
              <Loader size={24} strokeWidth={1} className={styles.spin} />
              <p className={styles.stateLabel}>Loading FFmpeg engine…</p>
              <p className={styles.hint}>~31 MB WASM · cached after first load</p>
            </div>
          )}

          {/* ── Exporting ── */}
          {state === 'exporting' && (
            <div className={styles.exportingState}>
              <p className={styles.qualityLine}>
                {quality} · {dims[quality] || ''} · 30 fps
              </p>
              <div className={styles.progressWrap}>
                <div className={styles.progressBar}>
                  <div className={styles.progressFill} style={{ width: `${Math.max(2, Math.min(100, progress))}%` }} />
                </div>
                <span className={styles.progressPct}>{Math.min(100, progress)}%</span>
              </div>
              <div className={styles.logBox}>
                {logs.slice(-6).map((l, i) => (
                  <div key={i} className={styles.logLine}>{l}</div>
                ))}
              </div>
            </div>
          )}

          {/* ── Done ── */}
          {state === 'done' && (
            <div className={styles.centeredState}>
              <CheckCircle size={32} strokeWidth={1} className={styles.iconDone} />
              <p className={styles.stateLabel}>Export complete</p>
              {outputUrl && <video src={outputUrl} controls className={styles.preview} />}
            </div>
          )}

          {/* ── Error ── */}
          {state === 'error' && (
            <div className={styles.centeredState}>
              <AlertCircle size={32} strokeWidth={1} className={styles.iconError} />
              <p className={styles.stateLabel}>Export failed</p>
              <p className={styles.hint}>Check the console log (Terminal icon) for details</p>
              {logs.slice(-3).map((l, i) => (
                <div key={i} className={styles.errorLogLine}>{l}</div>
              ))}
            </div>
          )}
        </div>

        <div className={styles.footer}>
          {state === 'done' && outputUrl && (
            <a href={outputUrl} download={outputName || 'moment.mp4'} className={styles.downloadBtn}>
              <Download size={13} strokeWidth={2} />
              Download MP4
            </a>
          )}
          <button className={styles.cancelBtn} onClick={canClose ? onClose : undefined} disabled={!canClose} style={!canClose ? {opacity:0.35, cursor:'not-allowed'} : {}}>
            {state === 'done' ? 'Close' : state === 'error' ? 'Close' : 'Exporting…'}
          </button>
        </div>
      </div>
    </div>
  )
}
