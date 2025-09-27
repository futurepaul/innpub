import {
  type Application,
  Assets,
  Container,
  Graphics,
  Polygon,
  Rectangle,
  Sprite,
  Texture,
  SCALE_MODES,
  type Ticker,
  AnimatedSprite,
} from "pixi.js";
import type { Subscription } from "rxjs";
import { XMLParser } from "fast-xml-parser";
import { getProfilePicture } from "applesauce-core/helpers";

import type {
  FacingDirection,
  GameStore,
  LocalPlayerState,
  PlayerProfileEntry,
  RemotePlayerState,
} from "./state";
import {
  createAvatarDisplay,
  destroyAvatarDisplay,
  type AvatarDisplayInstance,
} from "./avatarAssets";

export type GameInstance = {
  destroy: () => void;
};

type TileLayer = {
  name: string;
  tiles: number[];
};

type CollisionBox = {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

type RoomDefinition = {
  name: string;
  points: Array<{ x: number; y: number }>;
};

type LegacyPlayerState = {
  npub: string;
  x: number;
  y: number;
  facing: FacingDirection;
  rooms?: string[];
  speakingLevel?: number;
};

type AvatarSlot = {
  container: Container;
  placeholder: Sprite;
  instance: AvatarDisplayInstance | null;
  currentUrl: string | null;
  requestId: number;
  glow: Graphics;
};

type TilesetInfo = {
  firstGid: number;
  columns: number;
  tileWidth: number;
  tileHeight: number;
  imageSource: string;
  imageUrl: string;
};

type TiledMap = {
  width: number;
  height: number;
  tileWidth: number;
  tileHeight: number;
  layers: TileLayer[];
  collisions: CollisionBox[];
  rooms: RoomDefinition[];
  tileset: TilesetInfo;
};

type RawLayer = {
  name: string;
  width: number;
  height: number;
  data?: {
    "#text"?: string;
    encoding?: string;
  };
};

type RawTilesetRef = {
  firstgid: number;
  source: string;
};

type RawObjectGroup = {
  name?: string;
  object?: RawObject | RawObject[];
};

type RawPolygon = {
  points?: string;
};

type RawObject = {
  id?: number;
  name?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  polygon?: RawPolygon;
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  allowBooleanAttributes: true,
  parseAttributeValue: true,
});

const WHITE_TEXTURE = Texture.WHITE;

