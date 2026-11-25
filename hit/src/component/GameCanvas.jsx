import { useEffect, useRef, useState } from 'react'
import './GameCanvas.css'

const GAME_DURATION = 60
// Keep every game calculation in this fixed portrait coordinate space.
const GAME_WIDTH = 360
const GAME_HEIGHT = 640
const HERO_HEIGHT_RATIO = 0.22
const HERO_HEIGHT = GAME_HEIGHT * HERO_HEIGHT_RATIO
// Changed: car dimensions and hero roof anchor are adjustable here.
const CAR_WIDTH_RATIO = 0.7
const CAR_WIDTH = GAME_WIDTH * CAR_WIDTH_RATIO
const CAR_ROOF_Y_RATIO = 0.25
const CAR_ROOF_X_RATIO = 0.5
// Normalized coordinates measured from the unflipped hero image's top-left.
const MUZZLE_OFFSET = { x: 0.84, y: 0.08 }
const DEBUG = false
const BULLET_SPEED = 1100
const RECOIL_DISTANCE = 3
const RECOIL_DURATION = 80
const MUZZLE_FLASH_DURATION = 70
const ROAD_TOP = GAME_HEIGHT * 0.53
const ROAD_BOTTOM = GAME_HEIGHT * 0.92
const PEDESTRIAN_COLORS = ['#0f766e', '#7c3aed', '#b45309', '#2563eb']
// Changed: gunfire asset and volume are configurable here.
const GUNFIRE_SOUND_PATH = '/sound/gunfire.mp3'
const GUNFIRE_VOLUME = 0.6
// Changed: use the existing villain-hit sound asset.
const HIT_SOUND_PATH = '/sounds/hit%20sounds.mp3'
const HIT_SOUND_VOLUME = 0.6
const MUTE_STORAGE_KEY = 'roadHeroMuted'

// Changed: preload each source once; each effect uses its own playback clone.
const GUNFIRE_AUDIO = new Audio(GUNFIRE_SOUND_PATH)
GUNFIRE_AUDIO.preload = 'auto'
GUNFIRE_AUDIO.volume = GUNFIRE_VOLUME
const HIT_AUDIO = new Audio(HIT_SOUND_PATH)
HIT_AUDIO.preload = 'auto'
HIT_AUDIO.volume = HIT_SOUND_VOLUME
const GUNFIRE_UNLOCK_STATE = { unlocked: false, pending: false }
const HIT_UNLOCK_STATE = { unlocked: false, pending: false }

function unlockAudio(audio, state, volume) {
  if (state.unlocked || state.pending) return

  state.pending = true
  audio.volume = 0
  const finishUnlock = (unlocked) => {
    audio.pause()
    let resetSucceeded = true
    try {
      audio.currentTime = 0
    } catch {
      resetSucceeded = false
    }
    audio.volume = volume
    state.unlocked = unlocked && resetSucceeded
    state.pending = false
  }

  try {
    const playback = audio.play()
    if (playback && typeof playback.then === 'function') {
      playback.then(() => finishUnlock(true)).catch(() => finishUnlock(false))
    } else {
      finishUnlock(true)
    }
  } catch {
    finishUnlock(false)
  }
}

function unlockGameAudio() {
  unlockAudio(GUNFIRE_AUDIO, GUNFIRE_UNLOCK_STATE, GUNFIRE_VOLUME)
  unlockAudio(HIT_AUDIO, HIT_UNLOCK_STATE, HIT_SOUND_VOLUME)
}

function playAudioClone(source, volume, muted) {
  if (muted) return

  const shotAudio = source.cloneNode()
  shotAudio.preload = 'auto'
  shotAudio.volume = volume
  try {
    shotAudio.currentTime = 0
    const playback = shotAudio.play()
    if (playback && typeof playback.catch === 'function') {
      playback.catch(() => {
        // Audio is optional; a blocked or missing sound must not interrupt gameplay.
      })
    }
  } catch {
    // Audio is optional; a blocked or missing sound must not interrupt gameplay.
  }
}

function playGunfireSound(muted) {
  playAudioClone(GUNFIRE_AUDIO, GUNFIRE_VOLUME, muted)
}

function playVillainHitSound(muted) {
  playAudioClone(HIT_AUDIO, HIT_SOUND_VOLUME, muted)
}

