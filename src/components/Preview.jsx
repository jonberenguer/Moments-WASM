import { useEffect, useRef, useState, useCallback } from 'react'
import { Play, Pause, SkipBack, SkipForward, ZoomIn, ZoomOut, Maximize2, Save, LayoutTemplate, Volume2, VolumeX } from 'lucide-react'
import { PRESET_FONTS, loadPreviewFont } from '../hooks/useFFmpeg'
import styles from './Preview.module.css'

const TRANS_OUT = { crossfade:'fadeOut', slide_left:'slideLeftOut', slide_up:'slideUpOut', zoom_in:'zoomOut', dip_black:'dipOut' }
const TRANS_LABELS = { crossfade:'Crossfade', slide_left:'Slide ←', slide_up:'Slide ↑', zoom_in:'Zoom', dip_black:'Dip ●' }
const MEDIA_MIN_ZOOM = 0.25, MEDIA_MAX_ZOOM = 8, VIEWPORT_MIN = 30, VIEWPORT_MAX = 100

export default function Preview({
  clips, activeClipId, onSelectClip,
  isPlaying, onPlayToggle,
  getClipTransition, aspectRatio,
  onSaveView,
  textSegments = [],
  onUpdateTextSegment,
}) {
  const [displayIdx,      setDisplayIdx]     = useState(0)
  const [transKey,        setTransKey]       = useState('visible')
  const [pan,             setPan]            = useState({ x:0, y:0 })
  const [zoom,            setZoom]           = useState(1)
  const [isDraggingMedia, setIsDraggingMedia]= useState(false)
  const [viewportSize,    setViewportSize]   = useState(100)
  const [savedIndicator,  setSavedIndicator] = useState(false)
  const [playTime,        setPlayTime]       = useState(0)
  const [draggingSegId,   setDraggingSegId]  = useState(null)
  const [isMuted,         setIsMuted]        = useState(false)

  const intervalRef  = useRef(null)
  const playTimerRef = useRef(null)
  const mediaDragRef = useRef(null)
  const segDragRef   = useRef(null)
  const screenRef    = useRef(null)
  const videoRef     = useRef(null)

  const activeIdx  = clips.findIndex(c => c.id===activeClipId)
  const clip       = clips[displayIdx]
  const isVertical = aspectRatio === '9:16'

  useEffect(() => { if(activeIdx>=0) setDisplayIdx(activeIdx) }, [activeIdx])
  useEffect(() => {
    const c=clips[displayIdx]
    if(c){setZoom(c.viewZoom??1);setPan({x:c.viewPanX??0,y:c.viewPanY??0})}
    else {setZoom(1);setPan({x:0,y:0})}
  }, [displayIdx])

  useEffect(() => {
    clearTimeout(intervalRef.current); clearInterval(playTimerRef.current)
    if(!isPlaying||clips.length===0) return
    const clipStart=clips.slice(0,displayIdx).reduce((s,c)=>s+(c.duration||4),0)
    setPlayTime(clipStart)
    let elapsed=0
    playTimerRef.current=setInterval(()=>{elapsed+=0.1;setPlayTime(clipStart+elapsed)},100)
    const dur=(clips[displayIdx]?.duration||4)*1000
    intervalRef.current=setTimeout(()=>{
      clearInterval(playTimerRef.current)
      setTransKey(TRANS_OUT[getClipTransition(clips[displayIdx])]||'fadeOut')
      setTimeout(()=>{
        const next=(displayIdx+1)%clips.length
        setDisplayIdx(next); if(clips[next])onSelectClip(clips[next].id); setTransKey('visible')
      },350)
    },dur)
    return ()=>{clearTimeout(intervalRef.current);clearInterval(playTimerRef.current)}
  },[isPlaying,displayIdx,clips])

  const onMediaMouseDown = useCallback((e)=>{
    if(e.button!==0)return; if(e.target.closest('[data-textseg]'))return
    e.preventDefault(); setIsDraggingMedia(true)
    mediaDragRef.current={mx:e.clientX,my:e.clientY,px:pan.x,py:pan.y}
  },[pan])
  const onMediaMouseMove = useCallback((e)=>{
    if(!mediaDragRef.current)return
    setPan({x:mediaDragRef.current.px+(e.clientX-mediaDragRef.current.mx),y:mediaDragRef.current.py+(e.clientY-mediaDragRef.current.my)})
  },[])
  const onMediaMouseUp = useCallback(()=>{mediaDragRef.current=null;setIsDraggingMedia(false)},[])
  useEffect(()=>{
    if(!isDraggingMedia)return
    window.addEventListener('mousemove',onMediaMouseMove); window.addEventListener('mouseup',onMediaMouseUp)
    return ()=>{window.removeEventListener('mousemove',onMediaMouseMove);window.removeEventListener('mouseup',onMediaMouseUp)}
  },[isDraggingMedia,onMediaMouseMove,onMediaMouseUp])

  const onSegMouseDown = useCallback((e,seg)=>{
    e.stopPropagation(); e.preventDefault()
    const rect=screenRef.current?.getBoundingClientRect(); if(!rect)return
    setDraggingSegId(seg.id)
    segDragRef.current={segId:seg.id,rect,startX:e.clientX,startY:e.clientY,startPosX:seg.posX??50,startPosY:seg.posY??85}
  },[])
  const onSegMouseMove = useCallback((e)=>{
    if(!segDragRef.current)return
    const {rect,startX,startY,startPosX,startPosY,segId}=segDragRef.current
    onUpdateTextSegment?.(segId,{position:'custom',posX:+Math.max(5,Math.min(95,startPosX+((e.clientX-startX)/rect.width)*100)).toFixed(1),posY:+Math.max(5,Math.min(95,startPosY+((e.clientY-startY)/rect.height)*100)).toFixed(1)})
  },[onUpdateTextSegment])
  const onSegMouseUp = useCallback(()=>{segDragRef.current=null;setDraggingSegId(null)},[])
  useEffect(()=>{
    if(!draggingSegId)return
    window.addEventListener('mousemove',onSegMouseMove); window.addEventListener('mouseup',onSegMouseUp)
    return ()=>{window.removeEventListener('mousemove',onSegMouseMove);window.removeEventListener('mouseup',onSegMouseUp)}
  },[draggingSegId,onSegMouseMove,onSegMouseUp])

  const onWheel = useCallback((e)=>{
    e.preventDefault()
    setZoom(z=>parseFloat(Math.min(MEDIA_MAX_ZOOM,Math.max(MEDIA_MIN_ZOOM,z+(e.deltaY<0?0.1:-0.1))).toFixed(3)))
  },[])
  useEffect(()=>{
    const el=screenRef.current; if(!el)return
    el.addEventListener('wheel',onWheel,{passive:false})
    return ()=>el.removeEventListener('wheel',onWheel)
  },[onWheel])

  const handleSaveView = useCallback(()=>{
    if(clip&&onSaveView)onSaveView(clip.id,zoom,pan.x,pan.y)
    setSavedIndicator(true); setTimeout(()=>setSavedIndicator(false),1500)
  },[clip,zoom,pan,onSaveView])
  const resetView       = useCallback(()=>{setZoom(1);setPan({x:0,y:0})},[])
  const changeMediaZoom = useCallback((d)=>setZoom(z=>parseFloat(Math.min(MEDIA_MAX_ZOOM,Math.max(MEDIA_MIN_ZOOM,z+d)).toFixed(3))),[])

  const isTransformed = zoom!==1||pan.x!==0||pan.y!==0
  const hasSavedView  = clip&&(clip.viewZoom!==1||clip.viewPanX!==0||clip.viewPanY!==0)
  const totalDur      = clips.reduce((s,c)=>s+(c.duration||0),0)
  const effTrans      = getClipTransition(clip)
  const fmt           = (s)=>`${Math.floor(s/60)}:${Math.floor(s%60).toString().padStart(2,'0')}`
  const filterStyle   = clip ? `brightness(${1+(clip.brightness||0)/100}) contrast(${1+(clip.contrast||0)/100}) saturate(${1+(clip.saturation||0)/100})` : undefined

  // Get CSS animation class for image effects
  const getEffectClass = (clip) => {
    if (!clip || clip.type !== 'image') return ''
    switch(clip.imageEffect) {
      case 'ken_burns':   return styles.effectKenBurns
      case 'pan_zoom':    return styles.effectPanZoom
      case 'parallax':    return styles.effectParallax
      case 'fade_in':     return styles.effectFadeIn
      default: return ''
    }
  }

  // Sync video element: mute, trimStart seek on clip change
  useEffect(() => {
    const v = videoRef.current; if (!v) return
    v.muted = isMuted
  }, [isMuted])

  useEffect(() => {
    const v = videoRef.current
    if (!v || !clip || clip.type !== 'video') return
    const trimStart = clip.trimStart || 0
    v.currentTime = trimStart
    if (isPlaying) {
      v.play().catch(() => {})
    } else {
      v.pause()
    }
  }, [clip?.id]) // only re-run when clip changes — play/pause handled below

  // Play/pause control when isPlaying toggles
  useEffect(() => {
    const v = videoRef.current
    if (!v || !clip || clip.type !== 'video') return
    if (isPlaying) {
      v.play().catch(() => {})
    } else {
      v.pause()
    }
  }, [isPlaying])

  const allFontKeys = [...new Set(textSegments.map(s=>s.fontFile||'Poppins-Regular'))]
  allFontKeys.forEach(k=>{if(k!=='custom')loadPreviewFont(k)})

  // Load custom font into the browser whenever customFontData changes
  useEffect(() => {
    const customSeg = textSegments.find(s => s.fontFile === 'custom' && s.customFontData)
    if (!customSeg) return
    const { customFontData, customFontName } = customSeg
    const fontFace = new FontFace('MomCustomFont', customFontData.buffer ?? customFontData)
    fontFace.load().then(loaded => {
      document.fonts.add(loaded)
    }).catch(() => {})
  }, [textSegments.find(s => s.fontFile === 'custom')?.customFontData])
  const getFontFamily = (seg)=>{
    const k=seg.fontFile||'Poppins-Regular'; if(k==='custom')return `'MomCustomFont', sans-serif`
    const p=PRESET_FONTS.find(f=>f.key===k); return p?.cssFamily?`'${p.cssFamily}', sans-serif`:'sans-serif'
  }
  // Compute timeline start time of the currently displayed clip
  const clipTimeStart = clips.slice(0, displayIdx).reduce((s, c) => s + (c.duration || 4), 0)
  const clipTimeEnd   = clipTimeStart + (clips[displayIdx]?.duration || 4)

  // When not playing: only show text segments that overlap the current clip's time window
  // When playing: filter by exact playTime as before
  const visibleSegs = isPlaying
    ? textSegments.filter(s => playTime >= s.startTime && playTime < s.startTime + s.duration)
    : textSegments.filter(s => s.startTime < clipTimeEnd && (s.startTime + s.duration) > clipTimeStart)
  const screenStyle = isVertical ? {height:`${viewportSize}%`,aspectRatio:'9/16'} : {width:`${viewportSize}%`,aspectRatio:'16/9'}

  return (
    <div className={styles.wrapper}>
      <div className={styles.viewportWrap}>
        <div ref={screenRef}
          className={[styles.screen,isDraggingMedia&&!draggingSegId?styles.grabbing:styles.grab,hasSavedView?styles.hasSavedView:''].join(' ')}
          style={screenStyle} onMouseDown={onMediaMouseDown}>

          <div className={`${styles.mediaLayer} ${styles[transKey]}`} style={{transform:`translate(${pan.x}px,${pan.y}px) scale(${zoom})`}}>
            {clip&&!clip._needsMedia?(
              <>
                {clip.type==='image'
                  ?<img src={clip.url} alt={clip.name} className={[styles.mediaEl, getEffectClass(clip)].filter(Boolean).join(' ')} draggable={false} style={{filter:filterStyle}}/>
                  :<video ref={videoRef} src={clip.url} className={styles.mediaEl} muted={isMuted} loop style={{filter:filterStyle}}/>}
                {isTransformed&&<div className={styles.vignette}/>}
              </>
            ):clip?._needsMedia?(
              <div className={styles.needsMedia}><span className={styles.nmIcon}>⚠</span><span className={styles.nmName}>{clip.name}</span><span className={styles.nmHint}>Re-add file</span></div>
            ):(
              <div className={styles.empty}><span className={styles.emptyIcon}>◈</span><span className={styles.emptyText}>Drop media to begin</span></div>
            )}
          </div>

          {visibleSegs.map(seg=>{
            const isCustom=seg.position==='custom'
            return (
              <div key={seg.id} data-textseg
                className={[isCustom?styles.textOverlayCustom:styles.textOverlay,!isCustom?styles[`pos_${seg.position||'bottom'}`]:'',isPlaying?styles[`anim_${seg.animation||'fade'}`]:''].join(' ')}
                style={{fontSize:`${Math.round((seg.fontSize||28)*0.55)}px`,color:seg.color||'#fff',fontFamily:getFontFamily(seg),cursor:draggingSegId===seg.id?'grabbing':'grab',...(isCustom?{position:'absolute',left:`${seg.posX??50}%`,top:`${seg.posY??85}%`,transform:'translate(-50%,-50%)',textAlign:'center',width:'max-content',maxWidth:'90%'}:{})}}
                onMouseDown={e=>onSegMouseDown(e,seg)} title="Drag to reposition">
                {seg.text}
              </div>
            )
          })}

          <div className={styles.hud}>
            <div className={styles.counter}>{clips.length>0?`${displayIdx+1} / ${clips.length}`:''}</div>
            <div className={styles.transBadge}>{TRANS_LABELS[effTrans]||effTrans}</div>
          </div>

          {hasSavedView&&!isTransformed&&<div className={styles.savedDot}/>}
          {clip&&(
            <div className={styles.viewActions}>
              {isTransformed&&(
                <>
                  <button className={`${styles.viewBtn} ${savedIndicator?styles.viewBtnSaved:''}`} onMouseDown={e=>e.stopPropagation()} onClick={handleSaveView}>
                    <Save size={10} strokeWidth={2}/> {savedIndicator?'Saved!':'Save view'}
                  </button>
                  <button className={styles.viewBtn} onMouseDown={e=>e.stopPropagation()} onClick={resetView}>
                    <Maximize2 size={10} strokeWidth={2}/> Reset
                  </button>
                </>
              )}
              {hasSavedView&&!isTransformed&&(
                <button className={styles.viewBtnSaved} onMouseDown={e=>e.stopPropagation()} onClick={()=>onSaveView?.(clip.id,1,0,0)}>
                  <LayoutTemplate size={10} strokeWidth={2}/> Clear view
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      <div className={styles.controlsBar}>
        <div className={styles.zoomGroup}>
          <span className={styles.controlLabel}>Zoom</span>
          <button className={styles.zoomBtn} onClick={()=>changeMediaZoom(-0.25)} disabled={zoom<=MEDIA_MIN_ZOOM}><ZoomOut size={12} strokeWidth={1.5}/></button>
          <span className={styles.zoomLabel}>{Math.round(zoom*100)}%</span>
          <button className={styles.zoomBtn} onClick={()=>changeMediaZoom(0.25)} disabled={zoom>=MEDIA_MAX_ZOOM}><ZoomIn size={12} strokeWidth={1.5}/></button>
        </div>
        <div className={styles.playbackGroup}>
          <button className={styles.ctrl} onClick={()=>{const i=Math.max(0,activeIdx-1);if(clips[i])onSelectClip(clips[i].id)}}><SkipBack size={14} strokeWidth={1.5}/></button>
          <button className={`${styles.ctrl} ${styles.playBtn}`} onClick={onPlayToggle} disabled={clips.length===0}>
            {isPlaying?<Pause size={16} strokeWidth={1.5}/>:<Play size={16} strokeWidth={1.5}/>}
          </button>
          <button className={styles.ctrl} onClick={()=>{const i=Math.min(clips.length-1,activeIdx+1);if(clips[i])onSelectClip(clips[i].id)}}><SkipForward size={14} strokeWidth={1.5}/></button>
          <button className={`${styles.ctrl} ${isMuted?styles.ctrlMuted:''}`} onClick={()=>setIsMuted(m=>!m)} title={isMuted?'Unmute':'Mute'}>
            {isMuted?<VolumeX size={14} strokeWidth={1.5}/>:<Volume2 size={14} strokeWidth={1.5}/>}
          </button>
          <span className={styles.timeLabel}>{fmt(totalDur)}</span>
        </div>
        <div className={styles.vpGroup}>
          <span className={styles.controlLabel}>Viewport</span>
          <input type="range" min={VIEWPORT_MIN} max={VIEWPORT_MAX} step={5} value={viewportSize} className={styles.vpSlider} onChange={e=>setViewportSize(Number(e.target.value))}/>
          <span className={styles.zoomLabel}>{viewportSize}%</span>
        </div>
      </div>
    </div>
  )
}
