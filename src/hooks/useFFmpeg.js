import { useState, useRef, useCallback } from 'react'
import { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile } from '@ffmpeg/util'

// ─── Constants ────────────────────────────────────────────────────────────────

const QUALITY_DIMS = {
  '480p':  { '16:9': [854,  480],  '9:16': [480,  854]  },
  '720p':  { '16:9': [1280, 720],  '9:16': [720, 1280]  },
  '1080p': { '16:9': [1920, 1080], '9:16': [1080, 1920] },
}

const XFADE_MAP = {
  crossfade: 'fade', slide_left: 'slideleft',
  slide_up:  'slideup', zoom_in: 'zoomin', dip_black: 'fadeblack',
}

// Uniform output spec — every seg_N.mp4 must match these exactly
const SEG_FPS       = 30
const SEG_TIMEBASE  = 90000
const SEG_PIX_FMT   = 'yuv420p'
const SEG_AUD_RATE  = 44100
const SEG_AUD_KBPS  = '128k'

export const PRESET_FONTS = [
  { key: 'Poppins-Regular',         label: 'Poppins',      file: 'Poppins-Regular.ttf',        cssFamily: 'MomPoppins' },
  { key: 'Poppins-Bold',            label: 'Poppins Bold', file: 'Poppins-Bold.ttf',           cssFamily: 'MomPoppinsBold' },
  { key: 'LiberationSans-Regular',  label: 'Sans',         file: 'LiberationSans-Regular.ttf', cssFamily: 'MomSans' },
  { key: 'LiberationSans-Bold',     label: 'Sans Bold',    file: 'LiberationSans-Bold.ttf',    cssFamily: 'MomSansBold' },
  { key: 'LiberationSerif-Regular', label: 'Serif',        file: 'LiberationSerif-Regular.ttf',cssFamily: 'MomSerif' },
  { key: 'LiberationMono-Regular',  label: 'Mono',         file: 'LiberationMono-Regular.ttf', cssFamily: 'MomMono' },
]

// ─── Preview font loader ──────────────────────────────────────────────────────

const _loadedFonts = new Set()
export function loadPreviewFont(fontKey) {
  if (_loadedFonts.has(fontKey)) return
  const preset = PRESET_FONTS.find(f => f.key === fontKey)
  if (!preset) return
  const style = document.createElement('style')
  style.textContent = `@font-face{font-family:'${preset.cssFamily}';src:url('/ffmpeg/fonts/${preset.file}') format('truetype');font-display:block;}`
  document.head.appendChild(style)
  document.fonts.load(`12px '${preset.cssFamily}'`)
  _loadedFonts.add(fontKey)
}

// ─── Filter builders ─────────────────────────────────────────────────────────

/**
 * EQ filter for brightness / contrast / saturation adjustments.
 * Only returns a filter string if any value is non-zero.
 * brightness/contrast/saturation are stored as -50..+50 in clip state.
 * FFmpeg eq filter: brightness -1..+1, contrast 0..2, saturation 0..3
 */
function buildEqFilter(brightness, contrast, saturation) {
  const b = brightness || 0
  const c = contrast   || 0
  const s = saturation || 0
  if (b === 0 && c === 0 && s === 0) return null
  const fb = (b / 50).toFixed(3)              // -1.0 .. +1.0
  const fc = (1 + c / 50).toFixed(3)          //  0.0 .. +2.0
  const fs = (1 + s / 50).toFixed(3)          //  0.0 .. +2.0 (0 = greyscale)
  return `eq=brightness=${fb}:contrast=${fc}:saturation=${fs}`
}

/**
 * Placement filter for still images with no motion effect.
 * Handles:
 *   - Basic letterbox (zoom=1, no pan): scale to fit W×H with black bars
 *   - Saved view (zoom > 1 or pan != 0): scale to fit, pad to W×H, then
 *     crop into the saved pan/zoom position and re-scale to W×H
 *
 * Returns a -vf string (no graph labels, safe anywhere).
 */
/**
 * Build a simple -vf string for video clips (video demuxer scopes iw/ih
 * correctly per filter node, so -vf is safe here).
 */
function buildVideoPlacementVf(W, H, zoom, panX, panY) {
  const cW = Math.round(W)
  const cH = Math.round(H)
  const z  = zoom ?? 1
  const px = panX ?? 0
  const py = panY ?? 0

  const fitVf =
    `scale=${cW}:${cH}:force_original_aspect_ratio=decrease,` +
    `scale=trunc(iw/2)*2:trunc(ih/2)*2,` +
    `pad=${cW}:${cH}:-1:-1:color=black,` +
    `setsar=1`

  if (z === 1 && px === 0 && py === 0) return fitVf

  const cw = Math.floor(cW / z / 2) * 2
  const ch = Math.floor(cH / z / 2) * 2
  const rawCx = (cW - cw) / 2 - px / z
  const rawCy = (cH - ch) / 2 - py / z
  const cx = Math.round(Math.max(0, Math.min(cW - cw, rawCx)))
  const cy = Math.round(Math.max(0, Math.min(cH - ch, rawCy)))

  return `${fitVf},crop=${cw}:${ch}:${cx}:${cy},scale=${cW}:${cH},setsar=1`
}


/**
 * Zoompan image-motion effect.
 *
 * Frame delivery: image2 demuxer with -loop 1 delivers at 25 fps regardless
 * of any -r flag on the input in FFmpeg.wasm 5.1. We use fps=25 in the
 * filter to align with that rate before zoompan sees the stream.
 *
 * zoompan `on` = output frame index (0-based, correct in FFmpeg 5.x).
 * Using `in` evaluates to 0 every frame → static output.
 *
 * The image is pre-scaled slightly larger to give zoom/pan headroom without
 * hitting black borders during the effect animation.
 *
 * Returns null for no-effect (static placement path used instead).
 */