// Changed: villain tuning and hit regions are proportions of each source image.
// The existing asset folder is public/image (singular) in this workspace.
const VILLAIN_TYPES = [
  {
    name: 'AB',
    image: '/image/ab.png',
    speed: 1.4,
    height: GAME_HEIGHT * 0.14,
    type: 'car',
    hasGirl: true,
    points: 20,
    villainBox: { x: 0.4, y: 0.16, width: 0.35, height: 0.4 },
    girlBox: { x: 0.12, y: 0.18, width: 0.27, height: 0.4 },
  },
  {
    name: 'LB',
    image: '/image/lb.png',
    speed: 0.9,
    height: GAME_HEIGHT * 0.12,
    type: 'walker',
    hasGirl: false,
    points: 10,
    villainBox: { x: 0.27, y: 0.06, width: 0.47, height: 0.88 },
  },
  {
    name: 'VO',
    image: '/image/vo.png',
    speed: 1.8,
    height: GAME_HEIGHT * 0.13,
    type: 'bike',
    hasGirl: false,
    points: 15,
    villainBox: { x: 0.04, y: 0.08, width: 0.92, height: 0.86 },
  },
]

// Changed: load all villain sprites once rather than loading them per spawn.
const VILLAIN_IMAGES = VILLAIN_TYPES.map((villain) => {
  const image = new Image()
  image.onerror = () => console.error(`Could not load villain image: ${villain.image}`)
  image.src = villain.image
  return image
})

// This workspace stores the supplied hero at public/image/hero.png.
const HERO_IMAGE = new Image()
HERO_IMAGE.onerror = () => console.error(`Could not load hero image: ${HERO_IMAGE.src}`)
HERO_IMAGE.src = '/image/hero.png'

// Changed: preload the fixed car sprite and cache its draw and roof coordinates.
const CAR_IMAGE = new Image()
let carHeight = 0
let carLeft = (GAME_WIDTH - CAR_WIDTH) / 2
let carTop = GAME_HEIGHT
let carRoofX = GAME_WIDTH / 2
let carRoofY = GAME_HEIGHT - 72
CAR_IMAGE.onload = () => {
  carHeight = CAR_WIDTH * CAR_IMAGE.naturalHeight / CAR_IMAGE.naturalWidth
  carTop = GAME_HEIGHT - carHeight
  carRoofX = carLeft + CAR_WIDTH * CAR_ROOF_X_RATIO
  carRoofY = carTop + carHeight * CAR_ROOF_Y_RATIO
}
CAR_IMAGE.onerror = () => console.error(`Could not load car image: ${CAR_IMAGE.src}`)
CAR_IMAGE.src = '/image/car.png'

class Hero {
  constructor() {
    this.x = carRoofX
    this.y = carRoofY
    this.facingLeft = false
    this.recoilStartedAt = 0
    this.recoilDirection = 0
  }

  getRecoilOffset(timestamp) {
    const progress = Math.min(
      1,
      Math.max(0, 1 - (timestamp - this.recoilStartedAt) / RECOIL_DURATION),
    )
    return this.recoilDirection * RECOIL_DISTANCE * progress
  }

  getMuzzlePoint(timestamp) {
    if (!HERO_IMAGE.complete || !HERO_IMAGE.naturalWidth) return null

    const width = (HERO_IMAGE.naturalWidth / HERO_IMAGE.naturalHeight) * HERO_HEIGHT
    const drawX = this.x + this.getRecoilOffset(timestamp)
    const imageLeft = drawX - width / 2
    const normalizedX = this.facingLeft ? 1 - MUZZLE_OFFSET.x : MUZZLE_OFFSET.x

    return {
      x: imageLeft + normalizedX * width,
      y: this.y - HERO_HEIGHT + MUZZLE_OFFSET.y * HERO_HEIGHT,
    }
  }

  drawCar(context) {
    if (!CAR_IMAGE.complete || !CAR_IMAGE.naturalWidth) return
    context.drawImage(CAR_IMAGE, carLeft, carTop, CAR_WIDTH, carHeight)

    if (DEBUG) {
      context.strokeStyle = '#22c55e'
      context.lineWidth = 1
      context.strokeRect(carLeft, carTop, CAR_WIDTH, carHeight)
      context.beginPath()
      context.moveTo(carRoofX - 18, carRoofY)
      context.lineTo(carRoofX + 18, carRoofY)
      context.stroke()
    }
  }