export async function initGame(app: Application, store: GameStore): Promise<GameInstance> {
  const mapUrl = new URL("/map/innpub-interior.tmx", window.location.origin).href;
  const map = await loadTiledMap(mapUrl);

  const scene = new Container();
  scene.eventMode = "none";
  app.stage.addChild(scene);

  const mapPixelWidth = map.width * map.tileWidth;
  const mapPixelHeight = map.height * map.tileHeight;

  const subscriptions: Subscription[] = [];
  let currentLocalNpub: string | null = store.getSnapshot().localPlayer?.npub ?? null;
  let localAvatarOverride: string | null | undefined = store.getSnapshot().localPlayer?.avatarUrl ?? null;
  let localResolvedAvatar: string | null = null;
  let profileSnapshot: ReadonlyMap<string, PlayerProfileEntry> = store.getSnapshot().profiles;

  const toLegacyState = (player: RemotePlayerState | LocalPlayerState): LegacyPlayerState => ({
    npub: player.npub,
    x: player.position.x,
    y: player.position.y,
    facing: player.facing,
    rooms: player.rooms,
    speakingLevel: player.speakingLevel,
  });

  let tilesheetTexture: Texture | undefined;
  try {
    tilesheetTexture = await Assets.load<Texture>(map.tileset.imageUrl);
    tilesheetTexture.source.style.scaleMode = SCALE_MODES.NEAREST;
  } catch (error) {
    console.warn("Falling back to debug colours; failed to load tileset image", error);
  }

  const tileTextureCache = new Map<number, Texture>();
  const getTileTexture = (gid: number): Texture => {
    if (!tilesheetTexture) {
      return WHITE_TEXTURE;
    }

    const existing = tileTextureCache.get(gid);
    if (existing) {
      return existing;
    }

    const localId = gid - map.tileset.firstGid;
    if (localId < 0) {
      return WHITE_TEXTURE;
    }

    const columns = map.tileset.columns || Math.max(1, Math.floor(tilesheetTexture.width / map.tileset.tileWidth));
    const xIndex = localId % columns;
    const yIndex = Math.floor(localId / columns);

    const frame = new Rectangle(
      xIndex * map.tileset.tileWidth,
      yIndex * map.tileset.tileHeight,
      map.tileset.tileWidth,
      map.tileset.tileHeight,
    );

    const subTexture = new Texture({
      source: tilesheetTexture.source,
      frame,
    });
    subTexture.label = `tile-${gid}`;

    tileTextureCache.set(gid, subTexture);
    return subTexture;
  };

  const hashTint = (gid: number) => {
    const seed = (gid * 2654435761) >>> 0;
    const r = 0x40 + (seed & 0x3f);
    const g = 0x40 + ((seed >> 6) & 0x3f);
    const b = 0x40 + ((seed >> 12) & 0x3f);
    return (r << 16) | (g << 8) | b;
  };

  const isForegroundLayer = (name: string) => /foreground/i.test(name.trim());

  const createTileLayer = (layer: TileLayer) => {
    const layerContainer = new Container();
    layerContainer.eventMode = "none";
    layerContainer.label = layer.name;

    layer.tiles.forEach((gid, index) => {
      if (!gid) {
        return;
      }

      const column = index % map.width;
      const row = Math.floor(index / map.width);

      const sprite = new Sprite(getTileTexture(gid));
      sprite.eventMode = "none";
      sprite.roundPixels = true;
      sprite.x = column * map.tileWidth;
      sprite.y = row * map.tileHeight;

      if (!tilesheetTexture) {
        sprite.width = map.tileWidth;
        sprite.height = map.tileHeight;
        sprite.tint = hashTint(gid);
      }

      layerContainer.addChild(sprite);
    });

    return layerContainer;
  };

  const backgroundLayers = map.layers.filter(layer => !isForegroundLayer(layer.name));
  const foregroundLayers = map.layers.filter(layer => isForegroundLayer(layer.name));

  for (const layer of backgroundLayers) {
    scene.addChild(createTileLayer(layer));
  }

  const bodySpriteUrl = new URL("/assets/walkstrich.png", window.location.origin).href;
  let bodySheetTexture: Texture | undefined;
  const walkTextures: Texture[] = [];

  try {
    bodySheetTexture = await Assets.load<Texture>(bodySpriteUrl);
    bodySheetTexture.source.style.scaleMode = SCALE_MODES.NEAREST;

    const baseSource = bodySheetTexture.source;
    const frameWidth = map.tileWidth;
    const frameHeight = map.tileHeight;

    for (let col = 0; col < 4; col += 1) {
      const walkFrame = new Texture({
        source: baseSource,
        frame: new Rectangle(col * frameWidth, frameHeight, frameWidth, frameHeight),
      });
      walkTextures.push(walkFrame);
    }
  } catch (error) {
    console.warn("Failed to load walk sprite sheet", error);
  }

  const collisionRects = map.collisions
    .filter(collision => collision.width > 0 && collision.height > 0)
    .map(collision => new Rectangle(collision.x, collision.y, collision.width, collision.height));

  const playerWidth = map.tileWidth;
  const playerHeight = map.tileHeight * 2;

  const setAvatarOffset = (slot: AvatarSlot, facing: FacingDirection) => {
    const offset = facing === 0 ? -8 : facing === 1 ? 8 : 0;
    slot.container.x = playerWidth / 2 + offset;
  };

  const createPlayerContainer = () => {
    const container = new Container();
    container.eventMode = "none";
    container.label = "player";

    const headContainer = new Container();
    headContainer.eventMode = "none";
    headContainer.label = "avatar";
    headContainer.x = playerWidth / 2;

    const glow = new Graphics();
    glow.eventMode = "none";
    glow.circle(0, map.tileHeight / 2, map.tileHeight / 2 + 6);
    glow.fill({ color: 0xfde68a, alpha: 0.65 });
    glow.alpha = 0;
    glow.visible = true;

    const placeholder = new Sprite(WHITE_TEXTURE);
    placeholder.width = playerWidth;
    placeholder.height = map.tileHeight;
    placeholder.roundPixels = true;
    placeholder.tint = 0xe5e7eb;
    placeholder.anchor.set(0.5, 0);
    placeholder.x = 0;
    placeholder.y = 0;
    placeholder.eventMode = "none";
    headContainer.addChild(glow, placeholder);

    const headSlot: AvatarSlot = {
      container: headContainer,
      placeholder,
      instance: null,
      currentUrl: null,
      requestId: 0,
      glow,
    };

    const body = new AnimatedSprite(walkTextures.length > 0 ? walkTextures : [WHITE_TEXTURE]);
    body.width = playerWidth;
    body.height = map.tileHeight;
    body.y = map.tileHeight;
    body.roundPixels = true;
    body.animationSpeed = 0.18;
    body.loop = true;
    body.anchor.set(0.5, 0);
    body.x = playerWidth / 2;
    body.scale.x = 1;
    if (walkTextures.length > 0) {
      body.gotoAndStop(0);
      body.stop();
    } else {
      body.tint = 0x6ee7b7;
    }

    container.addChild(headContainer, body);

    return { container, headSlot, body };
  };

  const { container: player, headSlot: localHeadSlot, body: bodySprite } = createPlayerContainer();
  setAvatarOffset(localHeadSlot, 1);

  const spawnX = Math.round(mapPixelWidth / 2 - playerWidth * 1.5);
  const spawnY = Math.round(mapPixelHeight / 2 - playerHeight);
  player.x = spawnX;
  player.y = spawnY;
  scene.addChild(player);

  type ManagedPlayer = {
    container: Container;
    headSlot: AvatarSlot;
    body: AnimatedSprite;
    lastState?: LegacyPlayerState;
    lastFacing: FacingDirection;
    lastHorizontal: number;
    avatarUrl: string | null;
  };

  const remotePlayers = new Map<string, ManagedPlayer>();

  const fallbackAvatarUrl = (npub: string) => `https://robohash.org/${npub}.png`;

  const clearAvatarSlot = (slot: AvatarSlot) => {
    if (slot.instance) {
      slot.container.removeChild(slot.instance.display);
      destroyAvatarDisplay(slot.instance);
      slot.instance = null;
    }
    slot.currentUrl = null;
    slot.placeholder.visible = true;
    slot.glow.alpha = 0;
  };

  const setAvatarOnSlot = (slot: AvatarSlot, url: string | null) => {
    const normalized = url?.trim() || null;
    if (slot.currentUrl === normalized) {
      return;
    }

    slot.requestId += 1;
    const requestId = slot.requestId;

    if (!normalized) {
      clearAvatarSlot(slot);
      return;
    }

    const load = async () => {
      try {
        const avatar = await createAvatarDisplay(normalized);
        if (requestId !== slot.requestId) {
          destroyAvatarDisplay(avatar);
          return;
        }

        if (slot.instance) {
          slot.container.removeChild(slot.instance.display);
          destroyAvatarDisplay(slot.instance);
        }

        avatar.display.width = slot.placeholder.width;
        avatar.display.height = slot.placeholder.height;
        avatar.display.position.set(0, 0);
        slot.container.addChild(avatar.display);
        slot.instance = avatar;
        slot.currentUrl = normalized;
        slot.placeholder.visible = false;
      } catch (error) {
        if (requestId === slot.requestId) {
          console.warn("Failed to load avatar sprite", normalized, error);
          clearAvatarSlot(slot);
        }
      }
    };

    void load();
  };

  const resolveProfileAvatarUrl = (npub: string): string => {
    const profile = profileSnapshot.get(npub)?.profile;
    const picture = profile ? getProfilePicture(profile) : undefined;
    return picture?.trim() || fallbackAvatarUrl(npub);
  };

  const resolveLocalAvatarUrl = (): string | null => {
    if (!currentLocalNpub) {
      return null;
    }

    const override = localAvatarOverride?.trim();
    if (override) {
      return override;
    }

    const profile = profileSnapshot.get(currentLocalNpub)?.profile;
    const picture = profile ? getProfilePicture(profile) : undefined;
    return (picture?.trim() || fallbackAvatarUrl(currentLocalNpub));
  };

  const applyRemoteAvatar = (npub: string, managed: ManagedPlayer) => {
    const resolved = resolveProfileAvatarUrl(npub);
    if (managed.avatarUrl === resolved) {
      return;
    }
    managed.avatarUrl = resolved;
    setAvatarOnSlot(managed.headSlot, resolved);
  };

  const setSpeakingGlow = (slot: AvatarSlot, level: number) => {
    const intensity = level > 0.05 ? Math.min(1, level * 2) : 0;
    slot.glow.alpha = intensity;
  };

  const getOrCreateRemote = (state: LegacyPlayerState): ManagedPlayer => {
    let managed = remotePlayers.get(state.npub);
    if (!managed) {
      const { container, headSlot, body } = createPlayerContainer();
      container.x = state.x;
      container.y = state.y;
      managed = {
        container,
        headSlot,
        body,
        lastFacing: state.facing,
        lastHorizontal: state.facing === 0 ? -1 : 1,
        avatarUrl: null,
      };
      remotePlayers.set(state.npub, managed);
      scene.addChild(container);
      applyRemoteAvatar(state.npub, managed);
      setAvatarOffset(managed.headSlot, state.facing);
    }
    return managed;
  };

  const updateRemotePlayer = (managed: ManagedPlayer, state: LegacyPlayerState) => {
    const prev = managed.lastState;
    const dx = prev ? state.x - prev.x : 0;
    const dy = prev ? state.y - prev.y : 0;
    const moving = Math.abs(dx) > 0.1 || Math.abs(dy) > 0.1;

    managed.container.x = state.x;
    managed.container.y = state.y;

    let horizontal = managed.lastHorizontal ?? 1;
    if (state.facing === 0) {
      horizontal = -1;
    } else if (state.facing === 1) {
      horizontal = 1;
    }

    managed.body.scale.x = horizontal;
    managed.lastHorizontal = horizontal;
    managed.lastFacing = state.facing;

    if (moving && walkTextures.length > 0) {
      if (!managed.body.playing) {
        managed.body.textures = walkTextures;
        managed.body.animationSpeed = 0.18;
        managed.body.play();
      }
    } else if (managed.body.playing) {
      managed.body.stop();
    }

    setSpeakingGlow(managed.headSlot, state.speakingLevel ?? 0);

    setAvatarOffset(managed.headSlot, state.facing);

    managed.lastState = state;
    emitHeadPositionFor(state.npub, managed.headSlot.container, state.facing);
  };

  for (const layer of foregroundLayers) {
    scene.addChild(createTileLayer(layer));
  }

  const roomPolygons = map.rooms.map(room => {
    const points = room.points.flatMap(point => [point.x, point.y]);
    return {
      name: room.name,
      polygon: new Polygon(points),
    };
  });

  const footBounds = new Rectangle();
  const footHeight = map.tileHeight;
  const headHeight = playerHeight - footHeight;

  const snapPlayerPosition = () => {
    player.x = Math.round(player.x);
    player.y = Math.round(player.y);
  };

  type Direction = "up" | "down" | "left" | "right";
  const pressed = new Set<Direction>();
  let inputCaptured = store.getSnapshot().settings.inputCaptured;
  let isWalking = false;
  let lastFacing: FacingDirection = 1;
  let lastHorizontalDirection = 1;

  const normaliseKey = (key: string): Direction | null => {
    switch (key) {
      case "ArrowUp":
      case "w":
      case "W":
        return "up";
      case "ArrowDown":
      case "s":
      case "S":
        return "down";
      case "ArrowLeft":
      case "a":
      case "A":
        return "left";
      case "ArrowRight":
      case "d":
      case "D":
        return "right";
      default:
        return null;
    }
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (inputCaptured) {
      return;
    }
    const mapped = normaliseKey(event.key);
    if (!mapped) {
      return;
    }

    pressed.add(mapped);
    event.preventDefault();
  };

  const handleKeyUp = (event: KeyboardEvent) => {
    if (inputCaptured) {
      return;
    }

    const mapped = normaliseKey(event.key);
    if (!mapped) {
      return;
    }

    pressed.delete(mapped);
    event.preventDefault();
  };

  window.addEventListener("keydown", handleKeyDown, { passive: false });
  window.addEventListener("keyup", handleKeyUp, { passive: false });

  const clampToMap = () => {
    const maxX = mapPixelWidth - playerWidth;
    const maxY = mapPixelHeight - playerHeight;
    const minY = -headHeight;

    player.x = Math.min(Math.max(player.x, 0), Math.max(0, maxX));
    player.y = Math.min(Math.max(player.y, minY), Math.max(minY, maxY));
    snapPlayerPosition();
  };

  const updateFootBounds = () => {
    footBounds.x = player.x;
    footBounds.y = player.y + headHeight;
    footBounds.width = playerWidth;
    footBounds.height = footHeight;
  };

  let lastReportedTransform: { x: number; y: number; facing: FacingDirection } | null = null;

  const reportPosition = (force = false) => {
    if (!currentLocalNpub) {
      lastReportedTransform = null;
      return;
    }

    const next = {
      x: Math.round(player.x * 1000) / 1000,
      y: Math.round(player.y * 1000) / 1000,
      facing: lastFacing,
    } as const;

    const changed =
      !lastReportedTransform ||
      force ||
      lastReportedTransform.x !== next.x ||
      lastReportedTransform.y !== next.y ||
      lastReportedTransform.facing !== next.facing;

    if (!changed) {
      return;
    }

    lastReportedTransform = { ...next };

    store.dispatch({
      type: "set-local-transform",
      transform: {
        position: { x: next.x, y: next.y },
        facing: next.facing,
      },
    });
  };

  let activeRooms = new Set<string>();
  const updateRooms = () => {
    if (roomPolygons.length === 0) {
      return;
    }

    const centerX = footBounds.x + footBounds.width / 2;
    const centerY = footBounds.y + footBounds.height / 2;

    const nextRooms = new Set<string>();
    for (const room of roomPolygons) {
      if (room.polygon.contains(centerX, centerY)) {
        nextRooms.add(room.name);
      }
    }

    const roomsChanged = !setsEqual(activeRooms, nextRooms);
    for (const roomName of nextRooms) {
      if (!activeRooms.has(roomName)) {
        store.logInfo(`Entered ${roomName}`);
      }
    }

    for (const roomName of activeRooms) {
      if (!nextRooms.has(roomName)) {
        store.logInfo(`Exited ${roomName}`);
      }
    }

    activeRooms = nextRooms;
    if (roomsChanged && currentLocalNpub) {
      store.dispatch({
        type: "set-local-rooms",
        rooms: Array.from(nextRooms).sort(),
      });
    }
  };

  clampToMap();
  updateFootBounds();
  updateRooms();
  reportPosition(true);

  const moveAxis = (delta: number, axis: "x" | "y") => {
    if (delta === 0) {
      return;
    }

    if (axis === "x") {
      player.x += delta;
    } else {
      player.y += delta;
    }

    clampToMap();
    updateFootBounds();

    for (const rect of collisionRects) {
      if (!intersects(footBounds, rect)) {
        continue;
      }

      if (axis === "x") {
        player.x = delta > 0 ? rect.x - playerWidth : rect.x + rect.width;
      } else if (delta > 0) {
        player.y = rect.y - playerHeight;
      } else {
        player.y = rect.y + rect.height - headHeight;
      }

      clampToMap();
      updateFootBounds();
    }
  };

  const speed = 120;

  const updateSceneTransform = () => {
    if (!app.renderer) {
      return;
    }

    const pixelsPerTileX = Math.max(1, Math.floor(app.renderer.width / map.width));
    const pixelsPerTileY = Math.max(1, Math.floor(app.renderer.height / map.height));
    const pixelsPerTile = Math.max(1, Math.min(pixelsPerTileX, pixelsPerTileY));

    const scale = pixelsPerTile / map.tileWidth;
    scene.scale.set(scale);

    const scaledWidth = mapPixelWidth * scale;
    const scaledHeight = mapPixelHeight * scale;
    const offsetX = Math.round((app.renderer.width - scaledWidth) / 2);
    const offsetY = Math.round((app.renderer.height - scaledHeight) / 2);
    scene.position.set(offsetX, offsetY);
  };

  const emitHeadPositionFor = (
    id: string,
    target: Container,
    facingDir: FacingDirection,
  ) => {
    if (!app.renderer) {
      return;
    }

    const identity = id === "local" ? currentLocalNpub : id;
    if (!identity) {
      return;
    }

    const bounds = target.getBounds();
    const canvas = app.renderer.canvas as HTMLCanvasElement;
    const cssScaleX = (canvas.clientWidth || canvas.width) / canvas.width;
    const cssScaleY = (canvas.clientHeight || canvas.height) / canvas.height;
    const headOffset = facingDir === 0 ? -8 : facingDir === 1 ? 8 : 0;

    store.updateHeadBounds(identity, {
      rect: {
        x: (bounds.x + headOffset) * cssScaleX,
        y: bounds.y * cssScaleY,
        width: bounds.width * cssScaleX,
        height: bounds.height * cssScaleY,
      },
      facing: facingDir,
    });
  };

  const emitHeadPosition = () => {
    emitHeadPositionFor("local", localHeadSlot.container, lastFacing);
  };

  const syncPlayers = (states: LegacyPlayerState[]) => {
    const seen = new Set<string>();

    for (const state of states) {
      const managed = getOrCreateRemote(state);
      updateRemotePlayer(managed, state);
      applyRemoteAvatar(state.npub, managed);
      seen.add(state.npub);
    }

    for (const [npub, managed] of remotePlayers) {
      if (!seen.has(npub)) {
        store.updateHeadBounds(npub, null);
        clearAvatarSlot(managed.headSlot);
        managed.container.destroy({ children: true });
        remotePlayers.delete(npub);
      }
    }
  };

  const tickerFn = (ticker: Ticker) => {
    const horizontal = Number(pressed.has("right")) - Number(pressed.has("left"));
    const vertical = Number(pressed.has("down")) - Number(pressed.has("up"));

    let dx = horizontal;
    let dy = vertical;

    if (dx !== 0 || dy !== 0) {
      const length = Math.hypot(dx, dy) || 1;
      dx /= length;
      dy /= length;
    }

    const deltaSeconds = ticker.deltaMS / 1000;
    moveAxis(dx * speed * deltaSeconds, "x");
    moveAxis(dy * speed * deltaSeconds, "y");

    const moving = dx !== 0 || dy !== 0;

    if (moving) {
      const absDx = Math.abs(dx);
      const absDy = Math.abs(dy);

      if (absDx >= absDy) {
        lastHorizontalDirection = dx >= 0 ? 1 : -1;
        lastFacing = dx >= 0 ? 1 : 0;
      } else {
        lastFacing = dy >= 0 ? 3 : 2;
      }
    }

    bodySprite.scale.x = lastFacing === 0 ? -1 : lastFacing === 1 ? 1 : lastHorizontalDirection;
    setAvatarOffset(localHeadSlot, lastFacing);

    if (moving && walkTextures.length > 0) {
      if (!isWalking || !bodySprite.playing) {
        bodySprite.textures = walkTextures;
        bodySprite.animationSpeed = 0.18;
        bodySprite.play();
      }
      isWalking = true;
    } else {
      if (bodySprite.playing) {
        bodySprite.stop();
      }
      isWalking = false;
    }

    updateSceneTransform();
    updateRooms();
    reportPosition();
    emitHeadPosition();
  };

  updateSceneTransform();
  emitHeadPosition();
  app.ticker.add(tickerFn);

  const updateLocalAvatar = (override?: string | null) => {
    localAvatarOverride = override ?? null;
    const resolved = resolveLocalAvatarUrl();
    localResolvedAvatar = resolved;
    setAvatarOnSlot(localHeadSlot, resolved);
  };

  const destroy = () => {
    window.removeEventListener("keydown", handleKeyDown);
    window.removeEventListener("keyup", handleKeyUp);
    app.ticker.remove(tickerFn);
    scene.destroy({ children: true });

    for (const texture of tileTextureCache.values()) {
      texture.destroy();
    }
    tileTextureCache.clear();

    if (tilesheetTexture) {
      void Assets.unload(map.tileset.imageUrl);
    }
    if (bodySheetTexture) {
      void Assets.unload(bodySpriteUrl);
      for (const texture of walkTextures) {
        texture.destroy();
      }
    }
    pressed.clear();
    for (const [npub, managed] of remotePlayers) {
      store.updateHeadBounds(npub, null);
      clearAvatarSlot(managed.headSlot);
      managed.container.destroy({ children: true });
    }
    remotePlayers.clear();

    clearAvatarSlot(localHeadSlot);

    if (currentLocalNpub) {
      store.updateHeadBounds(currentLocalNpub, null);
    }
    store.dispatch({ type: "set-local-rooms", rooms: [] });

    for (const subscription of subscriptions) {
      subscription.unsubscribe();
    }
    subscriptions.length = 0;
    currentLocalNpub = null;
  };

  const spawnPlayer = () => {
    player.x = spawnX;
    player.y = spawnY;
    clampToMap();
    updateFootBounds();
    updateRooms();
    reportPosition(true);
    emitHeadPosition();
  };

  const remotePlayersSubscription = store.remotePlayers$.subscribe(remoteMap => {
    const states = Array.from(remoteMap.values(), toLegacyState);
    syncPlayers(states);
  });
  subscriptions.push(remotePlayersSubscription);

  const localPlayerSubscription = store.localPlayer$.subscribe(playerState => {
    const previousNpub = currentLocalNpub;
    currentLocalNpub = playerState?.npub ?? null;
    const avatarOverride = playerState?.avatarUrl ?? null;
    const identityChanged = currentLocalNpub !== previousNpub;

    if (identityChanged || avatarOverride !== localAvatarOverride) {
      updateLocalAvatar(avatarOverride);
    }

    setSpeakingGlow(localHeadSlot, playerState?.speakingLevel ?? 0);
    if (playerState) {
      setAvatarOffset(localHeadSlot, playerState.facing);
    }

    if (!playerState && previousNpub) {
      store.updateHeadBounds(previousNpub, null);
    }
  });
  subscriptions.push(localPlayerSubscription);

  const profileSubscription = store.profiles$.subscribe(profiles => {
    profileSnapshot = profiles;

    const resolved = resolveLocalAvatarUrl();
    if (resolved !== localResolvedAvatar) {
      localResolvedAvatar = resolved;
      setAvatarOnSlot(localHeadSlot, resolved);
    }

    for (const [npub, managed] of remotePlayers) {
      applyRemoteAvatar(npub, managed);
    }
  });
  subscriptions.push(profileSubscription);

  const settingsSubscription = store.settings$.subscribe(settings => {
    if (inputCaptured === settings.inputCaptured) {
      return;
    }
    inputCaptured = settings.inputCaptured;
    if (inputCaptured) {
      pressed.clear();
    }
  });
  subscriptions.push(settingsSubscription);

  const commandSubscription = store.commands$.subscribe(command => {
    switch (command.type) {
      case "login":
        currentLocalNpub = command.npub;
        reportPosition(true);
        updateRooms();
        break;
      case "logout":
        currentLocalNpub = null;
        pressed.clear();
        reportPosition(true);
        break;
      case "request-spawn":
        spawnPlayer();
        break;
      default:
        break;
    }
  });
  subscriptions.push(commandSubscription);

  // Initial sync with store state
  const snapshot = store.getSnapshot();
  syncPlayers(Array.from(snapshot.remotePlayers.values(), toLegacyState));
  if (snapshot.localPlayer) {
    updateLocalAvatar(snapshot.localPlayer.avatarUrl ?? null);
  } else {
    updateLocalAvatar(null);
  }

  return {
    destroy,
  };
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const value of a) {
    if (!b.has(value)) {
      return false;
    }
  }
  return true;
}