function buildImageEffectVf(effect, W, H, duration) {
  if (!effect || effect === 'none') return null
  const fps    = 25   // must match image2 demuxer rate
  const frames = Math.max(2, Math.ceil(duration * fps))

  switch (effect) {
    case 'ken_burns': {
      const z = `1+(0.18*on/${frames})`
      const x = `(iw/2-(iw/zoom/2))-(iw*0.03*on/${frames})`
      const y = `(ih/2-(ih/zoom/2))-(ih*0.02*on/${frames})`
      return `fps=${fps},scale=${W*1.25|0}:${H*1.25|0},zoompan=z='${z}':x='${x}':y='${y}':d=${frames}:s=${W}x${H}:fps=${fps}`
    }
    case 'pan_zoom': {
      const z = `1+(0.12*sin(PI*on/${frames}))`
      const x = `(iw/2-(iw/zoom/2))-(iw*0.04*sin(PI*on/${frames}))`
      const y = `ih/2-(ih/zoom/2)`
      return `fps=${fps},scale=${W*1.25|0}:${H*1.25|0},zoompan=z='${z}':x='${x}':y='${y}':d=${frames}:s=${W}x${H}:fps=${fps}`
    }
    case 'parallax': {
      const z = `1.08+(0.02*sin(2*PI*on/${frames}))`
      const x = `(iw/2-(iw/zoom/2))+(iw*0.02*sin(2*PI*on/${frames}))`
      const y = `(ih/2-(ih/zoom/2))-(ih*0.01*cos(2*PI*on/${frames}))`
      return `fps=${fps},scale=${W*1.25|0}:${H*1.25|0},zoompan=z='${z}':x='${x}':y='${y}':d=${frames}:s=${W}x${H}:fps=${fps}`
    }
    case 'fade_in': {
      const z    = `1.04-(0.04*on/${frames})`
      const x    = `iw/2-(iw/zoom/2)`
      const y    = `ih/2-(ih/zoom/2)`
      const fade = Math.min(1.2, duration * 0.4).toFixed(2)
      return `fps=${fps},scale=${W*1.1|0}:${H*1.1|0},zoompan=z='${z}':x='${x}':y='${y}':d=${frames}:s=${W}x${H}:fps=${fps},fade=t=in:st=0:d=${fade}`
    }
    default: return null
  }
}

/**
 * drawtext filter for one text overlay segment.
 */
function buildDrawtext(seg, W, H, fontPath) {
  const {
    text = 'Caption', startTime = 0, duration = 3,
    fontSize = 28, color = '#ffffff',
    position = 'bottom', posX = 50, posY = 85,
    animation = 'fade',
  } = seg

  // Escape for FFmpeg drawtext: backslash → \\, single-quote → \', colon → \:
  // Then wrap special chars that break filter graph parsing
  const safeText  = text
    .replace(/\\/g, '\\\\\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/%/g, '\\%')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')

  const safeColor = color.startsWith('#') ? '0x'+color.slice(1).toUpperCase() : color
  const fs = Math.max(8, Math.round(fontSize * (W / 1280)))

  let x, y
  if (position === 'custom') {
    x = `${Math.round(W * posX / 100)}-text_w/2`
    y = `${Math.round(H * posY / 100)}-text_h/2`
  } else {
    x = '(w-text_w)/2'
    y = position === 'top'    ? String(Math.round(H * 0.08))
      : position === 'center' ? '(h-text_h)/2'
      :                         `h-text_h-${Math.round(H * 0.06)}`
  }

  const t0  = +startTime.toFixed(3)
  const end = +(startTime + duration).toFixed(3)

  // Use enable= for time gating (cheap) — avoids per-frame expression overhead.
  // For fade animation use a simple linear alpha: ramp in over fi, ramp out over fo.
  // Keep expressions minimal to avoid FFmpeg.wasm expression evaluator stack issues.
  const enableExpr = `between(t,${t0},${end})`

  let alphaExpr
  if (animation === 'fade' && duration > 0.5) {
    const fi = Math.min(0.4, duration * 0.15)
    const fo = Math.min(0.4, duration * 0.15)
    const t1 = +(t0 + fi).toFixed(3)
    const t2 = +(end - fo).toFixed(3)
    // Flat 1 in the middle, linear ramps at edges — no nested ifs
    alphaExpr = `if(lt(t,${t1}),(t-${t0})/${fi.toFixed(3)},if(gt(t,${t2}),(${end}-t)/${fo.toFixed(3)},1))`
  } else {
    alphaExpr = '1'
  }

  // Use absolute path in WASM FS
  const absFontPath = fontPath.startsWith('/') ? fontPath : `/${fontPath}`

  return [
    `drawtext=fontfile='${absFontPath}'`,
    `fontsize=${fs}`,
    `fontcolor=${safeColor}`,
    `text='${safeText}'`,
    `x=${x}`,
    `y=${y}`,
    `enable='${enableExpr}'`,
    `alpha='${alphaExpr}'`,
  ].join(':')
}

/**
 * Chained atempo for any speed (single atempo only supports 0.5–2.0×).
 * Returns [] for speed ≈ 1× (no-op).
 */