  draw(context, timestamp) {
    // Keep the hero anchored to the roof after the image finishes loading.
    this.x = carRoofX
    this.y = carRoofY
    this.drawCar(context)
    if (!HERO_IMAGE.complete || !HERO_IMAGE.naturalWidth) return

    const width = (HERO_IMAGE.naturalWidth / HERO_IMAGE.naturalHeight) * HERO_HEIGHT
    const recoilOffset = this.getRecoilOffset(timestamp)
    const drawX = this.x + recoilOffset
    const imageLeft = drawX - width / 2
    const imageTop = this.y - HERO_HEIGHT

    context.save()
    if (this.facingLeft) {
      context.translate(drawX, 0)
      context.scale(-1, 1)
      context.drawImage(HERO_IMAGE, -width / 2, imageTop, width, HERO_HEIGHT)
    } else {
      context.drawImage(HERO_IMAGE, imageLeft, imageTop, width, HERO_HEIGHT)
    }
    context.restore()

    if (DEBUG) {
      const muzzle = this.getMuzzlePoint(timestamp)
      context.strokeStyle = '#22c55e'
      context.lineWidth = 1
      context.strokeRect(imageLeft, imageTop, width, HERO_HEIGHT)
      context.fillStyle = '#ef4444'
      context.beginPath()
      context.arc(muzzle.x, muzzle.y, 4, 0, Math.PI * 2)
      context.fill()
    }
  }
}

class Bullet {
  constructor(startX, startY, target, targetPart, targetX, targetY) {
    this.x = startX
    this.y = startY
    this.targetPedestrian = target
    this.targetPart = targetPart
    this.targetX = targetX
    this.targetY = targetY
    this.active = true
    this.hitTarget = false
    this.speed = BULLET_SPEED
    const dx = this.targetX - startX
    const dy = this.targetY - startY
    const distance = Math.hypot(dx, dy) || 1
    this.directionX = dx / distance
    this.directionY = dy / distance
  }

  update(delta) {
    const dx = this.targetX - this.x
    const dy = this.targetY - this.y
    const distance = Math.hypot(dx, dy)
    const travel = this.speed * delta

    if (distance <= travel) {
      this.x = this.targetX
      this.y = this.targetY
      this.active = false
      this.hitTarget = true
      return
    }

    this.x += this.directionX * travel
    this.y += this.directionY * travel
  }

  draw(context) {
    context.strokeStyle = '#fb923c'
    context.lineWidth = 3
    context.beginPath()
    context.moveTo(this.x - this.directionX * 10, this.y - this.directionY * 10)
    context.lineTo(this.x, this.y)
    context.stroke()

    context.fillStyle = '#fef08a'
    context.beginPath()
    context.arc(this.x, this.y, 3, 0, Math.PI * 2)
    context.stroke()
    context.fill()
  }
}

class Pedestrian {
  constructor(x, y, speed, villainType = null, villainImage = null) {
    this.x = x
    this.y = y
    this.speed = speed * (villainType ? villainType.speed : 1)
    this.direction = Math.sign(this.speed) || 1
    this.villainType = villainType
    this.villainImage = villainImage
    this.isGoon = Boolean(villainType)
    this.walkPhase = Math.random() * Math.PI * 2
    this.radius = 16
    this.color = PEDESTRIAN_COLORS[Math.floor(Math.random() * PEDESTRIAN_COLORS.length)]
    this.deathKind = null
    this.deathElapsed = 0
    this.remove = false
    this.girlHit = false
  }

  update(delta, targeted) {
    if (this.deathKind) {
      this.deathElapsed += delta
      if (this.deathElapsed >= 0.5) this.remove = true
      return
    }
    if (targeted) return
    this.x += this.speed * delta
    this.walkPhase += delta * 9
  }

  getHitBox(part) {
    if (!this.villainType || !this.villainImage?.naturalWidth) return null
    const ratio = part === 'girl' ? this.villainType.girlBox : this.villainType.villainBox
    if (!ratio) return null

    const height = this.villainType.height
    const width = (this.villainImage.naturalWidth / this.villainImage.naturalHeight) * height
    const ratioX = this.direction < 0 ? 1 - ratio.x - ratio.width : ratio.x
    return {
      x: this.x - width / 2 + ratioX * width,
      y: this.y - height / 2 + ratio.y * height,
      width: ratio.width * width,
      height: ratio.height * height,
    }
  }

