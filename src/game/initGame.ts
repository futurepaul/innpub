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
} from "pixi.js";
import { XMLParser } from "fast-xml-parser";

export type GameHooks = {
  onPlayerPosition?: (position: { x: number; y: number }) => void;
  onConsoleMessage?: (message: string) => void;
  onHeadPosition?: (rect: { x: number; y: number; width: number; height: number } | null) => void;
};

export type GameInstance = {
  destroy: () => void;
  setInputCaptured: (captured: boolean) => void;
  spawn: () => void;
  setAvatar: (url?: string | null) => void;
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

  const collisionRects = map.collisions
    .filter(collision => collision.width > 0 && collision.height > 0)
    .map(collision => new Rectangle(collision.x, collision.y, collision.width, collision.height));

  const playerWidth = map.tileWidth;
  const playerHeight = map.tileHeight * 2;

  const player = new Container();
  player.eventMode = "none";
  player.label = "player";

  const headSprite = new Sprite(WHITE_TEXTURE);
  headSprite.width = playerWidth;
  headSprite.height = map.tileHeight;
  headSprite.roundPixels = true;
  headSprite.tint = 0xffffff;

  const bodySprite = new Sprite(WHITE_TEXTURE);
  bodySprite.width = playerWidth;
  bodySprite.height = map.tileHeight;
  bodySprite.y = map.tileHeight;
  bodySprite.roundPixels = true;
  bodySprite.tint = 0x6ee7b7;

  player.addChild(headSprite, bodySprite);

  const spawnX = Math.round(mapPixelWidth / 2 - playerWidth * 1.5);
  const spawnY = Math.round(mapPixelHeight / 2 - playerHeight);
  player.x = spawnX;
  player.y = spawnY;
  scene.addChild(player);

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
    hooks.onPlayerPosition?.({ x: player.x, y: player.y });
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

  const emitHeadPosition = () => {
    if (!hooks.onHeadPosition || !app.renderer) {
      return;
    }

    const bounds = headSprite.getBounds();
    const canvas = app.renderer.canvas as HTMLCanvasElement;
    const cssWidth = canvas.clientWidth || app.renderer.width;
    const cssHeight = canvas.clientHeight || app.renderer.height;

    const scaleX = cssWidth / app.renderer.width;
    const scaleY = cssHeight / app.renderer.height;

    hooks.onHeadPosition({
      x: bounds.x * scaleX,
      y: bounds.y * scaleY,
      width: bounds.width * scaleX,
      height: bounds.height * scaleY,
    });
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
    if (avatarAssetUrl) {
      void Assets.unload(avatarAssetUrl);
      avatarAssetUrl = undefined;
    }
    pressed.clear();
    hooks.onHeadPosition?.(null);
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
