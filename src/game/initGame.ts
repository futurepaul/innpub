import {
  type Application,
  Assets,
  Container,
  Polygon,
  Rectangle,
  Sprite,
  Texture,
  SCALE_MODES,
  type Ticker,
  AnimatedSprite,
} from "pixi.js";
import type { FacingDirection, PlayerState } from "../multiplayer/stream";
import { XMLParser } from "fast-xml-parser";

export type GameHooks = {
  onPlayerPosition?: (position: { x: number; y: number; facing: FacingDirection }) => void;
  onConsoleMessage?: (message: string) => void;
  onHeadPosition?: (id: string, rect: { x: number; y: number; width: number; height: number } | null, facing: FacingDirection) => void;
};

export type GameInstance = {
  destroy: () => void;
  setInputCaptured: (captured: boolean) => void;
  spawn: () => void;
  setAvatar: (url?: string | null) => void;
  syncPlayers: (players: PlayerState[]) => void;
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

export async function initGame(app: Application, hooks: GameHooks = {}): Promise<GameInstance> {
  const mapUrl = new URL("/map/innpub-interior.tmx", window.location.origin).href;
  const map = await loadTiledMap(mapUrl);

  const scene = new Container();
  scene.eventMode = "none";
  app.stage.addChild(scene);

  const mapPixelWidth = map.width * map.tileWidth;
  const mapPixelHeight = map.height * map.tileHeight;

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

  const createPlayerContainer = () => {
    const container = new Container();
    container.eventMode = "none";
    container.label = "player";

    const head = new Sprite(WHITE_TEXTURE);
    head.width = playerWidth;
    head.height = map.tileHeight;
    head.roundPixels = true;
    head.tint = 0xffffff;
    head.anchor.set(0.5, 0);
    head.x = playerWidth / 2;

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

    container.addChild(head, body);

    return { container, head, body };
  };

  const { container: player, head: headSprite, body: bodySprite } = createPlayerContainer();

  const spawnX = Math.round(mapPixelWidth / 2 - playerWidth * 1.5);
  const spawnY = Math.round(mapPixelHeight / 2 - playerHeight);
  player.x = spawnX;
  player.y = spawnY;
  scene.addChild(player);

  type ManagedPlayer = {
    container: Container;
    head: Sprite;
    body: AnimatedSprite;
    lastState?: PlayerState;
    lastFacing: FacingDirection;
    lastHorizontal: number;
  };

  const remotePlayers = new Map<string, ManagedPlayer>();

  const getOrCreateRemote = (state: PlayerState): ManagedPlayer => {
    let managed = remotePlayers.get(state.npub);
    if (!managed) {
      const { container, head, body } = createPlayerContainer();
      container.x = state.x;
      container.y = state.y;
      managed = {
        container,
        head,
        body,
        lastFacing: state.facing,
        lastHorizontal: state.facing === 0 ? -1 : 1,
      };
      remotePlayers.set(state.npub, managed);
      scene.addChild(container);
    }
    return managed;
  };

  const updateRemotePlayer = (managed: ManagedPlayer, state: PlayerState) => {
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

    managed.lastState = state;
    emitHeadPositionFor(state.npub, managed.head, state.facing);
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
  let inputCaptured = false;
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

  const reportPosition = () => {
    hooks.onPlayerPosition?.({
      x: player.x,
      y: player.y,
      facing: lastFacing,
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

    for (const roomName of nextRooms) {
      if (!activeRooms.has(roomName)) {
        hooks.onConsoleMessage?.(`Entered ${roomName}`);
      }
    }

    for (const roomName of activeRooms) {
      if (!nextRooms.has(roomName)) {
        hooks.onConsoleMessage?.(`Exited ${roomName}`);
      }
    }

    activeRooms = nextRooms;
  };

  clampToMap();
  updateFootBounds();
  updateRooms();
  reportPosition();

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
    target: Sprite,
    facingDir: FacingDirection,
  ) => {
    if (!hooks.onHeadPosition || !app.renderer) {
      return;
    }

    const bounds = target.getBounds();
    const canvas = app.renderer.canvas as HTMLCanvasElement;
    const cssScaleX = (canvas.clientWidth || canvas.width) / canvas.width;
    const cssScaleY = (canvas.clientHeight || canvas.height) / canvas.height;
    const headOffset = facingDir === 0 ? -8 : facingDir === 1 ? 8 : 0;

    hooks.onHeadPosition(id, {
      x: (bounds.x + headOffset) * cssScaleX,
      y: bounds.y * cssScaleY,
      width: bounds.width * cssScaleX,
      height: bounds.height * cssScaleY,
    }, facingDir);
  };

  const emitHeadPosition = () => {
    emitHeadPositionFor("local", headSprite, lastFacing);
  };

  const syncPlayers = (states: PlayerState[]) => {
    const seen = new Set<string>();

    for (const state of states) {
      const managed = getOrCreateRemote(state);
      updateRemotePlayer(managed, state);
      seen.add(state.npub);
    }

    for (const [npub, managed] of remotePlayers) {
      if (!seen.has(npub)) {
        hooks.onHeadPosition?.(npub, null, managed.lastFacing ?? 1);
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

  let avatarAssetUrl: string | undefined;
  let avatarRequestId = 0;

  const applyHeadTexture = (texture: Texture) => {
    headSprite.texture = texture;
    headSprite.width = playerWidth;
    headSprite.height = map.tileHeight;
  };

  const setAvatar = (url?: string | null) => {
    avatarRequestId += 1;
    const requestId = avatarRequestId;

    const load = async () => {
      if (!url) {
        applyHeadTexture(WHITE_TEXTURE);
        return;
      }

      try {
        if (avatarAssetUrl && avatarAssetUrl !== url) {
          void Assets.unload(avatarAssetUrl).catch(() => {
            /* ignore unload failures */
          });
        }

        avatarAssetUrl = url;
        const texture = await Assets.load<Texture>(url);
        if (requestId !== avatarRequestId) {
          return;
        }
        applyHeadTexture(texture);
      } catch (error) {
        console.warn("Failed to load avatar texture", error);
        if (requestId === avatarRequestId) {
          applyHeadTexture(WHITE_TEXTURE);
        }
      }
    };

    void load();
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
    if (avatarAssetUrl) {
      void Assets.unload(avatarAssetUrl);
      avatarAssetUrl = undefined;
    }
    pressed.clear();
    for (const [, managed] of remotePlayers) {
      managed.container.destroy({ children: true });
    }
    remotePlayers.clear();
    hooks.onHeadPosition?.("local", null, lastFacing);
  };

  const setInputCaptured = (captured: boolean) => {
    if (inputCaptured === captured) {
      return;
    }

    inputCaptured = captured;
    if (captured) {
      pressed.clear();
    }
  };

  const spawn = () => {
    player.x = spawnX;
    player.y = spawnY;
    clampToMap();
    updateFootBounds();
    updateRooms();
    reportPosition();
    emitHeadPosition();
  };

  return {
    destroy,
    setInputCaptured,
    spawn,
    setAvatar,
    syncPlayers,
  };
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