  hitTest(x, y, padding = 10) {
    if (this.deathKind) return null

    if (!this.villainType) {
      return (
        x >= this.x - 12 - padding &&
        x <= this.x + 12 + padding &&
        y >= this.y - 25 - padding &&
        y <= this.y + 22 + padding
      ) ? 'civilian' : null
    }

    const contains = (box) => box && (
      x >= box.x - padding &&
      x <= box.x + box.width + padding &&
      y >= box.y - padding &&
      y <= box.y + box.height + padding
    )
    if (this.villainType.hasGirl && !this.girlHit && contains(this.getHitBox('girl'))) {
      return 'girl'
    }
    return contains(this.getHitBox('villain')) ? 'villain' : null
  }

  startDeath() {
    this.deathKind = this.villainType.type
    this.deathElapsed = 0
  }

  drawVillain(context) {
    const image = this.villainImage
    if (!image?.complete || !image.naturalWidth) return

    const height = this.villainType.height
    const width = (image.naturalWidth / image.naturalHeight) * height
    const progress = this.deathKind ? Math.min(1, this.deathElapsed / 0.5) : 0
    const drawX = this.x - (
      this.deathKind === 'bike' ? this.direction * progress * 12 : 0
    )
    const imageTop = this.y - height / 2

    context.save()
    context.globalAlpha = 1 - progress
    if (this.deathKind === 'bike') {
      context.strokeStyle = '#fef3c7'
      context.lineWidth = 2
      context.beginPath()
      context.moveTo(drawX - this.direction * 17, this.y + height * 0.31)
      context.lineTo(drawX - this.direction * 34, this.y + height * 0.31)
      context.moveTo(drawX - this.direction * 13, this.y + height * 0.39)
      context.lineTo(drawX - this.direction * 29, this.y + height * 0.39)
      context.stroke()
    }
    context.translate(drawX, this.y)
    if (this.direction < 0) context.scale(-1, 1)
    if (this.deathKind === 'walker') context.rotate(progress * 0.8)
    context.drawImage(image, -width / 2, -height / 2, width, height)
    context.restore()

    context.save()
    context.globalAlpha = 1 - progress
    context.font = 'bold 11px sans-serif'
    context.textAlign = 'center'
    context.textBaseline = 'bottom'
    context.lineWidth = 3
    context.strokeStyle = '#ffffff'
    context.fillStyle = '#111827'
    context.strokeText(this.villainType.name, drawX, imageTop - 3)
    context.fillText(this.villainType.name, drawX, imageTop - 3)
    context.restore()

    if (DEBUG && !this.deathKind) {
      const villainBox = this.getHitBox('villain')
      if (villainBox) {
        context.strokeStyle = '#22c55e'
        context.lineWidth = 1
        context.strokeRect(villainBox.x, villainBox.y, villainBox.width, villainBox.height)
      }
      if (this.villainType.hasGirl && !this.girlHit) {
        const girlBox = this.getHitBox('girl')
        if (girlBox) {
          context.strokeStyle = '#ef4444'
          context.lineWidth = 1
          context.strokeRect(girlBox.x, girlBox.y, girlBox.width, girlBox.height)
        }
      }
    }
  }

  drawCivilian(context) {
    const legSwing = Math.sin(this.walkPhase) * 5

    context.strokeStyle = '#334155'
    context.lineWidth = 4
    context.lineCap = 'round'
    context.beginPath()
    context.moveTo(this.x - 4, this.y + 8)
    context.lineTo(this.x - 6 + legSwing, this.y + 20)
    context.moveTo(this.x + 4, this.y + 8)
    context.lineTo(this.x + 6 - legSwing, this.y + 20)
    context.stroke()

    context.fillStyle = this.color
    context.fillRect(this.x - 8, this.y - 8, 16, 20)
    context.fillStyle = '#f2c49b'
    context.beginPath()
    context.arc(this.x, this.y - 16, 8, 0, Math.PI * 2)
    context.fill()

    context.fillStyle = '#334155'
    context.beginPath()
    context.arc(this.x - 2, this.y - 17, 1, 0, Math.PI * 2)
    context.arc(this.x + 2, this.y - 17, 1, 0, Math.PI * 2)
    context.fill()
  }