function buildAtempoChain(speed) {
  if (!speed || Math.abs(speed - 1) < 0.001) return []
  const out = []
  let rem = speed
  if (speed > 1) {
    while (rem > 2.001) { out.push('atempo=2.0'); rem /= 2 }
    out.push(`atempo=${rem.toFixed(4)}`)
  } else {
    while (rem < 0.499) { out.push('atempo=0.5'); rem /= 0.5 }
    out.push(`atempo=${rem.toFixed(4)}`)
  }
  return out
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useFFmpeg() {
  const ffmpegRef      = useRef(null)
  const loadedRef      = useRef(false)
  const loadingRef     = useRef(false)
  const runningRef     = useRef(false)
  const fontDataCache  = useRef({}) // key → Uint8Array, populated at load time

  const [loaded,   setLoaded]   = useState(false)
  const [loading,  setLoading]  = useState(false)
  const [progress, setProgress] = useState(0)
  const [logs,     setLogs]     = useState([])

  const allLogsRef = useRef([])

  const pushLog = useCallback(msg => {
    allLogsRef.current = [...allLogsRef.current.slice(-500), msg]
    setLogs(p => [...p.slice(-300), msg])
  }, [])

  const clearLogs = useCallback(() => {
    allLogsRef.current = []
    setLogs([])
  }, [])

  const load = useCallback(async () => {
    if (loadedRef.current || loadingRef.current) return
    loadingRef.current = true; setLoading(true)
    pushLog('Loading FFmpeg…')
    try {
      const ff = new FFmpeg()
      ffmpegRef.current = ff
      ff.on('log', ({ message }) => pushLog(message))
      const base = window.location.origin + '/ffmpeg'
      await ff.load({
        classWorkerURL: `${base}/worker.js`,
        coreURL:        `${base}/esm/ffmpeg-core.js`,
        wasmURL:        `${base}/esm/ffmpeg-core.wasm`,
      })
      // Pre-fetch all preset font files now, while the main thread can freely
      // make network requests. Storing the raw bytes in a ref means Stage 3
      // never needs a fetchFile() call inside the Worker during export — which
      // can fail under strict COOP/COEP in some browsers at higher resolutions.
      fontDataCache.current = {}
      await Promise.all(PRESET_FONTS.map(async f => {
        const res = await fetch(`${base}/fonts/${f.file}`)
        fontDataCache.current[f.key] = new Uint8Array(await res.arrayBuffer())
      }))
      loadedRef.current = true; setLoaded(true)
      pushLog('FFmpeg ready ✓')
    } catch (err) {
      pushLog(`FFmpeg load error: ${err?.message || err}`)
    } finally { loadingRef.current = false; setLoading(false) }
  }, [pushLog])

  const exportMoment = useCallback(async ({
    clips,
    textSegments       = [],
    musicFile,
    musicVolume        = 70,
    musicTrimStart     = 0,
    musicTrimEnd       = null,
    aspectRatio        = '16:9',
    quality            = '720p',
    globalTransition   = 'crossfade',
    transitionDuration = 0.6,
    endFadeVideo       = false,
    endFadeVideoDuration = 1.5,
    endFadeAudio       = false,
    endFadeAudioDuration = 1.5,
    outputName         = 'moment.mp4',
    onProgress,
  }) => {
    if (!ffmpegRef.current || !loadedRef.current) throw new Error('FFmpeg not loaded')
    if (runningRef.current) throw new Error('Export already in progress')
    runningRef.current = true
    setProgress(0)

    const ff     = ffmpegRef.current
    const [W, H] = QUALITY_DIMS[quality]?.[aspectRatio] ?? [1280, 720]
    // ── run(): execute FFmpeg command with full error context ─────────────
    const run = async (label, args) => {
      pushLog(`▶ ${label}`)
      let ret
      try {
        ret = await ff.exec(args)
      } catch (e) {
        const tail = allLogsRef.current.slice(-25).join('\n')
        pushLog(`✖ [${label}] crashed: ${e?.message || e}`)
        throw new Error(`[${label}] crashed: ${e?.message || e}\n\n${tail}`)
      }
      if (ret !== 0) {
        const tail = allLogsRef.current.slice(-25).join('\n')
        pushLog(`✖ [${label}] failed (ret=${ret})`)
        pushLog(tail)
        throw new Error(`[${label}] failed (ret=${ret})\n\n${tail}`)
      }
    }

    const del = async f => { try { await ff.deleteFile(f) } catch { /**/ } }

    let stepsDone = 0
    const tick = (total, label) => {
      stepsDone++
      const pct = Math.min(99, Math.round(stepsDone / total * 100))
      setProgress(pct); onProgress?.(pct)
      pushLog(label)
    }

    try {
      pushLog(`── Export ${W}×${H} · ${quality} · ${aspectRatio} ──`)

      const IMAGE_EXTS = new Set(['jpg','jpeg','png','gif','webp','heic','avif'])

      pushLog('Preparing clip list…')
      const validClips = []

      // Build validClips list without writing files yet — each source file is
      // written to WASM FS just-in-time immediately before its Stage 1 encode,
      // then deleted immediately after. This keeps peak WASM heap usage low
      // for multi-clip exports instead of pre-loading everything upfront.
      for (let i = 0; i < clips.length; i++) {
        const c = clips[i]
        if (!c.file) { pushLog(`  ⚠ Skipping "${c.name}" — no file`); continue }
        const ext   = c.file.name.split('.').pop().toLowerCase()
        const fname = `src_${i}.${ext}`
        validClips.push({ ...c, _fname: fname, _ext: ext, _isImg: IMAGE_EXTS.has(ext) })
        pushLog(`  queued: ${fname}  (${(c.file.size/1024).toFixed(0)} KB)`)
      }
      if (validClips.length === 0) throw new Error('No clips with files to export')
      // Music is needed at Stage 2 (not Stage 1), so write it upfront now.
      if (musicFile) {
        await ff.writeFile('music_src', await fetchFile(musicFile))
        pushLog('  music_src written')
      }

      // td must be shorter than every segment — segments are clamped to td+0.5s
      const td = Math.max(0.1, transitionDuration)
      const TOTAL_STEPS = validClips.length + 2
      tick(TOTAL_STEPS, `${validClips.length} clip(s) ready`)

      // ════════════════════════════════════════════════════════════════════
      // STAGE 1 — Encode each clip into a normalised seg_N.mp4
      //
      // OUTPUT GUARANTEE: every seg_N.mp4 has IDENTICAL stream parameters:
      //   Video : libx264, yuv420p, 30 fps CFR, timebase 1/90000, W×H
      //   Audio : AAC 128k, stereo, 44100 Hz
      //
      // This uniformity is required for xfade. The normalise flags
      // (-r 30, -vsync cfr, -video_track_timescale 90000) are folded
      // directly into the terminal encode pass of each clip — there is
      // no separate Step C mux pass.
      //
      // ── IMAGE CLIP PATH ─────────────────────────────────────────────
      //
      //   Pass 1+2 merged (placement):
      //     If blurBackground: single filter_complex with split —
      //       [_src1] → scale-to-fill → boxblur → [_bg]
      //       [_src2] → fit+even+pad+zoom/pan → [_fg]
      //       [_bg][_fg] → overlay → [vout]
      //     If no blur: fit+pad+zoom/pan filter_complex as before
      //     If effectVf or eqFilter: chained onto [vout] → [vfinal]
      //       in the same filter_complex — no intermediate file.
      //     Silence audio + normalise flags folded into this single pass.
      //
      // ── VIDEO CLIP PATH ──────────────────────────────────────────────
      //
      //   Pass 1+2 merged (placement, terminal):
      //     If blurBackground: single filter_complex with split —
      //       [_src1] → scale-to-fill → boxblur → [_bg]
      //       [_src2] → fit+speed+eq → [_fg]
      //       [_bg][_fg] → overlay → [vout]
      //     If no blur: -vf placement+speed+eq as before
      //     Normalise flags folded in; audOut muxed as second input.
      //
      //   Step B (audio, always separate):
      //     Extracted from source or silence. Runs before Pass 2 terminal
      //     so the audOut file is ready to mux in.
      // ════════════════════════════════════════════════════════════════════
      pushLog('── Stage 1: Encoding clips ──')
      const segments = []

      for (let i = 0; i < validClips.length; i++) {
        const c = validClips[i]

        // ── Compute actualDur ─────────────────────────────────────────────
        // MUST mirror useMediaStore exportDuration formula exactly so the
        // Timeline chip and the encoded output always agree.
        //
        // For video: use (effectiveTrimEnd - trimStart) / speed.
        //   effectiveTrimEnd = explicit trimEnd  OR  fileDuration  OR  c.duration
        //   This matches useMediaStore which uses `c.trimEnd || c.fileDuration`.
        //   Falling back to c.duration alone (old behaviour) caused the encoded
        //   segment to be shorter than the chip showed whenever fileDuration
        //   differed from c.duration (e.g. the clip had no explicit trimEnd set).
        //
        // The td+0.5 guard is applied AFTER deriving the natural duration.
        // When it inflates actualDur, sourceDur below is also recalculated so
        // FFmpeg does not run out of input before the segment finishes.
        let actualDur
        if (c._isImg) {
          actualDur = Math.max(td + 0.5, c.duration || 4)
        } else {
          const speed     = c.speed > 0 ? c.speed : 1
          const trimStart = c.trimStart || 0
          const effectiveTrimEnd = (c.trimEnd && c.trimEnd > trimStart)
            ? c.trimEnd
            : (c.fileDuration || c.duration || 4)
          actualDur = (effectiveTrimEnd - trimStart) / speed
          actualDur = Math.max(td + 0.5, actualDur)
        }
        const durStr = actualDur.toFixed(4)

        // Write this clip's source file to WASM FS just before its encode.
        // Deleted at the end of this clip's processing — only one source
        // file lives in WASM heap at a time, keeping peak memory low.
        await ff.writeFile(c._fname, await fetchFile(c.file))
        pushLog(`  wrote ${c._fname}  (${(c.file.size/1024).toFixed(0)} KB)`)

        pushLog(
          `\n  ┌─ [${i+1}/${validClips.length}] "${c.name}" — ${c._isImg ? 'IMAGE' : 'VIDEO'} — ${actualDur.toFixed(2)}s` +
          (c.imageEffect    ? `\n  │  effect: ${c.imageEffect}` : '') +
          (c.blurBackground ? '\n  │  blur-bg: ON' : '') +
          ((c.viewZoom && c.viewZoom !== 1) ? `\n  │  zoom: ${c.viewZoom}×  pan: ${c.viewPanX|0},${c.viewPanY|0}` : '') +
          ((c.speed && c.speed !== 1) ? `\n  │  speed: ${c.speed}×` : '') +
          ((c.brightness||c.contrast||c.saturation) ? `\n  │  eq: b=${c.brightness} c=${c.contrast} s=${c.saturation}` : '')
        )

        const eqFilter = buildEqFilter(c.brightness, c.contrast, c.saturation)

        if (c._isImg) {
          // ── Pass 1+2 merged: blur base + placement ────────────────────
          // When blurBackground is set, the old approach encoded blurbase_N.mp4
          // as a separate pass, then used it as [1:v] in the placement pass.
          // Now we use a single filter_complex with split to generate both
          // chains from the same -loop 1 input — one encode pass instead of two.
          //
          // If blurBackground is OFF, placement runs as before (no split needed).

          const z  = c.viewZoom ?? 1
          const px = c.viewPanX ?? 0
          const py = c.viewPanY ?? 0

          let placeFc, placeLabel

          if (c.blurBackground) {
            // Split the single looped source into two chains:
            //   [_src1] → scale-to-fill → boxblur → [_bg]   (full-bleed blurred canvas)
            //   [_src2] → fit + optional zoom/pan → [_fg]    (placed image, no black bars)
            //   [_bg][_fg] → overlay centered → [vout]
            const splitNode = `[0:v]split=2[_src1][_src2]`
            const bgChain   =
              `[_src1]scale=${W}:${H}:force_original_aspect_ratio=increase,` +
              `crop=${W}:${H},` +
              `boxblur=luma_radius=20:luma_power=2[_bg]`

            const fitFgNode  = `[_src2]scale=${W}:${H}:force_original_aspect_ratio=decrease[_ffit]`
            const evenFgNode = `[_ffit]scale=trunc(iw/2)*2:trunc(ih/2)*2[_fg]`

            let fgNodes, overlayLabel
            if (z === 1 && px === 0 && py === 0) {
              fgNodes      = [fitFgNode, evenFgNode]
              overlayLabel = '[_fg]'
            } else {
              const cropNode    = `[_fg]crop=iw/${z}:ih/${z}:iw/2-iw/${z}/2-${(px/z).toFixed(2)}:ih/2-ih/${z}/2-${(py/z).toFixed(2)}[_fgcrop]`
              const scaleUpNode = `[_fgcrop]scale=trunc(iw/2)*2:trunc(ih/2)*2[_fgscaled]`
              fgNodes      = [fitFgNode, evenFgNode, cropNode, scaleUpNode]
              overlayLabel = '[_fgscaled]'
            }
            const overlayNode = `[_bg]${overlayLabel}overlay=(W-w)/2:(H-h)/2[vout]`
            placeFc = [splitNode, bgChain, ...fgNodes, overlayNode].join(';')
            placeLabel = '[vout]'

            pushLog(`  │  pass1+2 merged: blur+placement` +
              (z !== 1 ? `[zoom=${z}]` : '[fit]'))
          } else {
            // No blur — standard placement filter_complex (unchanged)
            const fitNode  = `[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease[_fit]`
            const evenNode = `[_fit]scale=trunc(iw/2)*2:trunc(ih/2)*2[_even]`
            const padNode  = `[_even]pad=${W}:${H}:-1:-1:color=black[_padded]`

            let zoomNodes
            if (z === 1 && px === 0 && py === 0) {
              zoomNodes = [`[_padded]setsar=1[_placed]`]
            } else {
              const cw = Math.floor(W / z / 2) * 2
              const ch = Math.floor(H / z / 2) * 2
              const rawCx = (W - cw) / 2 - px / z
              const rawCy = (H - ch) / 2 - py / z
              const cx = Math.round(Math.max(0, Math.min(W - cw, rawCx)))
              const cy = Math.round(Math.max(0, Math.min(H - ch, rawCy)))
              zoomNodes = [
                `[_padded]crop=${cw}:${ch}:${cx}:${cy}[_cropped]`,
                `[_cropped]scale=${W}:${H},setsar=1[_placed]`,
              ]
            }
            const exposeNode = `[_placed]setsar=1[vout]`
            placeFc    = [fitNode, evenNode, padNode, ...zoomNodes, exposeNode].join(';')
            placeLabel = '[vout]'

            pushLog(`  │  pass2: placement` + (z !== 1 ? `[zoom=${z}]` : '[fit]'))
          }

          // ── Pass 2 (only pass): placement + optional effect/EQ → seg_N.mp4 ──
          //
          // effectVf and eqFilter are appended as additional filter nodes on
          // [vout] inside the same filter_complex — no intermediate file.
          // This collapses the old Pass 2 (placement) + Pass 3 (effect/EQ)
          // into a single encode, regardless of which combination is active.

          const effectVf  = buildImageEffectVf(c.imageEffect, W, H, actualDur)
          const segFile   = `seg_${i}.mp4`

          // Build the terminal filter label: append effectVf and/or eqFilter
          // as extra nodes after [vout] if present.
          let termFc    = placeFc
          let termLabel = placeLabel   // '[vout]' in all cases

          if (effectVf || eqFilter) {
            // Chain effect and/or EQ onto [vout] → [vfinal]
            const extraChain = [effectVf, eqFilter].filter(Boolean).join(',')
            termFc    = `${placeFc};${termLabel}${extraChain}[vfinal]`
            termLabel = '[vfinal]'
            pushLog(`  │  effect/eq folded into placement pass` +
              (effectVf ? `  [${c.imageEffect}]` : '') +
              (eqFilter  ? '+eq' : ''))
          }

          // Shared normalise+mux flags — replace the old Step C entirely
          const normAudioInputs = [
            '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
          ]
          const normEncodeFlags = [
            '-r', String(SEG_FPS), '-fps_mode', 'cfr',
            '-video_track_timescale', String(SEG_TIMEBASE),
            '-c:a', 'aac', '-b:a', SEG_AUD_KBPS, '-ar', String(SEG_AUD_RATE), '-ac', '2',
          ]

          await run(`img-place[${i}]`, [
            '-loop', '1', '-i', c._fname,
            ...normAudioInputs,
            '-filter_complex', termFc,
            '-map', termLabel,
            '-map', '1:a',
            '-t', durStr,
            '-c:v', 'libx264', '-pix_fmt', SEG_PIX_FMT, '-preset', 'ultrafast',
            '-threads', '1',
            ...normEncodeFlags,
            '-t', durStr,
            segFile,
          ])
          pushLog(`  │  audio: silence (muxed)`)

          await del(c._fname)
          pushLog(`  └─ seg_${i}.mp4 ✓  (${actualDur.toFixed(2)}s, normalised)`)
          segments.push({ file: segFile, actualDur, clip: c })

        } else {
          // ─────────────────────────────────────────────────────────────
          // VIDEO — Pass 1+2 merged (blur via split) + Step C folded in
          // ─────────────────────────────────────────────────────────────
          const speed     = c.speed > 0 ? c.speed : 1
          const trimStart = c.trimStart || 0
          // effectiveTrimEnd must match what actualDur was computed from above
          const effectiveTrimEnd = (c.trimEnd && c.trimEnd > trimStart)
            ? c.trimEnd
            : (c.fileDuration || c.duration || 4)
          const sourceDur = effectiveTrimEnd - trimStart

          const speedFilter = speed !== 1
            ? `setpts=${(1/speed).toFixed(6)}*PTS`
            : null

          const z  = c.viewZoom ?? 1
          const px = c.viewPanX ?? 0
          const py = c.viewPanY ?? 0

          // ── Pass 1+2 merged: placement (+ blur via split if enabled) ──
          const segFile  = `seg_${i}.mp4`
          const vidForAud = c._fname  // audio step reads directly from source

          let vidPassArgs
          if (c.blurBackground) {
            // Single input split into blur bg chain + fg placement chain.
            // iw/ih in crop/scale nodes are safe — video demuxer scopes per node.
            const fgVfParts = [
              `scale=${W}:${H}:force_original_aspect_ratio=decrease`,
              `scale=trunc(iw/2)*2:trunc(ih/2)*2`,
            ]
            if (z !== 1 || px !== 0 || py !== 0) {
              fgVfParts.push(
                `crop=iw/${z}:ih/${z}:` +
                `iw/2-iw/${z}/2-${(px / z).toFixed(2)}:` +
                `ih/2-ih/${z}/2-${(py / z).toFixed(2)}`
              )
              fgVfParts.push(`scale=trunc(iw/2)*2:trunc(ih/2)*2`)
            }
            if (speedFilter) fgVfParts.push(speedFilter)
            if (eqFilter)    fgVfParts.push(eqFilter)

            const fc =
              `[0:v]split=2[_src1][_src2];` +
              `[_src1]scale=${W}:${H}:force_original_aspect_ratio=increase,` +
                `crop=${W}:${H},boxblur=luma_radius=20:luma_power=2[_bg];` +
              `[_src2]${fgVfParts.join(',')}[_fg];` +
              `[_bg][_fg]overlay=(W-w)/2:(H-h)/2[vout]`

            pushLog(`  │  pass1+2 merged: blur+placement` +
              (z !== 1 ? `[zoom=${z}]` : '[fit]') +
              (speedFilter ? `+speed[${speed}×]` : '') +
              (eqFilter ? '+eq' : '') + ' +norm')

            vidPassArgs = {
              inputs:      ['-ss', String(trimStart), '-i', c._fname, '-t', String(sourceDur)],
              filterFlags: ['-filter_complex', fc],
              vMap:        '[vout]',
            }
          } else {
            // No blur — -vf pass (unchanged logic, Step C flags folded in)
            const placementVf = buildVideoPlacementVf(W, H, z, px, py)
            const vfParts = [placementVf, speedFilter, eqFilter].filter(Boolean)
            const vf = vfParts.join(',')

            pushLog(`  │  pass2: placement` +
              (z !== 1 ? `[zoom=${z}]` : '[fit]') +
              (speedFilter ? `+speed[${speed}×]` : '') +
              (eqFilter ? '+eq' : '') + ' +norm')

            vidPassArgs = {
              inputs:      ['-ss', String(trimStart), '-i', c._fname, '-t', String(sourceDur)],
              filterFlags: ['-vf', vf],
              vMap:        '0:v:0',
            }
          }

          // ── Step B: audio ─────────────────────────────────────────────
          const audOut = `aud_${i}.aac`
          let audioOk  = false

          if (c.includeAudio !== false) {
            try {
              const atempoArgs = buildAtempoChain(speed)
              const filterArgs = atempoArgs.length ? ['-filter:a', atempoArgs.join(',')] : []
              await run(`vid-aud[${i}]`, [
                '-ss', String(trimStart),
                '-i', vidForAud,
                '-t', String(sourceDur),
                '-vn', ...filterArgs,
                '-c:a', 'aac', '-b:a', SEG_AUD_KBPS, '-ar', String(SEG_AUD_RATE), '-ac', '2',
                '-t', durStr,
                audOut,
              ])
              audioOk = true
              pushLog(`  │  audio: extracted`)
            } catch (e) {
              pushLog(`  │  audio: extract failed → silence  (${e.message.split('\n')[0]})`)
            }
          }

          if (!audioOk) {
            await run(`vid-sil[${i}]`, [
              '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
              '-t', durStr,
              '-c:a', 'aac', '-b:a', SEG_AUD_KBPS, '-ar', String(SEG_AUD_RATE), '-ac', '2',
              audOut,
            ])
            pushLog(`  │  audio: silence`)
          }

          // ── Pass 2 terminal: visual encode + normalise + mux → seg_N.mp4 ─
          // All inputs come first, then all output flags (filter, map, codec, etc).
          // Step C is eliminated — normalise flags folded in here directly.
          await run(`vid-place[${i}]`, [
            ...vidPassArgs.inputs,
            '-i', audOut,
            ...vidPassArgs.filterFlags,
            '-map', vidPassArgs.vMap, '-map', '1:a',
            '-t', durStr,
            '-c:v', 'libx264', '-pix_fmt', SEG_PIX_FMT, '-preset', 'ultrafast',
            '-threads', '1',
            '-r', String(SEG_FPS), '-fps_mode', 'cfr',
            '-video_track_timescale', String(SEG_TIMEBASE),
            '-c:a', 'aac', '-b:a', SEG_AUD_KBPS, '-ar', String(SEG_AUD_RATE), '-ac', '2',
            segFile,
          ])

          await del(audOut)
          await del(c._fname)
          pushLog(`  └─ seg_${i}.mp4 ✓  (${actualDur.toFixed(2)}s, normalised)`)
          segments.push({ file: segFile, actualDur, clip: c })
        }

        tick(TOTAL_STEPS, `  ✓ Clip ${i+1}/${validClips.length} → ${actualDur.toFixed(2)}s`)
      }

      const total = segments.reduce((s, x) => s + x.actualDur, 0)
      pushLog(`\n  Timeline: ${total.toFixed(2)}s  |  ${segments.length} segment(s) — all normalised ✓`)

      // ════════════════════════════════════════════════════════════════════
      // STAGE 2 — Transitions + music → prefinal.mp4
      //
      // All segments now have identical timebases (1/90000), 30fps CFR,
      // and uniform audio (AAC 128k 44100 stereo). xfade and acrossfade
      // will not crash.
      //
      // Segments are fed directly as N separate inputs (no pre-joining,
      // no re-seeking). xfade offsets are derived from seg.actualDur —
      // the real encoded duration — so the timeline is always correct.
      // ════════════════════════════════════════════════════════════════════
      pushLog('\n── Stage 2: Transitions & music ──')

      const hasMusicFile = !!musicFile
      const multiClip    = segments.length > 1
      let   preFinal     = 'prefinal.mp4'

      // Build atrim filter for music if a trim range is set.
      const hasMusicTrim = musicTrimStart > 0 || musicTrimEnd != null
      const musicTrimFilter = hasMusicTrim
        ? `atrim=start=${musicTrimStart}${musicTrimEnd != null ? `:end=${musicTrimEnd}` : ''},asetpts=PTS-STARTPTS,`
        : ''

      // ── Fast path: all transitions are 'none' and no music ──────────────
      // All seg_N.mp4 files have identical codec/timebase/fps parameters so
      // the concat demuxer can stream-copy them with zero re-encode.
      // This eliminates Stage 2's encode entirely for cut-only exports.
      const allCuts = multiClip && !hasMusicFile &&
        segments.every(s => (s.clip.transition || globalTransition) === 'none')

      if (allCuts) {
        pushLog('  all cuts — using concat demuxer (stream copy)')
        // Write a concat playlist to WASM FS
        const playlist = segments.map(s => `file ${s.file}`).join('\n')
        await ff.writeFile('concat_list.txt', playlist)
        await run('s2-concat', [
          '-f', 'concat', '-safe', '0',
          '-i', 'concat_list.txt',
          '-c', 'copy',
          preFinal,
        ])
        await del('concat_list.txt')

      } else if (!multiClip && !hasMusicFile) {
        await run('s2-copy', ['-i', segments[0].file, '-c', 'copy', preFinal])

      } else if (!multiClip && hasMusicFile) {
        const mv = Math.max(0, Math.min(1, (musicVolume ?? 70) / 100)).toFixed(3)
        await run('s2-music', [
          '-i', segments[0].file, '-i', 'music_src',
          '-filter_complex',
          `[0:a]volume=1.0[ca];[1:a]${musicTrimFilter}volume=${mv}[ma];[ca][ma]amix=inputs=2:duration=first[aout]`,
          '-map', '0:v', '-map', '[aout]',
          '-c:v', 'copy', '-c:a', 'aac', '-b:a', SEG_AUD_KBPS, '-shortest',
          preFinal,
        ])

      } else {
        const segInputs = segments.flatMap(s => ['-i', s.file])
        const vParts    = []
        const aParts    = []
        let   vLabel    = '[0:v]'
        let   aLabel    = '[0:a]'
        let   timeOff   = 0

        for (let i = 0; i < segments.length - 1; i++) {
          const last   = i === segments.length - 2
          const vOut   = last ? '[vfinal]' : `[xv${i}]`
          const aOut   = last ? '[afinal]' : `[xa${i}]`
          const clipTransition = segments[i].clip.transition || globalTransition

          if (clipTransition === 'none') {
            // Hard cut — concat the two streams with no overlap.
            // concat filter resets timebase to 1/1000000, which breaks any
            // subsequent xfade node that expects 1/90000. If this is not the
            // last join (i.e. more filters follow), normalise the timebase
            // immediately after concat so the next xfade sees a consistent tb.
            if (last) {
              vParts.push(`${vLabel}[${i+1}:v]concat=n=2:v=1:a=0${vOut}`)
              aParts.push(`${aLabel}[${i+1}:a]concat=n=2:v=0:a=1${aOut}`)
            } else {
              const vTmp = `[cv${i}]`
              const aTmp = `[ca${i}]`
              vParts.push(`${vLabel}[${i+1}:v]concat=n=2:v=1:a=0${vTmp}`)
              vParts.push(`${vTmp}settb=1/${SEG_TIMEBASE},setpts=PTS${vOut}`)
              aParts.push(`${aLabel}[${i+1}:a]concat=n=2:v=0:a=1${aTmp}`)
              aParts.push(`${aTmp}asetpts=PTS${aOut}`)
            }
            timeOff += segments[i].actualDur  // full duration, no td subtracted
          } else {
            const xfName = XFADE_MAP[clipTransition] || 'fade'
            timeOff     += segments[i].actualDur - td
            vParts.push(`${vLabel}[${i+1}:v]xfade=transition=${xfName}:duration=${td}:offset=${timeOff.toFixed(4)}${vOut}`)
            aParts.push(`${aLabel}[${i+1}:a]acrossfade=d=${td.toFixed(4)}${aOut}`)
          }
          vLabel = vOut
          aLabel = aOut
        }

        if (hasMusicFile) {
          const mv  = Math.max(0, Math.min(1, (musicVolume ?? 70) / 100)).toFixed(3)
          const N   = segments.length
          const fcp = [
            ...vParts, ...aParts,
            `[afinal]volume=1.0[cv];[${N}:a]${musicTrimFilter}volume=${mv}[mv];[cv][mv]amix=inputs=2:duration=first[mixout]`,
          ]
          await run('s2-xfade+music', [
            ...segInputs, '-i', 'music_src',
            '-filter_complex', fcp.join(';'),
            '-map', '[vfinal]', '-map', '[mixout]',
            '-c:v', 'libx264', '-pix_fmt', SEG_PIX_FMT, '-preset', 'ultrafast',
          '-threads', '1',
            '-c:a', 'aac', '-b:a', SEG_AUD_KBPS, '-shortest',
            preFinal,
          ])
        } else {
          await run('s2-xfade', [
            ...segInputs,
            '-filter_complex', [...vParts, ...aParts].join(';'),
            '-map', '[vfinal]', '-map', '[afinal]',
            '-c:v', 'libx264', '-pix_fmt', SEG_PIX_FMT, '-preset', 'ultrafast',
          '-threads', '1',
            '-c:a', 'aac', '-b:a', SEG_AUD_KBPS,
            preFinal,
          ])
        }
      }

      for (const s of segments) await del(s.file)
      tick(TOTAL_STEPS, '  ✓ Transitions & music applied')

      // ════════════════════════════════════════════════════════════════════
      // STAGE 3 — Text overlays → output.mp4
      // All drawtext in one -vf pass. Audio: -c:a copy.
      // ════════════════════════════════════════════════════════════════════
      const activeSegs = textSegments.filter(s => s.text?.trim())

      if (activeSegs.length > 0) {
        pushLog(`\n── Stage 3: ${activeSegs.length} text overlay(s) ──`)
        const fontCache = {}
        for (const seg of activeSegs) {
          const key = seg.fontFile || 'Poppins-Regular'
          if (fontCache[key]) continue
          if (key === 'custom' && seg.customFontData) {
            await del(`font_${key}.ttf`)
            // Slice a fresh copy — writeFile transfers the ArrayBuffer to the Worker,
            // detaching it. customFontData lives in React state so without .slice()
            // the second export (e.g. quality change) crashes with DataCloneError.
            await ff.writeFile(`font_${key}.ttf`, seg.customFontData.slice())
          } else {
            const preset = PRESET_FONTS.find(f => f.key === key) ?? PRESET_FONTS[0]
            const fontBytes = fontDataCache.current[preset.key]
            if (!fontBytes) throw new Error(`Font data not pre-loaded for key: ${preset.key}`)
            await del(`font_${key}.ttf`)
            // Slice a fresh copy — writeFile transfers the ArrayBuffer to the Worker,
            // which detaches it. Without .slice() the cached Uint8Array becomes unusable
            // after the first export and every subsequent export crashes with DataCloneError.
            await ff.writeFile(`font_${key}.ttf`, fontBytes.slice())
          }
          fontCache[key] = `font_${key}.ttf`
        }
        const vfChain = activeSegs.map(s =>
          buildDrawtext(s, W, H,
            fontCache[s.fontFile || 'Poppins-Regular'] ?? fontCache['Poppins-Regular'])
        ).join(',')
        await run('s3-text', [
          '-threads', '1',
          '-filter_threads', '1',
          '-i', preFinal,
          '-vf', vfChain,
          '-c:v', 'libx264', '-pix_fmt', SEG_PIX_FMT, '-preset', 'ultrafast',
          '-x264opts', 'no-mbtree=1:sync-lookahead=0:rc-lookahead=0',
          '-c:a', 'copy',
          'output.mp4',
        ])
        // Clean up font files so they don't persist stale into the next export
        for (const fontFile of Object.values(fontCache)) await del(fontFile)
        await del(preFinal)
      } else {
        pushLog('\n── Stage 3: No text overlays ──')
        await run('s3-copy', ['-i', preFinal, '-c', 'copy', 'output.mp4'])
        await del(preFinal)
      }

      // ════════════════════════════════════════════════════════════════════
      // STAGE 4 — End fade (fade to black / fade out audio) → output.mp4
      // ════════════════════════════════════════════════════════════════════
      if (endFadeVideo || endFadeAudio) {
        pushLog('\n── Stage 4: End fade ──')

        // Compute total encoded duration from segments
        const totalEncDur = segments.reduce((sum, s) => sum + s.actualDur, 0)
          - (segments.length > 1 ? (segments.length - 1) * td : 0)

        const vfd = Math.min(endFadeVideoDuration, totalEncDur)
        const afd = Math.min(endFadeAudioDuration, totalEncDur)
        const vStart = (totalEncDur - vfd).toFixed(4)
        const aStart = (totalEncDur - afd).toFixed(4)

        const vfParts = []
        const afParts = []

        if (endFadeVideo) {
          vfParts.push(`fade=t=out:st=${vStart}:d=${vfd.toFixed(4)}:color=black`)
        }
        if (endFadeAudio) {
          afParts.push(`afade=t=out:st=${aStart}:d=${afd.toFixed(4)}`)
        }

        const hasBoth  = vfParts.length > 0 && afParts.length > 0
        const hasVOnly = vfParts.length > 0 && afParts.length === 0
        const hasAOnly = vfParts.length === 0 && afParts.length > 0

        const cleanFadeArgs = ['-i', 'output.mp4']
        if (endFadeVideo) cleanFadeArgs.push('-vf', vfParts.join(','))
        if (endFadeAudio) cleanFadeArgs.push('-af', afParts.join(','))
        if (endFadeVideo) { cleanFadeArgs.push('-c:v', 'libx264', '-pix_fmt', SEG_PIX_FMT, '-preset', 'ultrafast', '-threads', '1') }
        else              { cleanFadeArgs.push('-c:v', 'copy') }
        if (endFadeAudio) { cleanFadeArgs.push('-c:a', 'aac', '-b:a', SEG_AUD_KBPS) }
        else              { cleanFadeArgs.push('-c:a', 'copy') }
        cleanFadeArgs.push('output_faded.mp4')

        await run('s4-fade', cleanFadeArgs)
        await del('output.mp4')
        // Zero-copy rename — avoids reading the entire output file into JS heap twice
        await ff.rename('output_faded.mp4', 'output.mp4')
      }

      tick(TOTAL_STEPS, '  ✓ Export complete')

      pushLog('Reading output…')
      const data = await ff.readFile('output.mp4')
      const blob = new Blob([data.buffer], { type: 'video/mp4' })
      setProgress(100); onProgress?.(100)
      pushLog(`✓ Done — ${(blob.size/1024/1024).toFixed(1)} MB`)
      return { blob, url: URL.createObjectURL(blob) }

    } finally {
      // Always terminate the WASM instance after export (success or failure).
      // FFmpeg.wasm accumulates internal libavcodec/libavfilter state — font
      // caches, codec contexts, heap fragmentation — that cannot be fully reset
      // between runs. Re-using the same instance for a second export at a
      // different quality causes Aborted() in the drawtext filter graph.
      // Terminating here forces a clean WASM instance on the next export,
      // exactly matching the clean state a hard reload provides.
      try {
        if (ffmpegRef.current) {
          ffmpegRef.current.terminate()
        }
      } catch { /* ignore terminate errors */ } finally {
        ffmpegRef.current = null
        loadedRef.current = false
        setLoaded(false)
      }
      runningRef.current = false
    }
  }, [pushLog])

  return { load, loaded, loading, progress, logs, clearLogs, exportMoment }
}