async function loadTiledMap(url: string): Promise<TiledMap> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new Error(`Failed to request TMX map at ${url}: ${(error as Error).message}`);
  }

  if (!response.ok) {
    throw new Error(`Failed to load TMX map at ${url}: ${response.status} ${response.statusText}`);
  }

  const xml = await response.text();
  const parsed = parser.parse(xml) as any;
  const mapNode = parsed.map;

  if (!mapNode) {
    throw new Error("TMX file is missing <map> root node");
  }

  const width = Number(mapNode.width ?? 0);
  const height = Number(mapNode.height ?? 0);
  const tileWidth = Number(mapNode.tilewidth ?? 0);
  const tileHeight = Number(mapNode.tileheight ?? 0);

  if (!width || !height || !tileWidth || !tileHeight) {
    throw new Error("TMX map has invalid dimensions");
  }

  const layers = normaliseArray<RawLayer>(mapNode.layer).filter(
    layer => typeof layer?.data?.["#text"] === "string",
  );

  const parsedLayers: TileLayer[] = layers.map(layer => {
    const csv = (layer.data?.["#text"] ?? "").trim();
    const tiles = csv
      .split(/\s*,\s*/)
      .map(value => Number.parseInt(value, 10))
      .filter(value => Number.isFinite(value));

    return {
      name: layer.name,
      tiles,
    };
  });

  const objectGroups = normaliseArray<RawObjectGroup>(mapNode.objectgroup);

  const collisionGroup = objectGroups.find(group => (group?.name ?? "").toLowerCase() === "collision");

  const collisions: CollisionBox[] = normaliseArray<RawObject>(collisionGroup?.object)
    .map(obj => ({
      id: Number(obj?.id ?? 0),
      x: Number(obj?.x ?? 0),
      y: Number(obj?.y ?? 0),
      width: Number(obj?.width ?? 0),
      height: Number(obj?.height ?? 0),
    }))
    .filter(obj => obj.width > 0 && obj.height > 0);

  const rooms: RoomDefinition[] = [];
  const collectRoom = (obj: RawObject | undefined) => {
    if (!obj || !obj.polygon?.points) {
      return;
    }

    const name = obj.name ?? "room";
    const offsetX = Number(obj.x ?? 0);
    const offsetY = Number(obj.y ?? 0);

    const parsedPoints: Array<{ x: number; y: number }> = [];
    const rawPoints = obj.polygon.points.trim().split(/\s+/);

    for (const pair of rawPoints) {
      const [rawX, rawY] = pair.split(",");
      const px = Number(rawX);
      const py = Number(rawY);
      if (!Number.isFinite(px) || !Number.isFinite(py)) {
        continue;
      }
      parsedPoints.push({ x: offsetX + px, y: offsetY + py });
    }

    if (parsedPoints.length >= 3) {
      rooms.push({ name, points: parsedPoints });
    }
  };

  for (const group of objectGroups) {
    const groupName = (group?.name ?? "").toLowerCase();
    if (groupName === "rooms") {
      for (const obj of normaliseArray<RawObject>(group.object)) {
        collectRoom(obj);
      }
    } else if (groupName === "collision") {
      for (const obj of normaliseArray<RawObject>(group.object)) {
        if ((obj.name ?? "").toLowerCase().startsWith("room")) {
          collectRoom(obj);
        }
      }
    }
  }

  const tilesetRef = normaliseArray<RawTilesetRef>(mapNode.tileset)[0];
  if (!tilesetRef) {
    throw new Error("TMX map does not declare a tileset");
  }

  const tilesetUrl = new URL(tilesetRef.source, url);
  let tilesetResponse: Response;
  try {
    tilesetResponse = await fetch(tilesetUrl);
  } catch (error) {
    throw new Error(`Failed to request TSX tileset at ${tilesetUrl}: ${(error as Error).message}`);
  }

  if (!tilesetResponse.ok) {
    throw new Error(`Failed to load TSX tileset at ${tilesetUrl}: ${tilesetResponse.status} ${tilesetResponse.statusText}`);
  }

  const tilesetXml = await tilesetResponse.text();
  const tilesetParsed = parser.parse(tilesetXml) as any;
  const tilesetNode = tilesetParsed.tileset;

  const imageNode = tilesetNode?.image;
  if (!imageNode?.source) {
    throw new Error("Tileset is missing image source");
  }

  const imageSource: string = imageNode.source;
  let imageUrl: string;
  try {
    imageUrl = new URL(imageSource, tilesetUrl).href;
  } catch (error) {
    console.warn("Could not resolve tileset image path, defaulting to data URL placeholder", error);
    imageUrl = createWhitePixelDataUrl();
  }

  return {
    width,
    height,
    tileWidth,
    tileHeight,
    layers: parsedLayers,
    collisions,
    rooms,
    tileset: {
      firstGid: Number(tilesetRef.firstgid ?? 1),
      columns: Number(tilesetNode.columns ?? 0),
      tileWidth: Number(tilesetNode.tilewidth ?? tileWidth),
      tileHeight: Number(tilesetNode.tileheight ?? tileHeight),
      imageSource,
      imageUrl,
    },
  };
}

function normaliseArray<T>(value: T | T[] | undefined): T[] {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function intersects(a: Rectangle, b: Rectangle) {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

function createWhitePixelDataUrl() {
  return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP8/5+hHgAHggJ/lSYcnwAAAABJRU5ErkJggg==";
}