  draw(context) {
    if (this.villainType) {
      this.drawVillain(context)
      return
    }
    this.drawCivilian(context)
  }
}

class HitEffect {
  constructor(x, y, isGoon) {
    this.x = x
    this.y = y
    this.age = 0
    this.duration = 0.28
    this.color = isGoon ? '#f87171' : '#fbbf24'
  }

  update(delta) {
    this.age += delta
  }

  draw(context) {
    const progress = this.age / this.duration
    const radius = 4 + progress * 18

    context.save()
    context.globalAlpha = 1 - progress
    context.strokeStyle = this.color
    context.lineWidth = 3
    context.beginPath()
    context.arc(this.x, this.y, radius, 0, Math.PI * 2)
    context.stroke()

    for (let ray = 0; ray < 6; ray += 1) {
      const angle = (ray * Math.PI) / 3
      context.beginPath()
      context.moveTo(
        this.x + Math.cos(angle) * (radius + 2),
        this.y + Math.sin(angle) * (radius + 2),
      )
      context.lineTo(
        this.x + Math.cos(angle) * (radius + 8),
        this.y + Math.sin(angle) * (radius + 8),
      )
      context.stroke()
    }
    context.restore()
  }
}

function drawMuzzleFlash(context, game, timestamp) {
  const remaining = game.muzzleFlashUntil - timestamp
  if (remaining <= 0) return

  context.save()
  context.globalAlpha = remaining / MUZZLE_FLASH_DURATION
  context.fillStyle = '#fde68a'
  context.beginPath()
  context.arc(game.muzzleFlashX, game.muzzleFlashY, 8, 0, Math.PI * 2)
  context.fill()
  context.restore()
}

function drawScene(context, game, timestamp) {
  context.fillStyle = '#dbeafe'
  context.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT)
  context.fillStyle = '#bbf7d0'
  context.fillRect(0, ROAD_TOP - 34, GAME_WIDTH, 34)
  context.fillStyle = '#cbd5e1'
  context.fillRect(0, ROAD_TOP - 9, GAME_WIDTH, 10)
  context.fillStyle = '#475569'
  context.fillRect(0, ROAD_TOP, GAME_WIDTH, ROAD_BOTTOM - ROAD_TOP)
  context.fillStyle = '#cbd5e1'
  context.fillRect(0, ROAD_BOTTOM, GAME_WIDTH, GAME_HEIGHT - ROAD_BOTTOM)

  context.strokeStyle = '#f8fafc'
  context.lineWidth = 3
  context.setLineDash([22, 18])
  context.beginPath()
  context.moveTo(0, ROAD_TOP + (ROAD_BOTTOM - ROAD_TOP) / 2)
  context.lineTo(GAME_WIDTH, ROAD_TOP + (ROAD_BOTTOM - ROAD_TOP) / 2)
  context.stroke()
  context.setLineDash([])

  for (let index = 0; index < game.pedestrians.length; index += 1) {
    game.pedestrians[index].draw(context)
  }
  for (let index = 0; index < game.effects.length; index += 1) {
    game.effects[index].draw(context)
  }
  game.hero.draw(context, timestamp)

  for (let index = 0; index < game.bullets.length; index += 1) {
    game.bullets[index].draw(context)
  }
  drawMuzzleFlash(context, game, timestamp)
}

