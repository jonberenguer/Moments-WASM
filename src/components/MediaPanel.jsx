import { useCallback, useRef, useState, useEffect } from 'react'
import { Plus, Music, Trash2, Upload, AlertTriangle, Play, Pause, GripVertical, PlusCircle } from 'lucide-react'
import styles from './MediaPanel.module.css'

export default function MediaPanel({
  mediaLibrary, activeMediaId, onSelectMedia, onAddToTimeline, onRemoveMedia, onAddFiles, onUpdateMediaDuration,
  musicFile, onMusicFile, onMusicDuration,
}) {
  const fileInputRef   = useRef()
  const musicInputRef  = useRef()
  const previewVideoRef= useRef()
  const audioRef       = useRef()
  const panelRef       = useRef()
  const resizeRef      = useRef({ active: false })

  const [previewPlaying,     setPreviewPlaying]     = useState(false)
  const [previewCurrentTime, setPreviewCurrentTime] = useState(0)
  const [previewHeight,      setPreviewHeight]      = useState(160)
  const [panelWidth,         setPanelWidth]         = useState(220)
  const [isDraggingPanel,    setIsDraggingPanel]    = useState(false)
  const [isDraggingPrev,     setIsDraggingPrev]     = useState(false)
  const [isDraggingVideo,    setIsDraggingVideo]    = useState(false)
  const videoProgressRef = useRef()

  // Music player state
  const [musicPlaying,    setMusicPlaying]    = useState(false)
  const [musicCurrentTime,setMusicCurrentTime]= useState(0)
  const [musicDuration,   setMusicDuration]   = useState(0)
  const [isDraggingMusic, setIsDraggingMusic] = useState(false)
  const musicProgressRef = useRef()

  const activeClip = mediaLibrary.find(m => m.id === activeMediaId) || null

  // Reset preview play state when selected clip changes
  useEffect(() => {
    setPreviewPlaying(false)
    if (previewVideoRef.current) previewVideoRef.current.pause()
  }, [activeMediaId])

  // Stable object URL for the audio element — revoked when file changes
  const [musicUrl, setMusicUrl] = useState(null)
  useEffect(() => {
    if (!musicFile) { setMusicUrl(null); return }
    const url = URL.createObjectURL(musicFile)
    setMusicUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [musicFile])

  // Reset player state when music file changes
  useEffect(() => {
    setMusicPlaying(false)
    setMusicCurrentTime(0)
    setMusicDuration(0)
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.currentTime = 0
    }
  }, [musicUrl])

  const togglePreviewPlay = useCallback(() => {
    const vid = previewVideoRef.current; if (!vid) return
    if (vid.paused) { vid.play(); setPreviewPlaying(true) }
    else { vid.pause(); setPreviewPlaying(false) }
  }, [])

  // Reset preview state when selected clip changes
  useEffect(() => {
    setPreviewCurrentTime(0)
    setPreviewPlaying(false)
    if (previewVideoRef.current) {
      previewVideoRef.current.pause()
      previewVideoRef.current.currentTime = 0
    }
  }, [activeMediaId])

  const toggleMusicPlay = useCallback(() => {
    const aud = audioRef.current; if (!aud) return
    if (aud.paused) { aud.play(); setMusicPlaying(true) }
    else { aud.pause(); setMusicPlaying(false) }
  }, [])

  // Seek by clicking / dragging the progress bar
  const seekFromEvent = useCallback((e) => {
    const aud  = audioRef.current
    const bar  = musicProgressRef.current
    if (!aud || !bar || !musicDuration) return
    const rect = bar.getBoundingClientRect()
    const pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    const t    = pct * musicDuration
    aud.currentTime = t
    setMusicCurrentTime(t)
  }, [musicDuration])

  const onProgressMouseDown = useCallback((e) => {
    e.preventDefault()
    seekFromEvent(e)
    setIsDraggingMusic(true)
  }, [seekFromEvent])

  useEffect(() => {
    if (!isDraggingMusic) return
    const onMove = (e) => seekFromEvent(e)
    const onUp   = ()  => setIsDraggingMusic(false)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup',   onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [isDraggingMusic, seekFromEvent])

  // Video preview seek
  const seekVideoFromEvent = useCallback((e) => {
    const vid  = previewVideoRef.current
    const bar  = videoProgressRef.current
    const dur  = vid?.duration
    if (!vid || !bar || !dur || !isFinite(dur)) return
    const rect = bar.getBoundingClientRect()
    const pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    vid.currentTime = pct * dur
    setPreviewCurrentTime(pct * dur)
  }, [])

  const onVideoProgressMouseDown = useCallback((e) => {
    e.preventDefault()
    seekVideoFromEvent(e)
    setIsDraggingVideo(true)
  }, [seekVideoFromEvent])

  useEffect(() => {
    if (!isDraggingVideo) return
    const onMove = (e) => seekVideoFromEvent(e)
    const onUp   = ()  => setIsDraggingVideo(false)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup',   onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [isDraggingVideo, seekVideoFromEvent])

  const handleDrop = useCallback((e) => {
    e.preventDefault(); onAddFiles(e.dataTransfer.files)
  }, [onAddFiles])

  const handleVideoDuration = useCallback((item, e) => {
    const dur = e.target.duration
    if (dur && isFinite(dur) && !item.duration) onUpdateMediaDuration(item.id, parseFloat(dur.toFixed(1)))
  }, [onUpdateMediaDuration])

  const fmtTime = (s) => {
    const m = Math.floor(s / 60)
    const sec = Math.floor(s % 60).toString().padStart(2, '0')
    return `${m}:${sec}`
  }

  // ── Panel width resize ────────────────────────────────────────────────────
  const onPanelResizeStart = useCallback((e) => {
    e.preventDefault()
    resizeRef.current = { active: true, startX: e.clientX, startW: panelWidth }
    setIsDraggingPanel(true)
  }, [panelWidth])

  useEffect(() => {
    if (!isDraggingPanel) return
    const onMove = (e) => {
      const delta = e.clientX - resizeRef.current.startX
      setPanelWidth(Math.max(180, Math.min(420, resizeRef.current.startW + delta)))
    }
    const onUp = () => { resizeRef.current.active = false; setIsDraggingPanel(false) }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup',   onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [isDraggingPanel])

  // ── Preview height resize ─────────────────────────────────────────────────
  const onPrevResizeStart = useCallback((e) => {
    e.preventDefault()
    resizeRef.current = { active: true, startY: e.clientY, startH: previewHeight }
    setIsDraggingPrev(true)
  }, [previewHeight])

  useEffect(() => {
    if (!isDraggingPrev) return
    const onMove = (e) => {
      const delta = e.clientY - resizeRef.current.startY
      setPreviewHeight(Math.max(80, Math.min(400, resizeRef.current.startH - delta)))
    }
    const onUp = () => { resizeRef.current.active = false; setIsDraggingPrev(false) }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup',   onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [isDraggingPrev])

  return (
    <aside ref={panelRef} className={styles.panel} style={{ width: panelWidth }}>
      {/* Panel resize handle */}
      <div className={styles.panelResizeHandle} onMouseDown={onPanelResizeStart} title="Drag to resize panel">
        <GripVertical size={12} strokeWidth={1.5} />
      </div>

      <div className={styles.header}>
        <span className={styles.sectionLabel}>Media Library</span>
        <button className={styles.addBtn} onClick={() => fileInputRef.current?.click()} title="Add media">
          <Plus size={13} strokeWidth={2} />
        </button>
      </div>

      <div className={styles.dropzone} onDrop={handleDrop} onDragOver={e => e.preventDefault()} onClick={() => fileInputRef.current?.click()}>
        <Upload size={18} strokeWidth={1.5} className={styles.uploadIcon} />
        <span>Drop photos & videos</span>
        <span className={styles.dropHint}>or click to browse</span>
      </div>

      <input ref={fileInputRef} type="file" multiple accept="image/*,video/*" style={{ display:'none' }}
        onChange={e => { onAddFiles(e.target.files); e.target.value='' }} />

      <div className={styles.grid}>
        {mediaLibrary.map((item) => (
          <div
            key={item.id}
            className={`${styles.thumb} ${activeMediaId===item.id ? styles.active : ''}`}
            onClick={() => onSelectMedia(item.id)}
            draggable
            onDragStart={e => {
              e.dataTransfer.setData('application/x-media-id', item.id)
              e.dataTransfer.effectAllowed = 'copy'
            }}
          >
            {item.type==='image'
              ? <img src={item.url} alt={item.name} className={styles.thumbImg} />
              : <video src={item.url} className={styles.thumbImg} muted preload="metadata" onLoadedMetadata={e => handleVideoDuration(item,e)} />
            }
            <div className={styles.thumbOverlay}>
              <span className={styles.thumbType}>{item.type==='video' ? '▶' : '◉'}</span>
              {item.duration && <span className={styles.thumbDur}>{item.duration.toFixed(1)}s</span>}
            </div>
            <button className={styles.addToTimelineBtn} title="Add to timeline"
              onClick={e => { e.stopPropagation(); onAddToTimeline(item) }}>
              <PlusCircle size={11} strokeWidth={2} />
            </button>
            <button className={styles.removeBtn} title="Remove from library"
              onClick={e => { e.stopPropagation(); onRemoveMedia(item.id) }}>
              <Trash2 size={10} strokeWidth={2} />
            </button>
          </div>
        ))}
      </div>

      {/* Music */}
      <div className={styles.musicSection}>
        <div className={styles.musicHeader}>
          <Music size={12} strokeWidth={1.5} />
          <span>Background Music</span>
        </div>
        {musicFile ? (
          <div className={styles.musicPlayer}>
            {/* Hidden audio element */}
            <audio
              ref={audioRef}
              src={musicUrl || ''}
              onTimeUpdate={e => setMusicCurrentTime(e.target.currentTime)}
              onLoadedMetadata={e => {
                const d = e.target.duration
                if (d && isFinite(d)) {
                  setMusicDuration(d)
                  onMusicDuration?.(d)
                }
              }}
              onEnded={() => setMusicPlaying(false)}
            />

            {/* File name + remove */}
            <div className={styles.musicTrack}>
              <span className={styles.musicName}>{musicFile.name}</span>
              <button onClick={() => onMusicFile(null)} className={styles.musicRemove} title="Remove music">
                <Trash2 size={11} strokeWidth={1.5} />
              </button>
            </div>

            {/* Play/stop + time */}
            <div className={styles.musicControls}>
              <button className={styles.musicPlayBtn} onClick={toggleMusicPlay} title={musicPlaying ? 'Pause' : 'Play'}>
                {musicPlaying
                  ? <Pause size={12} strokeWidth={2} />
                  : <Play  size={12} strokeWidth={2} style={{ marginLeft: 1 }} />
                }
              </button>
              <span className={styles.musicTime}>
                {fmtTime(musicCurrentTime)}
                {musicDuration > 0 && <span className={styles.musicTimeSep}> / {fmtTime(musicDuration)}</span>}
              </span>
            </div>

            {/* Progress / seek bar */}
            <div
              ref={musicProgressRef}
              className={styles.musicProgressBar}
              onMouseDown={onProgressMouseDown}
              title="Click or drag to seek"
            >
              <div
                className={styles.musicProgressFill}
                style={{ width: musicDuration > 0 ? `${(musicCurrentTime / musicDuration) * 100}%` : '0%' }}
              />
              <div
                className={styles.musicProgressThumb}
                style={{ left: musicDuration > 0 ? `${(musicCurrentTime / musicDuration) * 100}%` : '0%' }}
              />
            </div>
          </div>
        ) : (
          <button className={styles.musicAdd} onClick={() => musicInputRef.current?.click()}>
            <Plus size={12} strokeWidth={2} /> Add audio file
          </button>
        )}
        <input ref={musicInputRef} type="file" accept="audio/*" style={{ display:'none' }}
          onChange={e => { if(e.target.files[0]) onMusicFile(e.target.files[0]); e.target.value='' }} />
      </div>

      {/* Preview */}
      {activeClip && (
        <div className={styles.previewSection}>
          {/* Drag handle to resize preview */}
          <div className={styles.previewResizeHandle} onMouseDown={onPrevResizeStart} title="Drag to resize preview">
            <div className={styles.previewHeader}>
              <span className={styles.previewLabel}>Preview</span>
              <span className={styles.previewName}>{activeClip.name}</span>
              <GripVertical size={11} strokeWidth={1.5} className={styles.previewGrip} />
            </div>
          </div>
          <div className={styles.previewMedia} style={{ height: previewHeight }}>
            {activeClip.type === 'image' ? (
              <img src={activeClip.url} alt={activeClip.name} className={styles.previewImg} />
            ) : (
              <div className={styles.previewVideoWrap}>
                <video ref={previewVideoRef} src={activeClip.url} className={styles.previewImg}
                  loop playsInline onEnded={() => setPreviewPlaying(false)}
                  onTimeUpdate={e => setPreviewCurrentTime(e.target.currentTime)}
                  onLoadedMetadata={e => {
                    const dur = e.target.duration
                    if (dur && isFinite(dur)) onUpdateMediaDuration(activeClip.id, parseFloat(dur.toFixed(2)))
                  }} />
                <button className={styles.previewPlayBtn} onClick={togglePreviewPlay}>
                  {previewPlaying
                    ? <Pause size={14} strokeWidth={2} />
                    : <Play  size={14} strokeWidth={2} style={{ marginLeft:1 }} />
                  }
                </button>
              </div>
            )}
            {activeClip.type === 'image' && activeClip.duration && (
              <div className={styles.previewMeta}>
                <span>◉ image</span>
                <span>{activeClip.duration.toFixed(1)}s</span>
              </div>
            )}
          </div>

          {/* Video progress bar — sits below the video, not overlaid */}
          {activeClip.type === 'video' && (
            <div className={styles.videoProgressWrap}>
              <span className={styles.videoProgressTime}>{fmtTime(previewCurrentTime)}</span>
              <div
                ref={videoProgressRef}
                className={styles.videoProgressBar}
                onMouseDown={onVideoProgressMouseDown}
              >
                <div
                  className={styles.videoProgressFill}
                  style={{ width: activeClip.duration ? `${(previewCurrentTime / activeClip.duration) * 100}%` : '0%' }}
                />
                <div
                  className={styles.videoProgressThumb}
                  style={{ left: activeClip.duration ? `${(previewCurrentTime / activeClip.duration) * 100}%` : '0%' }}
                />
              </div>
              <span className={styles.videoProgressTime}>{fmtTime(activeClip.duration || 0)}</span>
            </div>
          )}
          <button className={styles.addToTimelineFullBtn} onClick={() => onAddToTimeline(activeClip)}>
            <PlusCircle size={12} strokeWidth={2} /> Add to Timeline
          </button>
        </div>
      )}
    </aside>
  )
}