function GameCanvas() {
  const canvasRef = useRef(null)
  const gameRef = useRef(null)
  const [runId, setRunId] = useState(0)
  const [score, setScore] = useState(0)
  const [lives, setLives] = useState(3)
  const [seconds, setSeconds] = useState(GAME_DURATION)
  // Changed: restore the user's mute preference on each launch.
  const [muted, setMuted] = useState(
    () => window.localStorage.getItem(MUTE_STORAGE_KEY) === 'true',
  )
  const mutedRef = useRef(muted)

  useEffect(() => {
    mutedRef.current = muted
    window.localStorage.setItem(MUTE_STORAGE_KEY, String(muted))
  }, [muted])

  const toggleMute = () => {
    const nextMuted = !mutedRef.current
    mutedRef.current = nextMuted
    setMuted(nextMuted)
  }

  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d', { alpha: false })
    if (!canvas || !context) return undefined

    const game = {
      hero: new Hero(),
      pedestrians: [],
      effects: [],
      bullets: [],
      score: 0,
      lives: 3,
      startTime: performance.now(),
      lastFrame: performance.now(),
      lastHudUpdate: 0,
      spawnTimer: 0,
      lastAttackAt: -Infinity,
      muzzleFlashUntil: 0,
      muzzleFlashX: 0,
      muzzleFlashY: 0,
      over: false,
    }
    gameRef.current = game
    setScore(0)
    setLives(3)
    setSeconds(GAME_DURATION)

    // Keep the 360x640 game world fixed; DPR only sharpens its backing bitmap.
    const pixelRatio = window.devicePixelRatio || 1
    canvas.width = Math.round(GAME_WIDTH * pixelRatio)
    canvas.height = Math.round(GAME_HEIGHT * pixelRatio)
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)

    let frameId
    const draw = (timestamp) => {
      const delta = Math.min((timestamp - game.lastFrame) / 1000, 0.05)
      game.lastFrame = timestamp
      const elapsed = Math.max(
        0,
        Math.min((timestamp - game.startTime) / 1000, GAME_DURATION),
      )
      const remaining = Math.max(0, Math.ceil(GAME_DURATION - elapsed))
      const difficulty = Math.floor(elapsed / 15)
      context.clearRect(0, 0, GAME_WIDTH, GAME_HEIGHT)
      drawScene(context, game, timestamp)

      if (!game.over) {
        game.spawnTimer += delta
        const spawnInterval = Math.max(0.42, 1.25 - difficulty * 0.2)
        if (game.spawnTimer >= spawnInterval) {
          game.spawnTimer = 0
          const laneHeight = ROAD_BOTTOM - ROAD_TOP
          const y = ROAD_TOP + 24 + Math.random() * (laneHeight - 55)
          const speed = 52 + Math.random() * 42 + difficulty * 18
          const villainTypeIndex = Math.random() < 0.25
            ? Math.floor(Math.random() * VILLAIN_TYPES.length)
            : -1
          const villainType = villainTypeIndex >= 0 ? VILLAIN_TYPES[villainTypeIndex] : null
          const villainImage = villainTypeIndex >= 0 ? VILLAIN_IMAGES[villainTypeIndex] : null
          game.pedestrians.push(new Pedestrian(-24, y, speed, villainType, villainImage))
        }

        for (let index = game.pedestrians.length - 1; index >= 0; index -= 1) {
          const pedestrian = game.pedestrians[index]
          let targeted = false
          for (let bulletIndex = 0; bulletIndex < game.bullets.length; bulletIndex += 1) {
            if (game.bullets[bulletIndex].targetPedestrian === pedestrian) {
              targeted = true
              break
            }
          }
          pedestrian.update(delta, targeted)
          if (pedestrian.remove || (
            !pedestrian.deathKind &&
            pedestrian.x >= GAME_WIDTH + (pedestrian.villainType?.height || 28)
          )) {
            game.pedestrians.splice(index, 1)
          }
        }

        for (let index = game.bullets.length - 1; index >= 0; index -= 1) {
          const bullet = game.bullets[index]
          bullet.update(delta)
          if (bullet.hitTarget) {
            const target = bullet.targetPedestrian
            if (bullet.targetPart === 'villain' && target.villainType) {
              game.score += target.villainType.points
              target.startDeath()
              // Changed: play the impact sound only when a villain is killed.
              playVillainHitSound(mutedRef.current)
            } else {
              game.score -= 15
              game.lives -= 1
              if (bullet.targetPart === 'girl') {
                target.girlHit = true
              } else {
                const targetIndex = game.pedestrians.indexOf(target)
                if (targetIndex >= 0) game.pedestrians.splice(targetIndex, 1)
              }
            }
            game.effects.push(
              new HitEffect(bullet.x, bullet.y, bullet.targetPart === 'villain'),
            )
            bullet.hitTarget = false
          }
          if (!bullet.active) game.bullets.splice(index, 1)
        }

        for (let index = game.effects.length - 1; index >= 0; index -= 1) {
          const effect = game.effects[index]
          effect.update(delta)
          if (effect.age >= effect.duration) game.effects.splice(index, 1)
        }

        if (remaining === 0 || game.lives <= 0) game.over = true
      }

      if (timestamp - game.lastHudUpdate >= 100 || game.over) {
        setScore(game.score)
        setLives(Math.max(0, game.lives))
        setSeconds(remaining)
        game.lastHudUpdate = timestamp
      }

      if (game.over) {
        gameRef.current = game
        return
      }
      frameId = requestAnimationFrame(draw)
    }

    frameId = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(frameId)
      if (gameRef.current === game) gameRef.current = null
    }
  }, [runId])

  const restart = () => {
    setScore(0)
    setLives(3)
    setSeconds(GAME_DURATION)
    setRunId((currentRun) => currentRun + 1)
  }

  const attackAtPointer = (event) => {
    // Changed: the first user gesture unlocks mobile audio without audible output.
    unlockGameAudio()
    const game = gameRef.current
    const now = performance.now()
    if (
      !game ||
      game.over ||
      event.button !== 0 ||
      now - game.lastAttackAt < 300 ||
      !HERO_IMAGE.complete ||
      !HERO_IMAGE.naturalWidth
    ) {
      return
    }

    event.preventDefault()
    const bounds = event.currentTarget.getBoundingClientRect()
    // Convert the scaled phone-screen position back to the fixed game coordinates.
    const x = ((event.clientX - bounds.left) * GAME_WIDTH) / bounds.width
    const y = ((event.clientY - bounds.top) * GAME_HEIGHT) / bounds.height
    let target = null
    let targetPart = null

    for (let index = game.pedestrians.length - 1; index >= 0; index -= 1) {
      const pedestrian = game.pedestrians[index]
      const hitPart = pedestrian.hitTest(x, y)
      if (hitPart) {
        target = pedestrian
        targetPart = hitPart
        break
      }
    }

    if (!target) return

    event.preventDefault()
    game.lastAttackAt = now
    game.hero.facingLeft = target.x < GAME_WIDTH / 2
    game.hero.recoilDirection = game.hero.facingLeft ? 1 : -1
    game.hero.recoilStartedAt = now
    const muzzle = game.hero.getMuzzlePoint(now)
    if (!muzzle) return

    game.bullets.push(new Bullet(muzzle.x, muzzle.y, target, targetPart, x, y))
    game.muzzleFlashX = muzzle.x
    game.muzzleFlashY = muzzle.y
    game.muzzleFlashUntil = now + MUZZLE_FLASH_DURATION
    // Changed: play only after a valid target has spawned its bullet and flash.
    playGunfireSound(muted)
  }

  const gameOver = seconds === 0 || lives === 0

  return (
    <section className="phone-frame" aria-label="Road Hero game">
      <div className="game-screen">
        <div className="game-hud">
          <div className="hud-stat">
            <span className="hud-label">Score</span>
            <strong>{score}</strong>
          </div>
          <div className="hud-stat">
            <span className="hud-label">Lives</span>
            <strong aria-label={`${lives} lives`}>
              {'♥'.repeat(lives)}{'♡'.repeat(3 - lives)}
            </strong>
          </div>
          <div className={`hud-stat ${seconds <= 10 ? 'time-warning' : ''}`}>
            <span className="hud-label">Time</span>
            <strong>{seconds}s</strong>
          </div>
          {/* Changed: persistent mute toggle for gunfire audio. */}
          <button
            type="button"
            className="mute-button"
            onPointerDown={unlockGameAudio}
            onClick={toggleMute}
            aria-label={muted ? 'Unmute sound' : 'Mute sound'}
            aria-pressed={muted}
            title={muted ? 'Unmute sound' : 'Mute sound'}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M11 5 6 9H3v6h3l5 4V5Z" />
              {muted ? (
                <path d="m16 9 5 6m0-6-5 6" />
              ) : (
                <>
                  <path d="M15.5 8.5a5 5 0 0 1 0 7" />
                  <path d="M18 6a9 9 0 0 1 0 12" />
                </>
              )}
            </svg>
          </button>
        </div>

        <canvas
          ref={canvasRef}
          className="game-canvas"
          onPointerDown={attackAtPointer}
          aria-label="Road Hero play area. Tap a character to attack."
          role="img"
        />
        {gameOver && (
          <div className="game-over-panel" role="status">
            <p className="game-over-kicker">Run complete</p>
            <h2>Game over</h2>
            <p className="final-score">Final score: <strong>{score}</strong></p>
            <button type="button" className="restart-button" onClick={restart}>
              Play again
            </button>
          </div>
        )}
      </div>
    </section>
  )
}

export default GameCanvas
